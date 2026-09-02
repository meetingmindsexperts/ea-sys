import { NextResponse } from "next/server";
import { z } from "zod";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { eventMatchesRequestTenant } from "@/lib/public-event";
import { rateLimited } from "@/lib/api-errors";
import { checkRateLimit, getClientIp, hashVerificationToken } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { resolveTenantOrg, normalizeHost } from "@/lib/tenant/resolver";
import { titleEnum, attendeeRoleEnum } from "@/lib/schemas";
import { syncToContact } from "@/lib/contact-sync";
import { sendRegistrationConfirmation } from "@/lib/email";
import { refreshEventStats } from "@/lib/event-stats";
import { ensureRegistrantAccount } from "@/lib/registrant-account";
import { buildEventConfirmationFields } from "@/lib/registration-confirmation";
import { pickCurrentPricingTier } from "@/lib/current-pricing-tier";
import {
  readIdentityEvidencePolicy,
  missingIdentityEvidence,
  IDENTITY_EVIDENCE_SELECT,
} from "@/lib/identity-evidence";

interface RouteParams {
  params: Promise<{ slug: string }>;
}

/** Thrown inside the completion transaction when the chosen registration type
 *  sold out between rendering the form and submitting it. Rolls the whole
 *  transaction back so the token survives and the person can pick again. */
class SoldOutError extends Error {
  constructor() {
    super("SOLD_OUT");
    this.name = "SoldOutError";
  }
}

/** Thrown when the registration gained a type between this POST's pre-check
 *  and the write — an organizer assigned one concurrently (bulk Change Type /
 *  detail sheet). Without the conditional claim this POST would silently
 *  overwrite the organizer's choice AND leak the seat the organizer's path
 *  claimed. Rolls back (token survives); on reload the GET shows the type is
 *  already set, so the picker disappears and completion proceeds normally. */
class TypeAlreadySetError extends Error {
  constructor() {
    super("TYPE_ALREADY_SET");
    this.name = "TypeAlreadySetError";
  }
}

/** A registration type the completer may choose, priced at today's open tier. */
interface SelectableTicketType {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  /** Tier the price came from, e.g. "Early Bird". Null = the type's base price. */
  tierName: string | null;
  /** False when the type is sold out — rendered disabled. */
  available: boolean;
}

/** Prisma select for a type + the tier fields `pickCurrentPricingTier` needs. */
const SELECTABLE_TICKET_TYPE_SELECT = {
  ...IDENTITY_EVIDENCE_SELECT,
  id: true,
  name: true,
  description: true,
  price: true,
  currency: true,
  quantity: true,
  soldCount: true,
  requiresApproval: true,
  pricingTiers: {
    select: {
      id: true, name: true, price: true, currency: true, quantity: true,
      soldCount: true, isActive: true, salesStart: true, salesEnd: true, sortOrder: true,
    },
  },
} as const;

/**
 * The event's publicly choosable registration types, priced at whichever tier
 * is on sale now. Mirrors the public event route's filter — active only, and
 * never the internal Faculty type (it backs speaker companions).
 */
async function loadSelectableTicketTypes(eventId: string): Promise<SelectableTicketType[]> {
  const types = await db.ticketType.findMany({
    where: { eventId, isActive: true, isFaculty: false },
    select: SELECTABLE_TICKET_TYPE_SELECT,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  const now = new Date();
  return types.map((tt) => {
    const tier = pickCurrentPricingTier(tt.pricingTiers, now);
    return {
      id: tt.id,
      name: tt.name,
      description: tt.description,
      price: Number(tier?.price ?? tt.price),
      currency: tier?.currency ?? tt.currency,
      tierName: tier?.name ?? null,
      available: tt.soldCount < tt.quantity,
      // The form renders its evidence fields from these, and the POST enforces
      // the same switches — one rule, both ends.
      requiresMemberId: tt.requiresMemberId,
      requiresStudentId: tt.requiresStudentId,
      requiresStudentIdExpiry: tt.requiresStudentIdExpiry,
    };
  });
}

// ── GET: Validate token and return prefilled registration data ──────────────

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { slug } = await params;
    const { searchParams } = new URL(req.url);
    const rawToken = searchParams.get("token");

    if (!rawToken) {
      return NextResponse.json({ error: "Token is required" }, { status: 400 });
    }

    const ipLimit = checkRateLimit({
      key: `complete-reg-get:ip:${getClientIp(req)}`,
      limit: 20,
      windowMs: 15 * 60 * 1000,
    });
    if (!ipLimit.allowed) {
      return rateLimited(ipLimit, { route: "public/complete-registration", message: "Too many requests" });
    }

    const hashedToken = hashVerificationToken(rawToken);
    const tokenRecord = await db.verificationToken.findUnique({
      where: { token: hashedToken },
    });

    if (!tokenRecord) {
      apiLogger.info({ msg: "Completion token not found (invalid or already used)", ip: getClientIp(req) });
      return NextResponse.json({ error: "This link is invalid or has already been used. Please contact the event organizer for a new link." }, { status: 400 });
    }

    if (tokenRecord.expires < new Date()) {
      await db.verificationToken.delete({ where: { token: hashedToken } });
      apiLogger.info({ msg: "Expired completion token accessed", identifier: tokenRecord.identifier, ip: getClientIp(req) });
      return NextResponse.json({ error: "This link has expired. Please contact the event organizer for a new link." }, { status: 400 });
    }

    // Extract registrationId from identifier
    if (!tokenRecord.identifier.startsWith("reg:")) {
      apiLogger.warn({ msg: "Token with wrong identifier prefix used on completion endpoint", identifier: tokenRecord.identifier });
      return NextResponse.json({ error: "This link is not a registration completion link." }, { status: 400 });
    }
    const registrationId = tokenRecord.identifier.slice(4);

    // Tenancy sweep: open the tenant store BEFORE the swept Registration read
    // (resolved from HOST — this route reads no un-swept Event first, the
    // registration is resolved by token→id). Passthrough on master.
    const tenant = await resolveTenantOrg(normalizeHost(req.headers.get("host")));
    return await runWithTenant(tenant.orgId ?? "", async () => {
    // Load registration + attendee + event
    const registration = await db.registration.findFirst({
      where: { id: registrationId, status: { notIn: ["CANCELLED"] } },
      select: {
        id: true,
        status: true,
        userId: true,
        ticketTypeId: true,
        ticketType: { select: { id: true, name: true, ...IDENTITY_EVIDENCE_SELECT } },
        attendee: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
            title: true,
            role: true,
            organization: true,
            jobTitle: true,
            phone: true,
            city: true,
            state: true,
            zipCode: true,
            country: true,
            specialty: true,
            customSpecialty: true,
            dietaryReqs: true,
            associationName: true,
            memberId: true,
            studentId: true,
            studentIdExpiry: true,
          },
        },
        event: {
          select: {
            id: true,
            name: true,
            slug: true,
            organizationId: true,
            startDate: true,
            endDate: true,
            venue: true,
            city: true,
            country: true,
            bannerImage: true,
            bannerImageMobile: true,
            registrationTermsHtml: true,
            supportEmail: true,
            taxRate: true,
            taxLabel: true,
            bankDetails: true,
            organization: {
              select: {
                name: true,
                logo: true,
                companyName: true,
                companyAddress: true,
                companyCity: true,
                companyState: true,
                companyZipCode: true,
                companyCountry: true,
                taxId: true,
              },
            },
          },
        },
      },
    });

    if (!registration) {
      return NextResponse.json({ error: "Registration not found or has been cancelled" }, { status: 404 });
    }

    // Verify event slug matches URL for defense in depth
    if (registration.event.slug !== slug) {
      apiLogger.warn({ msg: "Completion token used on wrong event URL", tokenSlug: registration.event.slug, urlSlug: slug, registrationId });
      return NextResponse.json({ error: "This link does not match the event. Please use the original link from your email." }, { status: 400 });
    }
    if (!(await eventMatchesRequestTenant(req, registration.event.organizationId))) {
      apiLogger.warn({ msg: "Completion token used on wrong tenant domain", urlSlug: slug, registrationId });
      return NextResponse.json({ error: "This link does not match the event. Please use the original link from your email." }, { status: 400 });
    }

    // Check if already completed (user account linked)
    if (registration.userId) {
      apiLogger.info({ msg: "Already-completed registration accessed via token", registrationId, email: registration.attendee.email });
      return NextResponse.json({ alreadyCompleted: true, event: registration.event });
    }

    // No registration type yet (imported from a file without one): offer the
    // event's public types so the registrant states theirs here. These prices
    // are for DISPLAY only — the POST re-resolves the type and the open tier
    // server-side, so the client can't dictate what it pays.
    const selectableTicketTypes = registration.ticketTypeId
      ? []
      : await loadSelectableTicketTypes(registration.event.id);

    return NextResponse.json({
      alreadyCompleted: false,
      registration: { id: registration.id, status: registration.status, ticketTypeId: registration.ticketTypeId },
      attendee: registration.attendee,
      event: registration.event,
      ticketType: registration.ticketType,
      selectableTicketTypes,
    });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Unhandled error validating completion token" });
    return NextResponse.json({ error: "An unexpected error occurred while loading your registration. Please try again." }, { status: 500 });
  }
}

// ── POST: Submit completed registration ─────────────────────────────────────

const completionSchema = z.object({
  token: z.string().min(1),
  title: titleEnum,
  role: attendeeRoleEnum,
  jobTitle: z.string().min(1, "Position is required").max(255),
  organization: z.string().min(1, "Organization is required").max(255),
  phone: z.string().min(1, "Mobile number is required").max(50),
  city: z.string().min(1, "City is required").max(255),
  state: z.string().max(255).optional(),
  zipCode: z.string().max(20).optional(),
  country: z.string().min(1, "Country is required").max(255),
  specialty: z.string().min(1, "Specialty is required").max(255),
  customSpecialty: z.string().max(255).optional(),
  dietaryReqs: z.string().max(2000).optional(),
  associationName: z.string().max(255).optional(),
  memberId: z.string().max(100).optional(),
  studentId: z.string().max(100).optional(),
  studentIdExpiry: z.string().max(20).optional(),
  /** Required only when the registration has no type yet. The pricing TIER is
   *  deliberately not accepted from the client — it's re-resolved server-side
   *  so a crafted request can't claim a closed Early-Bird rate. */
  ticketTypeId: z.string().min(1).optional(),
  password: z.string().min(6).max(128).optional(),
  confirmPassword: z.string().optional(),
  agreeTerms: z.literal(true, { message: "You must agree to the terms and conditions" }),
}).refine((data) => !data.password || data.password === data.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
}).refine(
  (data) => data.specialty !== "Others" || (data.customSpecialty?.trim().length ?? 0) > 0,
  {
    message: "Please specify your specialty",
    path: ["customSpecialty"],
  },
);

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { slug } = await params;

    const ipLimit = checkRateLimit({
      key: `complete-reg-post:ip:${getClientIp(req)}`,
      limit: 5,
      windowMs: 15 * 60 * 1000,
    });
    if (!ipLimit.allowed) {
      return rateLimited(ipLimit, { route: "public/complete-registration", message: "Too many requests. Please try again later." });
    }

    const body = await req.json();
    const validated = completionSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ msg: "Completion form validation failed", errors: validated.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: validated.error.flatten() }, { status: 400 });
    }

    const { token: rawToken, title, role, jobTitle, organization, phone, city, state, zipCode, country, specialty, customSpecialty, dietaryReqs, associationName, memberId, studentId, studentIdExpiry, password, ticketTypeId: chosenTicketTypeId } = validated.data;

    // Validate studentIdExpiry date format if provided
    if (studentIdExpiry && isNaN(new Date(studentIdExpiry).getTime())) {
      apiLogger.warn({ msg: "Invalid studentIdExpiry in completion form", studentIdExpiry });
      return NextResponse.json({ error: "Invalid student ID expiry date" }, { status: 400 });
    }

    // Validate token
    const hashedToken = hashVerificationToken(rawToken);
    const tokenRecord = await db.verificationToken.findUnique({
      where: { token: hashedToken },
    });

    if (!tokenRecord) {
      apiLogger.info({ msg: "Completion POST with invalid/used token", ip: getClientIp(req) });
      return NextResponse.json({ error: "This link is invalid or has already been used. Please contact the event organizer for a new link." }, { status: 400 });
    }

    if (tokenRecord.expires < new Date()) {
      await db.verificationToken.delete({ where: { token: hashedToken } });
      apiLogger.info({ msg: "Completion POST with expired token", identifier: tokenRecord.identifier, ip: getClientIp(req) });
      return NextResponse.json({ error: "This link has expired. Please contact the event organizer for a new link." }, { status: 400 });
    }

    if (!tokenRecord.identifier.startsWith("reg:")) {
      apiLogger.warn({ msg: "Wrong token type used on completion POST", identifier: tokenRecord.identifier });
      return NextResponse.json({ error: "This link is not a registration completion link." }, { status: 400 });
    }
    const registrationId = tokenRecord.identifier.slice(4);

    // Tenancy sweep: open the tenant store BEFORE the swept Registration read
    // (resolved from HOST — the registration is resolved by token→id, no
    // un-swept Event is read first). Passthrough on master.
    const tenant = await resolveTenantOrg(normalizeHost(req.headers.get("host")));
    return await runWithTenant(tenant.orgId ?? "", async () => {
    // Load registration with only needed fields
    const registration = await db.registration.findFirst({
      where: { id: registrationId, status: { notIn: ["CANCELLED"] } },
      select: {
        id: true,
        serialId: true,
        status: true,
        userId: true,
        attendeeId: true,
        taxNumber: true,
        billingFirstName: true,
        billingLastName: true,
        billingEmail: true,
        billingPhone: true,
        billingAddress: true,
        billingCity: true,
        billingState: true,
        billingZipCode: true,
        billingCountry: true,
        attendee: {
          select: {
            email: true, additionalEmail: true, firstName: true, lastName: true, title: true,
            organization: true, jobTitle: true, phone: true, city: true, country: true,
            specialty: true, registrationType: true,
            associationName: true, memberId: true, studentId: true, studentIdExpiry: true,
          },
        },
        event: {
          select: {
            id: true, name: true, slug: true, startDate: true, endDate: true, timezone: true,
            venue: true, city: true, country: true, organizationId: true,
            taxRate: true, taxLabel: true,
            bankDetails: true, supportEmail: true,
            organization: {
              select: {
                name: true, logo: true,
                companyName: true, companyAddress: true, companyCity: true,
                companyState: true, companyZipCode: true, companyCountry: true,
                taxId: true,
              },
            },
          },
        },
        ticketTypeId: true,
        // Needed by the type-set below: a status someone EXPLICITLY set
        // (CSV paymentStatus column / admin detail sheet — PAID, INCLUSIVE, …)
        // must survive completion; only the typeless default is recomputed.
        paymentStatus: true,
        ticketType: { select: { id: true, name: true, price: true, currency: true, ...IDENTITY_EVIDENCE_SELECT } },
        pricingTier: { select: { id: true, name: true, price: true, currency: true } },
      },
    });

    if (!registration) {
      apiLogger.warn({ msg: "Completion POST for missing/cancelled registration", registrationId });
      return NextResponse.json({ error: "Registration not found or has been cancelled. Please contact the event organizer." }, { status: 404 });
    }

    if (registration.event.slug !== slug) {
      apiLogger.warn({ msg: "Completion POST token used on wrong event URL", tokenSlug: registration.event.slug, urlSlug: slug, registrationId });
      return NextResponse.json({ error: "This link does not match the event. Please use the original link from your email." }, { status: 400 });
    }
    if (!(await eventMatchesRequestTenant(req, registration.event.organizationId))) {
      apiLogger.warn({ msg: "Completion POST token used on wrong tenant domain", urlSlug: slug, registrationId });
      return NextResponse.json({ error: "This link does not match the event. Please use the original link from your email." }, { status: 400 });
    }

    if (registration.userId) {
      apiLogger.info({ msg: "Completion POST on already-completed registration", registrationId, email: registration.attendee.email });
      return NextResponse.json({ error: "This registration has already been completed. You can sign in to manage your registration." }, { status: 409 });
    }

    // ── Registration type ────────────────────────────────────────────────
    // A registration imported without a type states it HERE. The price is
    // resolved entirely server-side (chosen type + whichever tier is on sale
    // now), so the client can pick neither a hidden type nor a cheaper closed
    // tier.
    let resolvedType:
      | { id: string; name: string; price: unknown; currency: string; quantity: number; requiresApproval: boolean }
      | null = null;
    let resolvedTier: { id: string; name: string; price: unknown; currency: string } | null = null;
    /** The just-self-selected type, kept in scope for the evidence check below. */
    let evidenceCandidate: {
      id: string;
      requiresMemberId: boolean;
      requiresStudentId: boolean;
      requiresStudentIdExpiry: boolean;
    } | null = null;

    if (!registration.ticketTypeId) {
      if (!chosenTicketTypeId) {
        apiLogger.warn({ msg: "Completion POST without a registration type", registrationId });
        return NextResponse.json(
          { error: "Please choose a registration type.", code: "REGISTRATION_TYPE_REQUIRED" },
          { status: 400 }
        );
      }
      const chosen = await db.ticketType.findFirst({
        // Bound to THIS event, publicly selectable, never the internal Faculty
        // type — the same gate the public register route applies.
        where: { id: chosenTicketTypeId, eventId: registration.event.id, isActive: true, isFaculty: false },
        select: SELECTABLE_TICKET_TYPE_SELECT,
      });
      if (!chosen) {
        apiLogger.warn({ msg: "Completion POST with an invalid registration type", registrationId, chosenTicketTypeId });
        return NextResponse.json(
          { error: "That registration type is not available. Please pick another.", code: "INVALID_REGISTRATION_TYPE" },
          { status: 400 }
        );
      }
      evidenceCandidate = chosen;
      const tier = pickCurrentPricingTier(chosen.pricingTiers, new Date());
      resolvedType = { id: chosen.id, name: chosen.name, price: chosen.price, currency: chosen.currency, quantity: chosen.quantity, requiresApproval: chosen.requiresApproval };
      resolvedTier = tier ? { id: tier.id, name: tier.name, price: tier.price, currency: tier.currency } : null;
    }
    // Identity evidence, enforced SERVER-side. Until now the completion form
    // required these fields in the browser and this route only checked that a
    // supplied expiry parsed — so the requirement was one crafted request away
    // from being skipped entirely. The policy comes from whichever type
    // applies: the one already on the row, or the one just self-selected.
    const evidenceTicketType = registration.ticketTypeId
      ? registration.ticketType
      : evidenceCandidate;
    const evidencePolicy = readIdentityEvidencePolicy(evidenceTicketType);
    const missingEvidence = missingIdentityEvidence(evidencePolicy, {
      memberId,
      studentId,
      studentIdExpiry,
    });
    if (missingEvidence.length > 0) {
      apiLogger.warn({
        msg: "complete-registration:identity-evidence-missing",
        registrationId,
        ticketTypeId: evidenceTicketType?.id ?? null,
        missing: missingEvidence,
      });
      return NextResponse.json(
        {
          error: `${missingEvidence.join(" and ")} ${missingEvidence.length > 1 ? "are" : "is"} required for this registration type`,
          code: "IDENTITY_EVIDENCE_REQUIRED",
          missing: missingEvidence,
        },
        { status: 400 },
      );
    }

    const resolvedPrice = resolvedType ? Number(resolvedTier?.price ?? resolvedType.price) : null;
    // Self-selecting a type that requires approval puts the row into the
    // organizer's approval queue — public-register semantics, because at
    // completion the PERSON picks the type (the organizer vetted the person at
    // import, not this choice; e.g. a "Student" type needing ID verification).
    // Only the import default CONFIRMED flips; an explicitly imported
    // registrationStatus (CHECKED_IN, PENDING, …) is left alone, like M1's
    // paymentStatus rule.
    const flipToPending =
      !!resolvedType && resolvedType.requiresApproval && registration.status === "CONFIRMED";

    // Update attendee + delete token in transaction
    try {
    await tenantTransaction(async (tx) => {
      if (resolvedType) {
        // Claim the seat on the TICKET-TYPE counter: `seatCounter()` routes a
        // non-PUBLIC_REGISTER row (this one is CSV_IMPORT) there even when a
        // tier applies. The `soldCount < quantity` predicate ON the update is
        // the guard, so a concurrent completion can't oversell the last seat.
        const claimed = await tx.ticketType.updateMany({
          where: { id: resolvedType.id, soldCount: { lt: resolvedType.quantity } },
          data: { soldCount: { increment: 1 } },
        });
        if (claimed.count === 0) throw new SoldOutError();

        // Conditional claim on the registration ROW (`ticketTypeId: null` in
        // the where): the pre-tx "has no type" check is a stale read, so an
        // organizer assigning a type concurrently would otherwise be silently
        // overwritten — and the seat THEIR path claimed would leak. Losing the
        // race throws; the whole tx (incl. the seat increment above) rolls back.
        const rowClaim = await tx.registration.updateMany({
          where: { id: registrationId, ticketTypeId: null },
          data: {
            ticketTypeId: resolvedType.id,
            pricingTierId: resolvedTier?.id ?? null,
            // Stamp the price so every money surface reads the rate agreed at
            // completion, not whatever the tier happens to be later.
            originalPrice: resolvedPrice ?? 0,
            // While typeless the row defaulted to COMPLIMENTARY (nothing to
            // owe) — a priced type makes money due, so that default flips to
            // payable + chaseable. But a status someone EXPLICITLY set (CSV
            // paymentStatus column, admin detail sheet — PAID for an offline
            // bank transfer, INCLUSIVE for sponsor-paid) must survive, or
            // completion would re-open dunning on a settled registration.
            // Limitation: an explicitly-set COMPLIMENTARY is indistinguishable
            // from the typeless default and flips too — an organizer comping
            // someone would normally set the type alongside.
            ...(registration.paymentStatus === "COMPLIMENTARY" && {
              paymentStatus: (resolvedPrice ?? 0) > 0 ? "UNASSIGNED" : "COMPLIMENTARY",
            }),
            // requiresApproval type self-selected here → approval queue (see
            // flipToPending above for the rule + why only CONFIRMED flips).
            ...(flipToPending && { status: "PENDING" as const }),
          },
        });
        if (rowClaim.count === 0) throw new TypeAlreadySetError();
      }
      await tx.attendee.update({
        where: { id: registration.attendeeId },
        data: {
          title: title || null,
          role,
          jobTitle,
          organization,
          phone,
          city,
          ...(state !== undefined && { state: state || null }),
          ...(zipCode !== undefined && { zipCode: zipCode || null }),
          country,
          specialty,
          customSpecialty: customSpecialty || null,
          ...(dietaryReqs !== undefined && { dietaryReqs: dietaryReqs || null }),
          ...(associationName !== undefined && { associationName: associationName || null }),
          ...(memberId !== undefined && { memberId: memberId || null }),
          ...(studentId !== undefined && { studentId: studentId || null }),
          ...(studentIdExpiry !== undefined && { studentIdExpiry: studentIdExpiry ? new Date(studentIdExpiry) : null }),
          // Mirror the chosen type onto the attendee's free-text category
          // (`ticketTypeId` stays the source of truth) so the list, the CSV
          // export and the contact store agree with the registration.
          ...(resolvedType && { registrationType: resolvedType.name }),
        },
      });

      // Delete token (one-time use)
      await tx.verificationToken.delete({ where: { token: hashedToken } });

      // Audit log
      await tx.auditLog.create({
        data: {
          eventId: registration.event.id,
          action: "COMPLETE_REGISTRATION",
          entityType: "Registration",
          entityId: registrationId,
          changes: {
            email: registration.attendee.email,
            ip: getClientIp(req),
            ...(resolvedType && {
              ticketTypeId: resolvedType.id,
              ticketTypeName: resolvedType.name,
              pricingTierName: resolvedTier?.name ?? null,
              price: resolvedPrice,
              // Explicit (non-default) statuses survive the type-set — record
              // which one did, so "why is this paid registration UNASSIGNED /
              // still PAID?" is answerable from the audit trail.
              ...(registration.paymentStatus !== "COMPLIMENTARY" && {
                paymentStatusPreserved: registration.paymentStatus,
              }),
              // The self-selected type needs organizer approval → the row
              // entered the approval queue on completion.
              ...(flipToPending && { statusFlippedToPending: true }),
            }),
          },
        },
      });
    });
    } catch (txError) {
      if (txError instanceof SoldOutError) {
        // Nothing committed — the token survives, so they can choose again.
        apiLogger.warn({
          msg: "Completion POST hit a sold-out registration type",
          registrationId,
          ticketTypeId: resolvedType?.id,
        });
        return NextResponse.json(
          { error: "That registration type just sold out. Please choose another.", code: "REGISTRATION_TYPE_SOLD_OUT" },
          { status: 409 }
        );
      }
      if (txError instanceof TypeAlreadySetError) {
        // The organizer assigned a type while this form was open. Nothing
        // committed (the seat increment rolled back too); on reload the GET
        // shows the assigned type and the picker disappears.
        apiLogger.warn({
          msg: "Completion POST lost the type-set race to a concurrent assignment",
          registrationId,
          chosenTicketTypeId: resolvedType?.id,
        });
        return NextResponse.json(
          {
            error: "Your registration type was just set by the event organizer. Please reload the page and complete your details.",
            code: "REGISTRATION_TYPE_ALREADY_SET",
          },
          { status: 409 }
        );
      }
      throw txError;
    }

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(registration.event.id);

    // Account creation (outside transaction — failure should not block completion)
    const email = registration.attendee.email;
    const firstName = registration.attendee.firstName;
    const lastName = registration.attendee.lastName;

    await ensureRegistrantAccount({
      registrationId,
      eventId: registration.event.id,
      organizationId: registration.event.organizationId,
      email,
      firstName,
      lastName,
      password,
      specialty,
      clientIp: getClientIp(req),
      signupMessage: `${firstName} ${lastName} (${email}) completed registration and created an account`,
    });

    // Sync to contact store
    await syncToContact({
      organizationId: registration.event.organizationId,
      eventId: registration.event.id,
      email,
      firstName,
      lastName,
      title: title || null,
      role: role || null,
      organization,
      jobTitle,
      phone,
      city,
      state: state || null,
      zipCode: zipCode || null,
      country,
      specialty,
      customSpecialty: customSpecialty || null,
      registrationType: resolvedType?.name ?? registration.attendee.registrationType,
      associationName: associationName || registration.attendee.associationName,
      memberId: memberId || registration.attendee.memberId,
      studentId: studentId || registration.attendee.studentId,
      studentIdExpiry: studentIdExpiry ? new Date(studentIdExpiry) : registration.attendee.studentIdExpiry,
    });

    // Send confirmation email
    try {
      // Prefer the type/tier just resolved on this request — the loaded
      // `registration` predates it and would price a freshly-typed
      // registration at 0.
      const finalPrice = resolvedType
        ? (resolvedPrice ?? 0)
        : registration.pricingTier ? Number(registration.pricingTier.price) : Number(registration.ticketType?.price ?? 0);
      const finalCurrency = resolvedType
        ? (resolvedTier?.currency ?? resolvedType.currency)
        : registration.pricingTier ? registration.pricingTier.currency : registration.ticketType?.currency ?? "USD";

      await sendRegistrationConfirmation({
        ...buildEventConfirmationFields(registration.event),
        to: email,
        additionalEmail: registration.attendee.additionalEmail,
        firstName,
        lastName,
        title: title || null,
        organization,
        ticketType: resolvedType?.name ?? registration.ticketType?.name ?? "General",
        pricingTierName: resolvedTier?.name ?? registration.pricingTier?.name ?? null,
        registrationId,
        serialId: registration.serialId,
        qrCode: "",
        eventSlug: registration.event.slug,
        ticketPrice: finalPrice,
        ticketCurrency: finalCurrency,
        jobTitle,
        billingFirstName: registration.billingFirstName,
        billingLastName: registration.billingLastName,
        billingEmail: registration.billingEmail,
        billingPhone: registration.billingPhone,
        billingAddress: registration.billingAddress,
        billingCity: registration.billingCity || city,
        billingState: registration.billingState,
        billingZipCode: registration.billingZipCode,
        billingCountry: registration.billingCountry || country,
        taxNumber: registration.taxNumber,
      });
    } catch (emailError) {
      apiLogger.error({ err: emailError, msg: "Failed to send confirmation email after registration completion" });
    }

    apiLogger.info({ msg: "Registration completed via token", registrationId, email });

    return NextResponse.json({
      success: true,
      registration: {
        id: registrationId,
        // Reflect the approval flip made on THIS request (the loaded row
        // predates it) so the caller doesn't render a stale CONFIRMED.
        status: flipToPending ? "PENDING" : registration.status,
        // Drives the Pay Now step on the confirmation page — must reflect the
        // type resolved on THIS request, else a paid completion looks free.
        ticketPrice: resolvedType
          ? (resolvedPrice ?? 0)
          : registration.pricingTier ? Number(registration.pricingTier.price) : Number(registration.ticketType?.price ?? 0),
        ticketCurrency: resolvedType
          ? (resolvedTier?.currency ?? resolvedType.currency)
          : registration.pricingTier ? registration.pricingTier.currency : registration.ticketType?.currency ?? "USD",
      },
    });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Unhandled error in registration completion POST" });
    return NextResponse.json({ error: "An unexpected error occurred while completing your registration. Please try again or contact the event organizer." }, { status: 500 });
  }
}
