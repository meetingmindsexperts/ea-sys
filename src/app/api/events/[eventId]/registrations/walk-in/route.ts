import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { getClientIp, checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { runWithTenant } from "@/lib/tenant-context";
import { checkInGate, executeCheckIn } from "@/lib/check-in";
import { HTTP_STATUS_FOR_REGISTRATION_ERROR } from "@/lib/registration-error-status";
import { titleEnum, attendeeRoleEnum } from "@/lib/schemas";
import {
  IDENTITY_EVIDENCE_SELECT,
  hasInvalidExpiryDate,
  missingIdentityEvidence,
  readIdentityEvidencePolicy,
} from "@/lib/identity-evidence";
import { SUPPORTING_DOCUMENT_POLICY_SELECT, resolveSupportingDocument } from "@/lib/supporting-document";
import { createRegistration } from "@/services/registration-service";
import { MANUAL_PAYMENT_EVENT_SELECT, recordManualPayment } from "@/services/payment-service";
import { readCodeRequiredTiers } from "@/lib/code-required-tiers";
import { walkInPaymentAllowed, walkInPaymentChoices } from "@/lib/desk-walkin-payment";

/**
 * POST /api/events/[eventId]/registrations/walk-in
 *
 * The onsite desk's one step for a walk-in (docs/ONSITE_DESK_PLAN.md §4):
 * register, record the payment when paid, and check in, in one request so the
 * desk is done in seconds. The badge is not printed by default: the desk's
 * row offers Print badge (owner, Oct 29 2026), or the Registrations page does.
 *
 * Each step is the shared one: `createRegistration()`, `recordManualPayment()`
 * with the documents deferred (the invoice, receipt and email arrive after the
 * person has left; owner, Oct 28 2026), and `checkInGate()` + `executeCheckIn()`.
 * A step that fails after the registration exists answers 200 with
 * `registered: true` and the reason, so the desk finds the person in search
 * and finishes there instead of registering them twice.
 *
 * Permissions: `registrations.create` and `registrations.checkin`, plus
 * `payments.record` when paid, each judged on this event.
 */

// The fields the public form requires (owner, Oct 29 2026: a walk-in gives the
// same details as someone who registered online, so the row is complete). The
// type's own asks (member / student ID, a supporting document) are checked
// below against the type, as the public route does.
const required = (max: number) => z.string().trim().min(1).max(max);
const optional = (max: number) => z.string().trim().max(max).optional();

const walkInSchema = z
  .object({
    title: titleEnum.refine((v) => v !== undefined, "Title is required"),
    role: attendeeRoleEnum,
    firstName: required(100),
    lastName: required(100),
    email: z.string().trim().email().max(255),
    additionalEmail: z.string().trim().email().max(255).optional().or(z.literal("")),
    organization: required(255),
    jobTitle: required(255),
    phone: required(50),
    city: required(255),
    country: required(255),
    specialty: required(255),
    customSpecialty: optional(255),
    associationName: optional(255),
    memberId: optional(100),
    studentId: optional(100),
    studentIdExpiry: optional(30),
    supportingDocumentUrl: optional(500),
    supportingDocumentFilename: optional(255),
    ticketTypeId: z.string().min(1),
    pricingTierId: z.string().min(1).optional(),
    // "inclusive": a sponsor's code that covers the fee (the registration is
    // saved INCLUSIVE under the code's sponsor). Cash and card may carry any
    // code, which lowers what is collected. "covered": a code that leaves
    // nothing to pay, so nothing is collected and no payment right is needed.
    payment: z.enum(["complimentary", "cash", "card", "inclusive", "covered"]),
    promoCode: optional(50),
    // The price after the code, before tax, that the desk showed. The service
    // refuses if its own figure differs, so the money recorded is the money asked for.
    expectedPrice: z.number().min(0).max(10_000_000).optional(),
    cardLast4: z.string().regex(/^\d{4}$/).optional(),
    cardBrand: z.string().trim().max(50).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.specialty === "Others" && !data.customSpecialty) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["customSpecialty"], message: "Please specify the specialty" });
    }
    if ((data.payment === "inclusive" || data.payment === "covered") && !data.promoCode) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["promoCode"], message: "Enter the code" });
    }
    if (data.promoCode && data.expectedPrice === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expectedPrice"], message: "The price shown with the code is required" });
    }
    if (data.payment === "covered" && data.expectedPrice !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expectedPrice"], message: "A covered walk-in has nothing to pay" });
    }
    if (data.payment === "complimentary" && data.promoCode) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["promoCode"], message: "A code applies to a paid or sponsor walk-in" });
    }
    if (data.payment === "card" && !data.cardLast4) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cardLast4"], message: "Last 4 digits of the card are required" });
    }
  });

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const ROUTE = "events/[eventId]/registrations/walk-in:POST";

export async function POST(req: Request, { params }: RouteParams) {
  const { eventId } = await params;
  try {
    const [session, raw] = await Promise.all([auth(), req.json().catch(() => null)]);

    if (!session?.user) {
      apiLogger.warn({ msg: "walk-in:unauthenticated", eventId });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: ROUTE, eventId });
    if ("error" in orgGuard) return orgGuard.error;

    const createGate = requirePermission(session, "registrations.create", { route: ROUTE, eventId });
    if (!createGate.ok) return createGate.response;
    const checkInPermission = requirePermission(session, "registrations.checkin", { route: ROUTE, eventId });
    if (!checkInPermission.ok) return checkInPermission.response;

    const parsed = walkInSchema.safeParse(raw);
    if (!parsed.success) {
      apiLogger.warn({ msg: "walk-in:zod-validation-failed", eventId, userId: session.user.id, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }
    const data = parsed.data;
    const paid = data.payment === "cash" || data.payment === "card";

    // Each key's scope lives in its own eventWhere (a custom role may hold
    // create everywhere but check-in or payments only on assigned events), so
    // the event must satisfy all of them (review of 26c17807, MED 1).
    const scopes = [createGate.eventWhere, checkInPermission.eventWhere];
    if (paid) {
      const paymentPermission = requirePermission(session, "payments.record", { route: ROUTE, eventId });
      if (!paymentPermission.ok) return paymentPermission.response;
      scopes.push(paymentPermission.eventWhere);
    }

    // Well above any real desk pace (a walk-in takes ~30 s); stops a stuck
    // client or a script from minting registrations without bound.
    const rateLimit = checkRateLimit({ key: `walk-in:${session.user.id}`, limit: 300, windowMs: 60 * 60 * 1000 });
    if (!rateLimit.allowed) {
      return rateLimited(rateLimit, { route: ROUTE, userId: session.user.id, eventId, limit: 300, windowSeconds: 3600 });
    }
    // A paid walk-in is also a manual payment: it spends the same bucket as the
    // payments route (60/hr per person, review H7), checked before anything is
    // created so a refusal never leaves a half-done row.
    if (paid) {
      const paymentRate = checkRateLimit({ key: `manual-payment:${session.user.id}`, limit: 60, windowMs: 60 * 60 * 1000 });
      if (!paymentRate.allowed) {
        return rateLimited(paymentRate, { route: ROUTE, userId: session.user.id, eventId, limit: 60, windowSeconds: 3600, message: "Too many payment recordings. Please wait before recording more." });
      }
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      const event = await db.event.findFirst({ where: { AND: scopes }, select: { ...MANUAL_PAYMENT_EVENT_SELECT, settings: true } });
      if (!event) {
        apiLogger.warn({ msg: "walk-in:event-not-found", eventId, userId: session.user.id });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }

      const ticketType = await db.ticketType.findFirst({
        where: { id: data.ticketTypeId, eventId },
        select: {
          price: true,
          pricingTiers: { where: { id: data.pricingTierId ?? "" }, select: { name: true, price: true } },
          ...IDENTITY_EVIDENCE_SELECT,
          ...SUPPORTING_DOCUMENT_POLICY_SELECT,
        },
      });
      if (!ticketType) {
        apiLogger.warn({ msg: "walk-in:ticket-type-not-found", eventId, ticketTypeId: data.ticketTypeId, userId: session.user.id });
        return NextResponse.json({ error: "Registration type not found", code: "TICKET_TYPE_NOT_FOUND" }, { status: 404 });
      }
      // The rate decides how it may be paid (src/lib/desk-walkin-payment.ts):
      // complimentary only on a free rate, never beside cash and card on a paid
      // one, and cash or card never on a free rate (it would fail at the
      // capture, ZERO_AMOUNT, leaving a half-done row). Refused up front.
      const rate = {
        name: ticketType.pricingTiers[0]?.name ?? null,
        price: Number(ticketType.pricingTiers[0]?.price ?? ticketType.price ?? 0),
      };
      const codeRequired = readCodeRequiredTiers(event.settings);
      if (!walkInPaymentAllowed(data.payment, rate, codeRequired)) {
        apiLogger.warn({ msg: "walk-in:payment-not-for-rate", eventId, payment: data.payment, ticketTypeId: data.ticketTypeId, pricingTierId: data.pricingTierId ?? null, userId: session.user.id });
        const choices = walkInPaymentChoices(rate, codeRequired);
        let error = "This rate is paid: take cash or card, or a sponsor's code. To comp them, choose the Complimentary rate or apply a 100% code.";
        if (choices[0] === "complimentary") error = "This rate is free: register them as complimentary.";
        if (choices[0] === "inclusive") error = "This rate is for sponsored delegates: enter the sponsor's code.";
        return NextResponse.json({ error, code: "PAYMENT_NOT_FOR_RATE", allowed: choices }, { status: 400 });
      }
      const missing = missingIdentityEvidence(readIdentityEvidencePolicy(ticketType), data);
      if (missing.length > 0 || hasInvalidExpiryDate(data)) {
        apiLogger.warn({ msg: "walk-in:identity-evidence-missing", eventId, missing, userId: session.user.id });
        const error = missing.length > 0 ? `Required for this type: ${missing.join(", ")}` : "The student ID expiry is not a valid date";
        return NextResponse.json({ error, code: "IDENTITY_EVIDENCE_REQUIRED" }, { status: 400 });
      }
      const document = resolveSupportingDocument(ticketType, eventId, data.supportingDocumentUrl, data.supportingDocumentFilename);
      if (document.dropped) {
        apiLogger.warn({ msg: "walk-in:supporting-document-dropped", eventId, reason: document.dropped, userId: session.user.id });
      }
      if (document.missingRequired) {
        apiLogger.warn({ msg: "walk-in:supporting-document-missing", eventId, userId: session.user.id });
        return NextResponse.json(
          { error: `${ticketType.documentLabel || "A supporting document"} is required for this type`, code: "SUPPORTING_DOCUMENT_REQUIRED" },
          { status: 400 },
        );
      }

      const created = await createRegistration({
        eventId,
        organizationId: orgGuard.orgId,
        userId: session.user.id,
        ticketTypeId: data.ticketTypeId,
        pricingTierId: data.pricingTierId ?? null,
        attendee: {
          title: data.title ?? null,
          role: data.role,
          email: data.email,
          additionalEmail: data.additionalEmail || null,
          firstName: data.firstName,
          lastName: data.lastName,
          organization: data.organization,
          jobTitle: data.jobTitle,
          phone: data.phone,
          city: data.city,
          country: data.country,
          specialty: data.specialty,
          customSpecialty: data.customSpecialty || null,
          associationName: data.associationName || null,
          memberId: data.memberId || null,
          studentId: data.studentId || null,
          studentIdExpiry: data.studentIdExpiry || null,
        },
        detailsComplete: true,
        supportingDocument: document.url ? { url: document.url, filename: document.filename } : null,
        // Paid: UNASSIGNED until the capture below flips it to PAID. A code
        // that covers the fee makes it INCLUSIVE or COMPLIMENTARY instead.
        paymentStatus: data.payment === "complimentary" ? "COMPLIMENTARY" : undefined,
        promoCode: data.promoCode || null,
        requireSponsorCode: data.payment === "inclusive",
        expectedPrice: data.expectedPrice,
        // On event day the public sales window has usually closed; the desk is
        // staff. Sold-out and the event cap still apply; the service logs it.
        overrideSalesWindow: true,
        // The payment email (invoice + receipt) follows the capture, so the
        // "please pay" confirmation would contradict it a minute later.
        suppressConfirmationEmail: paid,
        source: "rest",
        requestIp: getClientIp(req),
        actorFirstName: session.user.firstName ?? null,
      });
      if (!created.ok) {
        const status = HTTP_STATUS_FOR_REGISTRATION_ERROR[created.code] ?? 500;
        const log = { msg: "walk-in:create-rejected", eventId, userId: session.user.id, code: created.code, status };
        if (created.code === "UNKNOWN") apiLogger.error(log);
        else apiLogger.warn(log);
        return NextResponse.json({ error: created.message, code: created.code, ...(created.meta ?? {}) }, { status });
      }

      const registration = created.registration;
      const name = `${registration.attendee.firstName} ${registration.attendee.lastName}`;
      const summary: WalkInSummary = {
        registered: true,
        registrationId: registration.id,
        serialId: registration.serialId,
        name,
        ticketTypeName: registration.ticketType?.name ?? null,
        paymentStatus: registration.paymentStatus,
        dtcm: created.dtcm,
      };
      // A code can leave nothing to pay: then no payment is taken.
      const collect = paid && registration.paymentStatus === "UNASSIGNED";

      // Past this point the registration exists, so every answer says so, even
      // an exception: a bare 500 would read "not registered" and the desk would
      // take the money or register them again (review of 26c17807, MED 2).
      try {
        return await payAndAdmit({ req, event, data, collect, registrationId: registration.id, name, user: session.user, summary });
      } catch (err) {
        apiLogger.error({ err, msg: "walk-in:failed-after-create", eventId, registrationId: registration.id, userId: session.user.id });
        return NextResponse.json({
          ...summary,
          checkedIn: false,
          step: "check-in",
          code: "UNKNOWN",
          error: "Registered, but the check-in did not finish. Find them in the search and check them in.",
        });
      }
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "walk-in:unexpected-error", eventId });
    return NextResponse.json({ error: "Failed to register the walk-in" }, { status: 500 });
  }
}

interface WalkInSummary {
  registered: true;
  registrationId: string;
  serialId: number | null;
  name: string;
  ticketTypeName: string | null;
  paymentStatus: string;
  dtcm: unknown;
}

/** Record the payment when there is one to collect, then check in through the door's own gate. */
async function payAndAdmit(args: {
  req: Request;
  event: { id: string; organizationId: string; taxRate: unknown; taxLabel: string | null };
  data: z.infer<typeof walkInSchema>;
  collect: boolean;
  registrationId: string;
  name: string;
  user: { id: string; firstName?: string | null; lastName?: string | null; email?: string | null };
  summary: WalkInSummary;
}): Promise<NextResponse> {
  const { req, event, data, collect, registrationId, name, user, summary } = args;
  const eventId = event.id;

  if (collect) {
    const payment = await recordManualPayment({
      event,
      registrationId,
      method: data.payment === "card" ? "card_onsite" : "cash",
      cardLast4: data.cardLast4,
      cardBrand: data.cardBrand,
      cashReceivedBy: data.payment === "cash" ? deskOperatorName(user) : undefined,
      recordedByUserId: user.id,
      requestIp: getClientIp(req),
      deferDocuments: true,
      source: "rest",
    });
    if (!payment.ok) {
      const log = { msg: "walk-in:payment-not-recorded", eventId, registrationId, code: payment.code };
      if (payment.code === "UNKNOWN") apiLogger.error(log);
      else apiLogger.warn(log);
      return NextResponse.json({ ...summary, checkedIn: false, step: "payment", code: payment.code, error: payment.message });
    }
  }

  const fresh = await db.registration.findFirst({
    where: { id: registrationId, eventId },
    select: {
      status: true,
      paymentStatus: true,
      checkedInAt: true,
      originalPrice: true,
      ticketType: { select: { price: true } },
      pricingTier: { select: { price: true } },
    },
  });
  const denial = fresh
    ? checkInGate({
        status: fresh.status,
        paymentStatus: fresh.paymentStatus,
        checkedInAt: fresh.checkedInAt,
        ticketTypePrice: fresh.ticketType?.price,
        pricingTierPrice: fresh.pricingTier?.price,
        originalPrice: fresh.originalPrice,
      })
    : { code: "NOT_FOUND", message: "Registration not found" };
  if (denial) {
    apiLogger.warn({ msg: "walk-in:check-in-refused", eventId, registrationId, code: denial.code });
    return NextResponse.json({ ...summary, checkedIn: false, step: "check-in", code: denial.code, error: denial.message });
  }

  await executeCheckIn({
    eventId,
    registrationId,
    actorUserId: user.id,
    attendeeName: name,
    source: "rest",
    auditExtras: { ip: getClientIp(req), deskWalkIn: true },
  });

  apiLogger.info({ msg: "walk-in:done", eventId, registrationId, payment: data.payment, promoCode: data.promoCode ?? null, collected: collect, userId: user.id });
  return NextResponse.json({ ...summary, checkedIn: true }, { status: 201 });
}

/** Who took the cash, for the receipt's "received by" line. */
function deskOperatorName(user: { firstName?: string | null; lastName?: string | null; email?: string | null }): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || user.email || "Registration desk";
}
