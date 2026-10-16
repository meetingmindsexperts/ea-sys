import { NextResponse } from "next/server";
import { z } from "zod";
import type { PaymentStatus } from "@prisma/client";
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
import { pickOpenPublicRate } from "@/lib/current-pricing-tier";
import { readCodeRequiredTiers, tierNeedsSponsorCode } from "@/lib/code-required-tiers";
import { parseRegistrationFormIdentifier, type RegistrationFormRate } from "@/lib/registration-form-link";
import { linkMayReprice, priceAtLinkRate, RESTAMPABLE_STATUSES, stampedPaymentStatus, type LinkRepriceState } from "@/lib/registration-form-pricing";
import { applyRegistrationTransition } from "@/lib/registration-seat-db";
import { registerTierSlug } from "@/lib/main-register-tiers";
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

/** Prisma select for a type + the tier fields `pickOpenPublicRate` needs. */
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
async function loadSelectableTicketTypes(eventId: string, sponsorLinkSlugs: string[]): Promise<SelectableTicketType[]> {
  const types = await db.ticketType.findMany({
    where: { eventId, isActive: true, isFaculty: false },
    select: SELECTABLE_TICKET_TYPE_SELECT,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  const now = new Date();
  return types.map((tt) => {
    // Never a sponsor-link or presenter rate, never the type's own price when
    // it has rates (pickOpenPublicRate): a type with no open rate is shown as
    // unavailable rather than at 0.
    const { tier, noRateOnSale } = pickOpenPublicRate(tt.pricingTiers, sponsorLinkSlugs, now);
    return {
      id: tt.id,
      name: tt.name,
      description: tt.description,
      price: Number(tier?.price ?? tt.price),
      currency: tier?.currency ?? tt.currency,
      tierName: tier?.name ?? null,
      available: tt.soldCount < tt.quantity && !noRateOnSale,
      // The form renders its evidence fields from these, and the POST enforces
      // the same switches — one rule, both ends.
      requiresMemberId: tt.requiresMemberId,
      requiresStudentId: tt.requiresStudentId,
      requiresStudentIdExpiry: tt.requiresStudentIdExpiry,
    };
  });
}

/** What `effectiveLinkRate` reads from the registration. */
const LINK_REPRICE_SELECT = {
  paymentStatus: true,
  refundedAmount: true,
  promoCodeId: true,
  groupId: true,
  pricingTierId: true,
  sponsorId: true,
  _count: { select: { payments: true, invoices: { where: { status: { not: "CANCELLED" as const } } } } },
} as const;

/**
 * The link's rate, when it may still set this registration's type and price
 * (linkMayReprice); null otherwise, and the link then completes the person's
 * details only, exactly like a link without a rate. Anything staff changed
 * after the send (a payment, an invoice, a comp, a sponsor) wins.
 */
async function effectiveLinkRate(
  reg: LinkRepriceState & { id: string; sponsorId: string | null },
  rate: RegistrationFormRate | null,
  settings: unknown,
): Promise<RegistrationFormRate | null> {
  if (!rate) return null;
  const tiers = reg.ticketTypeId
    ? await db.pricingTier.findMany({ where: { ticketTypeId: reg.ticketTypeId }, select: { id: true, name: true, price: true } })
    : [];
  const sponsorRate =
    rate.kind === "rate" && tierNeedsSponsorCode(rate.slug, readCodeRequiredTiers(settings)) && !!reg.sponsorId;
  if (linkMayReprice(reg, rate, tiers, sponsorRate)) return rate;
  apiLogger.info({
    msg: "complete-registration:link-rate-not-applied",
    registrationId: reg.id,
    paymentStatus: reg.paymentStatus,
    reason: "registration changed since the link was sent",
  });
  return null;
}

/**
 * For a link that carries a rate (docs/REGISTRATION_FORM_LINKS_PLAN.md): the
 * types the person may choose are those with that rate on sale, all priced at
 * it (owner D5: they may change type, at the same rate). Their current type
 * stays available even when full, since they already hold its seat. `closed`
 * is true when the rate is on sale on no type (owner D3: refused, not swapped).
 */
async function loadRatedTicketTypes(
  eventId: string,
  rate: RegistrationFormRate,
  currentTicketTypeId: string | null,
): Promise<{ types: SelectableTicketType[]; rateName: string; closed: boolean }> {
  const types = await db.ticketType.findMany({
    where: { eventId, isActive: true, isFaculty: false },
    select: SELECTABLE_TICKET_TYPE_SELECT,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  const now = new Date();
  const named = rate.kind === "rate"
    ? types.flatMap((tt) => tt.pricingTiers).find((t) => registerTierSlug(t.name) === rate.slug)
    : undefined;
  const rateName = rate.kind === "complimentary" ? "Complimentary" : named?.name ?? rate.slug;
  const selectable = types.flatMap((tt) => {
    const priced = priceAtLinkRate(tt.pricingTiers, rate, now);
    if (!priced.ok) return [];
    return [{
      id: tt.id,
      name: tt.name,
      description: tt.description,
      price: priced.price,
      currency: priced.tier?.currency ?? tt.currency,
      tierName: rateName,
      available: tt.id === currentTicketTypeId || tt.soldCount < tt.quantity,
      requiresMemberId: tt.requiresMemberId,
      requiresStudentId: tt.requiresStudentId,
      requiresStudentIdExpiry: tt.requiresStudentIdExpiry,
    }];
  });
  return { types: selectable, rateName, closed: selectable.length === 0 };
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

    // The registration, and the rate the link carries (null on older links).
    const parsedLink = parseRegistrationFormIdentifier(tokenRecord.identifier);
    if (!parsedLink) {
      apiLogger.warn({ msg: "Token with wrong identifier prefix used on completion endpoint", identifier: tokenRecord.identifier });
      return NextResponse.json({ error: "This link is not a registration completion link." }, { status: 400 });
    }
    const { registrationId, rate: linkRate } = parsedLink;

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
        ...LINK_REPRICE_SELECT,
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
            // Read for the sponsor-link rates only; stripped before responding.
            settings: true,
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

    // The settings JSON is internal: never part of this public response.
    const { settings: eventSettings, ...publicEvent } = registration.event;

    // Check if already completed (user account linked)
    if (registration.userId) {
      apiLogger.info({ msg: "Already-completed registration accessed via token", registrationId, email: registration.attendee.email });
      return NextResponse.json({ alreadyCompleted: true, event: publicEvent });
    }

    // No registration type yet (imported from a file without one): offer the
    // event's public types so the registrant states theirs here. These prices
    // are for DISPLAY only — the POST re-resolves the type and the open tier
    // server-side, so the client can't dictate what it pays.
    // A link with a rate lists the types at that rate, even when a type is
    // already set (the person may change it at the same rate).
    const appliedRate = await effectiveLinkRate(registration, linkRate, eventSettings);
    if (appliedRate) {
      const rated = await loadRatedTicketTypes(registration.event.id, appliedRate, registration.ticketTypeId);
      if (rated.closed) {
        apiLogger.info({ msg: "complete-registration:link-rate-closed", registrationId, rate: rated.rateName });
      }
      return NextResponse.json({
        alreadyCompleted: false,
        registration: { id: registration.id, status: registration.status, ticketTypeId: registration.ticketTypeId },
        attendee: registration.attendee,
        event: publicEvent,
        ticketType: registration.ticketType,
        selectableTicketTypes: rated.types,
        linkRate: { name: rated.rateName, closed: rated.closed },
      });
    }

    const selectableTicketTypes = registration.ticketTypeId
      ? []
      : await loadSelectableTicketTypes(registration.event.id, readCodeRequiredTiers(eventSettings));

    return NextResponse.json({
      alreadyCompleted: false,
      registration: { id: registration.id, status: registration.status, ticketTypeId: registration.ticketTypeId },
      attendee: registration.attendee,
      event: publicEvent,
      ticketType: registration.ticketType,
      selectableTicketTypes,
      linkRate: null,
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

type StoredPricing = {
  pricingTier: { price: unknown; currency: string } | null;
  ticketType: { price: unknown; currency: string } | null;
};

/** The price the loaded registration already carries: its tier, else its type. */
function storedPrice(registration: StoredPricing): number {
  if (registration.pricingTier) return Number(registration.pricingTier.price);
  return Number(registration.ticketType?.price ?? 0);
}

function storedCurrency(registration: StoredPricing): string {
  if (registration.pricingTier) return registration.pricingTier.currency;
  return registration.ticketType?.currency ?? "USD";
}

/** The type and price a completion settled on, for the email and the response. */
function finalPricing(input: {
  ratedPlan: { type: { name: string }; tierName: string; price: number; currency: string } | null;
  resolvedType: { name: string; currency: string } | null;
  resolvedTier: { name: string; currency: string } | null;
  resolvedPrice: number | null;
  registration: StoredPricing & { ticketType: { name: string } | null; pricingTier: { name: string } | null };
}): { price: number; currency: string; typeName: string; tierName: string | null } {
  const { ratedPlan, resolvedType, resolvedTier, resolvedPrice, registration } = input;
  if (ratedPlan) {
    return { price: ratedPlan.price, currency: ratedPlan.currency, typeName: ratedPlan.type.name, tierName: ratedPlan.tierName };
  }
  if (resolvedType) {
    return {
      price: resolvedPrice ?? 0,
      currency: resolvedTier?.currency ?? resolvedType.currency,
      typeName: resolvedType.name,
      tierName: resolvedTier?.name ?? null,
    };
  }
  return {
    price: storedPrice(registration),
    currency: storedCurrency(registration),
    typeName: registration.ticketType?.name ?? "General",
    tierName: registration.pricingTier?.name ?? null,
  };
}

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

    const parsedLink = parseRegistrationFormIdentifier(tokenRecord.identifier);
    if (!parsedLink) {
      apiLogger.warn({ msg: "Wrong token type used on completion POST", identifier: tokenRecord.identifier });
      return NextResponse.json({ error: "This link is not a registration completion link." }, { status: 400 });
    }
    const { registrationId, rate: linkRate } = parsedLink;

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
            taxRate: true, taxLabel: true, settings: true,
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
        // Seat state, and what the link's rate may change (LINK_REPRICE_SELECT
        // includes paymentStatus: a status someone EXPLICITLY set, CSV column
        // or admin sheet, PAID, INCLUSIVE, …, must survive completion).
        attendanceMode: true,
        createdSource: true,
        ...LINK_REPRICE_SELECT,
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

    /** A link with a rate: the type (kept, set or changed) and its price at that rate. */
    let ratedPlan: {
      type: { id: string; name: string; requiresApproval: boolean };
      tierId: string | null;
      tierName: string;
      price: number;
      currency: string;
      paymentStatus: PaymentStatus | null;
    } | null = null;

    const appliedRate = await effectiveLinkRate(registration, linkRate, registration.event.settings);
    if (appliedRate) {
      const targetTypeId = chosenTicketTypeId ?? registration.ticketTypeId;
      if (!targetTypeId) {
        apiLogger.warn({ msg: "Completion POST without a registration type", registrationId });
        return NextResponse.json({ error: "Please choose a registration type.", code: "REGISTRATION_TYPE_REQUIRED" }, { status: 400 });
      }
      const target = await db.ticketType.findFirst({
        where: { id: targetTypeId, eventId: registration.event.id, isActive: true, isFaculty: false },
        select: SELECTABLE_TICKET_TYPE_SELECT,
      });
      if (!target) {
        apiLogger.warn({ msg: "Completion POST with an invalid registration type", registrationId, targetTypeId });
        return NextResponse.json(
          { error: "That registration type is not available. Please pick another.", code: "INVALID_REGISTRATION_TYPE" },
          { status: 400 },
        );
      }
      const priced = priceAtLinkRate(target.pricingTiers, appliedRate, new Date());
      if (!priced.ok) {
        apiLogger.warn({ msg: "complete-registration:link-rate-refused", registrationId, targetTypeId, code: priced.code });
        const message = priced.code === "RATE_CLOSED"
          ? "The rate in your link has closed. Please contact the organising team for a new link."
          : "That registration type is not available at the rate in your link. Please pick another.";
        return NextResponse.json({ error: message, code: priced.code }, { status: 400 });
      }
      const sponsorRate =
        appliedRate.kind === "rate" &&
        tierNeedsSponsorCode(appliedRate.slug, readCodeRequiredTiers(registration.event.settings)) &&
        !!registration.sponsorId;
      evidenceCandidate = target;
      ratedPlan = {
        type: { id: target.id, name: target.name, requiresApproval: target.requiresApproval },
        tierId: priced.tier?.id ?? null,
        tierName: priced.tier?.name ?? "Complimentary",
        price: priced.price,
        currency: priced.tier?.currency ?? target.currency,
        // A status holding money (PAID, a payment in flight) is never touched.
        paymentStatus: RESTAMPABLE_STATUSES.includes(registration.paymentStatus)
          ? stampedPaymentStatus(registration.paymentStatus, priced.price, sponsorRate)
          : null,
      };
    } else if (!registration.ticketTypeId) {
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
      // The same rule as the list above: an open public rate, never a sponsor
      // link, a presenter rate or the type's own price when it has rates.
      const { tier, noRateOnSale } = pickOpenPublicRate(
        chosen.pricingTiers,
        readCodeRequiredTiers(registration.event.settings),
        new Date(),
      );
      if (noRateOnSale) {
        apiLogger.warn({ msg: "complete-registration:no-rate-on-sale", registrationId, chosenTicketTypeId });
        return NextResponse.json(
          { error: "That registration type is not open right now. Please pick another.", code: "NO_RATE_ON_SALE" },
          { status: 400 }
        );
      }
      resolvedType = { id: chosen.id, name: chosen.name, price: chosen.price, currency: chosen.currency, quantity: chosen.quantity, requiresApproval: chosen.requiresApproval };
      resolvedTier = tier ? { id: tier.id, name: tier.name, price: tier.price, currency: tier.currency } : null;
    }
    // Identity evidence, enforced SERVER-side. Until now the completion form
    // required these fields in the browser and this route only checked that a
    // supplied expiry parsed — so the requirement was one crafted request away
    // from being skipped entirely. The policy comes from whichever type
    // applies: the one already on the row, or the one just self-selected.
    const evidenceTicketType = evidenceCandidate ?? registration.ticketType;
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
    const selfSelectedType = resolvedType ?? (ratedPlan && ratedPlan.type.id !== registration.ticketTypeId ? ratedPlan.type : null);
    const flipToPending =
      !!selfSelectedType && selfSelectedType.requiresApproval && registration.status === "CONFIRMED";

    // Update attendee + delete token in transaction
    try {
    await tenantTransaction(async (tx) => {
      if (ratedPlan) {
        // Guarded on the type read above (null, or the stamped type): an
        // organiser changing it meanwhile wins and this rolls back.
        const rowClaim = await tx.registration.updateMany({
          // Also guarded on the state linkMayReprice approved: a payment, a
          // promo, a group or a cancellation landing meanwhile rolls this back.
          where: {
            id: registrationId,
            ticketTypeId: registration.ticketTypeId,
            userId: null,
            status: { not: "CANCELLED" },
            paymentStatus: { in: [...RESTAMPABLE_STATUSES] },
            promoCodeId: null,
            groupId: null,
          },
          data: {
            ticketTypeId: ratedPlan.type.id,
            pricingTierId: ratedPlan.tierId,
            originalPrice: ratedPlan.price,
            ...(ratedPlan.paymentStatus && { paymentStatus: ratedPlan.paymentStatus }),
            ...(flipToPending && { status: "PENDING" as const }),
          },
        });
        if (rowClaim.count === 0) throw new TypeAlreadySetError();
        // The seat follows the type and rate: claimed when they pick a type,
        // moved when they change it, untouched when it stays (the shared
        // transition decides; a full type throws CAPACITY_EXCEEDED).
        const seatState = {
          status: registration.status,
          attendanceMode: registration.attendanceMode,
          createdSource: registration.createdSource,
        };
        try {
          await applyRegistrationTransition(tx, {
            eventId: registration.event.id,
            prev: { ...seatState, ticketTypeId: registration.ticketTypeId, pricingTierId: registration.pricingTierId },
            next: { ...seatState, ticketTypeId: ratedPlan.type.id, pricingTierId: ratedPlan.tierId },
          });
        } catch (seatErr) {
          if (seatErr instanceof Error && (seatErr.message === "CAPACITY_EXCEEDED" || seatErr.message === "EVENT_FULL")) {
            throw new SoldOutError();
          }
          throw seatErr;
        }
      }
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
          ...(ratedPlan && { registrationType: ratedPlan.type.name }),
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
            ...(ratedPlan && {
              linkRate: linkRate?.kind === "rate" ? linkRate.slug : "complimentary",
              ticketTypeId: ratedPlan.type.id,
              ticketTypeName: ratedPlan.type.name,
              ...(ratedPlan.type.id !== registration.ticketTypeId && { previousTicketTypeId: registration.ticketTypeId }),
              pricingTierName: ratedPlan.tierName,
              price: ratedPlan.price,
              ...(!ratedPlan.paymentStatus && { paymentStatusPreserved: registration.paymentStatus }),
              ...(flipToPending && { statusFlippedToPending: true }),
            }),
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
      registrationType: ratedPlan?.type.name ?? resolvedType?.name ?? registration.attendee.registrationType,
      associationName: associationName || registration.attendee.associationName,
      memberId: memberId || registration.attendee.memberId,
      studentId: studentId || registration.attendee.studentId,
      studentIdExpiry: studentIdExpiry ? new Date(studentIdExpiry) : registration.attendee.studentIdExpiry,
    });

    // The type and price this request settled on: the link's rate, the type
    // just picked, or what the row already held. The loaded `registration`
    // predates this request and would price a freshly-typed one at 0.
    const final = finalPricing({ ratedPlan, resolvedType, resolvedTier, resolvedPrice, registration });

    // Send confirmation email
    try {
      const finalPrice = final.price;
      const finalCurrency = final.currency;

      await sendRegistrationConfirmation({
        ...buildEventConfirmationFields(registration.event),
        to: email,
        additionalEmail: registration.attendee.additionalEmail,
        firstName,
        lastName,
        title: title || null,
        organization,
        ticketType: final.typeName,
        pricingTierName: final.tierName,
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
        ticketPrice: final.price,
        ticketCurrency: final.currency,
      },
    });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Unhandled error in registration completion POST" });
    return NextResponse.json({ error: "An unexpected error occurred while completing your registration. Please try again or contact the event organizer." }, { status: 500 });
  }
}
