/**
 * Personal registration form links, sent at a rate the organiser chooses
 * (docs/REGISTRATION_FORM_LINKS_PLAN.md, Oct 16, 2026).
 *
 * Three steps, so the two places that send (the Send Registration Form button
 * and the "Registration form" bulk email type) share every rule:
 *
 *   prepareRegistrationForms  checks each registration, and stamps the chosen
 *                             rate on the ones that have a type (owner D4)
 *   mintRegistrationFormLink  one person's link, carrying the rate
 *   sendRegistrationForms     both, plus the email, for the button
 *
 * The bulk pipeline (src/lib/bulk-email.ts) calls the first two and keeps its
 * own batching, resume, BCC and logging.
 */
import crypto from "crypto";
import type { PaymentStatus, Prisma } from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { hashVerificationToken } from "@/lib/security";
import { readCodeRequiredTiers, tierNeedsSponsorCode } from "@/lib/code-required-tiers";
import { isPresenterTierName } from "@/lib/presenter-tiers";
import { registerTierSlug } from "@/lib/main-register-tiers";
import { DAY_MS } from "@/lib/link-expiry";
import { linkRatePrice, priceAtLinkRate, RESTAMPABLE_STATUSES, stampedPaymentStatus } from "@/lib/registration-form-pricing";
import { applyRegistrationTransition } from "@/lib/registration-seat-db";
import { formatDateInTz, resolveTimezone } from "@/lib/event-time";
import {
  registrationFormIdentifier,
  registrationFormIdentifierPrefixes,
  detailsOnlyRegistrationFormIdentifier,
  type RegistrationFormRate,
  type RegistrationFormSkipReason,
} from "@/lib/registration-form-link";
import { brandingFrom, getEventTemplate, renderAndWrap, sendEmail } from "@/lib/email";

export type RegistrationFormSource = "rest" | "bulk";

export { REGISTRATION_FORM_SKIP_LABELS, type RegistrationFormSkipReason } from "@/lib/registration-form-link";

export interface RegistrationFormSkip {
  registrationId: string;
  email: string | null;
  reason: RegistrationFormSkipReason;
}

/** A registration that passed every check and may be sent its link. */
export interface ReadyRegistrationForm {
  registrationId: string;
  email: string;
  title: string | null;
  firstName: string;
  lastName: string;
  ticketTypeName: string | null;
}

export type PrepareRegistrationFormsErrorCode =
  | "EVENT_NOT_FOUND"
  | "RATE_NOT_FOUND"
  | "RATE_NOT_ALLOWED"
  | "SPONSOR_NOT_FOUND";

export type PrepareRegistrationFormsResult =
  | {
      ok: true;
      ready: ReadyRegistrationForm[];
      skipped: RegistrationFormSkip[];
      /** The rate's own name ("Early Bird") or "Complimentary". */
      rateName: string;
      /** The earliest salesEnd of the rate on the registrations' types, for the dialog's warning. */
      rateClosesAt: Date | null;
      event: { id: string; slug: string; timezone: string };
    }
  | { ok: false; code: PrepareRegistrationFormsErrorCode; message: string };

export interface PrepareRegistrationFormsInput {
  eventId: string;
  organizationId: string;
  registrationIds: string[];
  rate: RegistrationFormRate;
  /** Required for a sponsor-link rate unless each registration already has one. */
  sponsorId?: string | null;
  /** Null for a scheduled send whose creator's account no longer exists. */
  actorUserId: string | null;
  source: RegistrationFormSource;
}

const RATE_TIER_SELECT = {
  id: true, name: true, price: true, currency: true, quantity: true,
  soldCount: true, isActive: true, salesStart: true, salesEnd: true, sortOrder: true,
} as const;

export { stampedPaymentStatus } from "@/lib/registration-form-pricing";

type LoadedRegistration = Prisma.RegistrationGetPayload<{
  select: {
    id: true; status: true; userId: true; completedAt: true; paymentStatus: true; refundedAmount: true;
    groupId: true; promoCodeId: true; sponsorId: true; ticketTypeId: true;
    pricingTierId: true; originalPrice: true; attendanceMode: true; createdSource: true;
    attendee: { select: { email: true; title: true; firstName: true; lastName: true } };
    ticketType: { select: { id: true; name: true; virtualPrice: true; pricingTiers: { select: typeof RATE_TIER_SELECT } } };
    _count: { select: { payments: true; invoices: true } };
  };
}>;

/** The first check a registration fails, or null when it may be sent a link. */
function skipReason(
  reg: LoadedRegistration,
  rate: RegistrationFormRate,
  now: Date,
  sponsorRate: boolean,
  sponsorId: string | null,
): RegistrationFormSkipReason | null {
  if (reg.status === "CANCELLED") return "CANCELLED";
  if (reg.userId) return "HAS_ACCOUNT";
  // Completed without an account (docs/ONSITE_DESK_PLAN.md §3.1): a new link would only say so.
  if (reg.completedAt) return "ALREADY_COMPLETED";
  if (!RESTAMPABLE_STATUSES.includes(reg.paymentStatus)) return "MONEY_RECORDED";
  if (Number(reg.refundedAmount) > 0 || reg._count.payments > 0 || reg._count.invoices > 0) return "MONEY_RECORDED";
  if (reg.groupId) return "IN_GROUP";
  if (reg.promoCodeId) return "PROMO_APPLIED";
  if (sponsorRate && !sponsorId && !reg.sponsorId) return "NO_SPONSOR";
  if (rate.kind === "complimentary" || !reg.ticketType) return null;
  const priced = priceAtLinkRate(reg.ticketType.pricingTiers, rate, now);
  if (priced.ok) return null;
  return priced.code === "RATE_NOT_ON_TYPE" ? "RATE_NOT_ON_TYPE" : "RATE_NOT_ON_SALE";
}

/**
 * Checks every registration and stamps the chosen rate on the ones that have
 * a type. Each stamp is guarded on the state it was checked against, so a
 * registration paid or completed in the meantime is skipped as CHANGED.
 */
export async function prepareRegistrationForms(input: PrepareRegistrationFormsInput): Promise<PrepareRegistrationFormsResult> {
  const { eventId, organizationId, rate, actorUserId, source } = input;
  const now = new Date();

  const event = await db.event.findFirst({
    where: { id: eventId, organizationId },
    select: {
      id: true, slug: true, timezone: true, settings: true,
      ticketTypes: { where: { isFaculty: false }, select: { pricingTiers: { select: { name: true } } } },
    },
  });
  if (!event) {
    apiLogger.warn({ msg: "registration-form:event-not-found", eventId });
    return { ok: false, code: "EVENT_NOT_FOUND", message: "Event not found." };
  }

  let rateName = "Complimentary";
  let sponsorRate = false;
  if (rate.kind === "rate") {
    if (isPresenterTierName(rate.slug)) {
      apiLogger.warn({ msg: "registration-form:presenter-rate-refused", eventId, rate: rate.slug });
      return { ok: false, code: "RATE_NOT_ALLOWED", message: "A presenter rate cannot be sent as a registration form." };
    }
    const named = event.ticketTypes.flatMap((t) => t.pricingTiers).find((t) => registerTierSlug(t.name) === rate.slug);
    if (!named) {
      apiLogger.warn({ msg: "registration-form:rate-not-found", eventId, rate: rate.slug });
      return { ok: false, code: "RATE_NOT_FOUND", message: "No registration type on this event has that rate." };
    }
    rateName = named.name;
    sponsorRate = tierNeedsSponsorCode(rate.slug, readCodeRequiredTiers(event.settings));
  }

  const sponsorId = input.sponsorId || null;
  if (sponsorId) {
    const sponsor = await db.sponsor.findFirst({ where: { id: sponsorId, eventId }, select: { id: true } });
    if (!sponsor) {
      apiLogger.warn({ msg: "registration-form:sponsor-not-found", eventId, sponsorId });
      return { ok: false, code: "SPONSOR_NOT_FOUND", message: "That sponsor is not on this event." };
    }
  }

  const registrations = await db.registration.findMany({
    where: { id: { in: input.registrationIds }, eventId },
    select: {
      id: true, status: true, userId: true, completedAt: true, paymentStatus: true, refundedAmount: true,
      groupId: true, promoCodeId: true, sponsorId: true, ticketTypeId: true,
      pricingTierId: true, originalPrice: true, attendanceMode: true, createdSource: true,
      attendee: { select: { email: true, title: true, firstName: true, lastName: true } },
      ticketType: { select: { id: true, name: true, virtualPrice: true, pricingTiers: { select: RATE_TIER_SELECT } } },
      _count: { select: { payments: true, invoices: { where: { status: { not: "CANCELLED" } } } } },
    },
  });

  const found = new Set(registrations.map((r) => r.id));
  const skipped: RegistrationFormSkip[] = input.registrationIds
    .filter((id) => !found.has(id))
    .map((registrationId) => ({ registrationId, email: null, reason: "NOT_FOUND" as const }));
  const ready: ReadyRegistrationForm[] = [];
  let rateClosesAt: Date | null = null;

  for (const reg of registrations) {
    const reason = skipReason(reg, rate, now, sponsorRate, sponsorId);
    if (reason) {
      skipped.push({ registrationId: reg.id, email: reg.attendee.email, reason });
      continue;
    }
    const stamped = await stampRate(reg, { rate, sponsorRate, sponsorId, eventId, organizationId, actorUserId, source });
    if (!stamped.ok) {
      skipped.push({ registrationId: reg.id, email: reg.attendee.email, reason: stamped.reason });
      continue;
    }
    if (stamped.salesEnd && (!rateClosesAt || stamped.salesEnd < rateClosesAt)) rateClosesAt = stamped.salesEnd;
    ready.push({
      registrationId: reg.id,
      email: reg.attendee.email,
      title: reg.attendee.title,
      firstName: reg.attendee.firstName,
      lastName: reg.attendee.lastName,
      ticketTypeName: reg.ticketType?.name ?? null,
    });
  }

  if (skipped.length > 0) {
    apiLogger.warn({
      msg: "registration-form:skipped",
      eventId,
      source,
      skipped: skipped.length,
      reasons: skipped.slice(0, 50).map((s) => [s.registrationId, s.reason]),
    });
  }
  return {
    ok: true,
    ready,
    skipped,
    rateName,
    rateClosesAt,
    event: { id: event.id, slug: event.slug, timezone: resolveTimezone(event.timezone) },
  };
}

/**
 * Writes the chosen rate onto one registration (owner D4). A typeless
 * registration keeps its state: the rate rides in its link and is applied
 * when the person picks a type; only the sponsor is recorded now.
 */
async function stampRate(
  reg: LoadedRegistration,
  ctx: {
    rate: RegistrationFormRate;
    sponsorRate: boolean;
    sponsorId: string | null;
    eventId: string;
    organizationId: string;
    actorUserId: string | null;
    source: RegistrationFormSource;
  },
): Promise<{ ok: true; salesEnd: Date | null } | { ok: false; reason: "CHANGED" | "RATE_SOLD_OUT" }> {
  const tier =
    ctx.rate.kind === "rate" && reg.ticketType
      ? reg.ticketType.pricingTiers.find((t) => registerTierSlug(t.name) === (ctx.rate as { slug: string }).slug) ?? null
      : null;
  const sponsorId = ctx.sponsorRate ? ctx.sponsorId ?? reg.sponsorId : reg.sponsorId;
  // A virtual attendee pays the type's virtual price when it has one (review M3).
  const price = tier
    ? linkRatePrice(Number(tier.price), { isVirtual: reg.attendanceMode === "VIRTUAL", virtualPrice: reg.ticketType?.virtualPrice ?? null })
    : 0;

  const data: {
    pricingTierId?: string | null;
    originalPrice?: number;
    paymentStatus?: PaymentStatus;
    sponsorId: string | null;
  } = reg.ticketTypeId
    ? {
        pricingTierId: tier?.id ?? null,
        originalPrice: price,
        paymentStatus: stampedPaymentStatus(reg.paymentStatus, price, ctx.sponsorRate),
        sponsorId,
      }
    : { sponsorId };

  let written: boolean;
  try {
    written = await tenantTransaction(async (tx) => {
    // Guarded on what was checked: still unpaid, still no account, still the same type.
    const res = await tx.registration.updateMany({
      where: {
        id: reg.id,
        eventId: ctx.eventId,
        userId: null,
        completedAt: null,
        ticketTypeId: reg.ticketTypeId,
        paymentStatus: { in: [...RESTAMPABLE_STATUSES] },
      },
      data,
    });
    if (res.count === 0) return false;
    // A seat counted on a rate (a public registration) moves with the rate;
    // an imported or staff-added one is counted on its type and stays put.
    if (data.pricingTierId !== undefined) {
      const seatState = { status: reg.status, attendanceMode: reg.attendanceMode, ticketTypeId: reg.ticketTypeId, createdSource: reg.createdSource };
      await applyRegistrationTransition(tx, {
        eventId: ctx.eventId,
        prev: { ...seatState, pricingTierId: reg.pricingTierId },
        next: { ...seatState, pricingTierId: data.pricingTierId },
      });
    }
    await tx.auditLog.create({
      data: {
        eventId: ctx.eventId,
        organizationId: ctx.organizationId,
        userId: ctx.actorUserId,
        action: "REGISTRATION_FORM_RATE_SET",
        entityType: "Registration",
        entityId: reg.id,
        changes: {
          rate: ctx.rate.kind === "rate" ? ctx.rate.slug : "complimentary",
          before: {
            pricingTierId: reg.pricingTierId,
            originalPrice: reg.originalPrice === null ? null : Number(reg.originalPrice),
            paymentStatus: reg.paymentStatus,
            sponsorId: reg.sponsorId,
          },
          after: data,
          source: ctx.source,
        },
      },
    });
    return true;
    });
  } catch (err) {
    if (err instanceof Error && (err.message === "CAPACITY_EXCEEDED" || err.message === "EVENT_FULL")) {
      apiLogger.warn({ msg: "registration-form:rate-sold-out", registrationId: reg.id, eventId: ctx.eventId });
      return { ok: false, reason: "RATE_SOLD_OUT" };
    }
    throw err;
  }

  if (!written) {
    apiLogger.warn({ msg: "registration-form:stamp-lost-race", registrationId: reg.id, eventId: ctx.eventId });
    return { ok: false, reason: "CHANGED" };
  }
  return { ok: true, salesEnd: tier?.salesEnd ?? null };
}

/**
 * One person's link. Revokes their earlier registration form links (both
 * identifier forms) so only the newest one works.
 */
export async function mintRegistrationFormLink(input: {
  registrationId: string;
  eventSlug: string;
  rate: RegistrationFormRate;
  expiryDays: number;
  appUrl: string;
}): Promise<{ url: string; expires: Date }> {
  const { exact, startsWith } = registrationFormIdentifierPrefixes(input.registrationId);
  await db.verificationToken.deleteMany({
    where: { OR: [{ identifier: exact }, { identifier: { startsWith } }] },
  });
  const rawToken = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + input.expiryDays * DAY_MS);
  await db.verificationToken.create({
    data: {
      identifier: registrationFormIdentifier(input.registrationId, input.rate),
      token: hashVerificationToken(rawToken),
      expires,
    },
  });
  return { url: `${input.appUrl}/e/${input.eventSlug}/complete-registration?token=${rawToken}`, expires };
}

/**
 * The onsite desk's completion link (docs/ONSITE_DESK_PLAN.md §5.4): details
 * only (no rate, so nothing is re-priced and a paid person can still complete),
 * valid for `minutes`, single use (the completion route deletes it on
 * submit). Revokes the person's earlier links, emailed ones included, so they
 * cannot complete twice.
 *
 * A live details-only link (made at a desk, maybe another desk, maybe before a
 * reload) is someone typing right now: it is replaced only when `replace` is
 * set, so no desk cancels it unawares (review of 055680a9, HIGH 2). One
 * tenant transaction, so two desks minting at once leave one live link.
 */
export async function mintOnsiteCompletionLink(input: {
  registrationId: string;
  eventSlug: string;
  minutes: number;
  appUrl: string;
  replace: boolean;
}): Promise<{ ok: true; url: string; expires: Date } | { ok: false; code: "LINK_ACTIVE"; expires: Date }> {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + input.minutes * 60_000);
  const identifier = detailsOnlyRegistrationFormIdentifier(input.registrationId);
  const { exact, startsWith } = registrationFormIdentifierPrefixes(input.registrationId);
  return tenantTransaction(async (tx) => {
    // Serialise mints for this person: two desks at once must not both see
    // "no live link" and then delete each other's (review of 44e6c9b1).
    // ::text because pg_advisory_xact_lock returns void, which $queryRaw cannot read.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`onsite-link:${input.registrationId}`}))::text`;
    if (!input.replace) {
      const live = await tx.verificationToken.findFirst({
        where: { identifier, expires: { gt: new Date() } },
        select: { expires: true },
      });
      if (live) return { ok: false as const, code: "LINK_ACTIVE" as const, expires: live.expires };
    }
    await tx.verificationToken.deleteMany({ where: { OR: [{ identifier: exact }, { identifier: { startsWith } }] } });
    await tx.verificationToken.create({ data: { identifier, token: hashVerificationToken(rawToken), expires } });
    return {
      ok: true as const,
      url: `${input.appUrl}/e/${input.eventSlug}/complete-registration?token=${rawToken}`,
      expires,
    };
  });
}

/** Removes a person's links, e.g. after their email failed to send. */
export async function revokeRegistrationFormLinks(registrationId: string): Promise<void> {
  const { exact, startsWith } = registrationFormIdentifierPrefixes(registrationId);
  await db.verificationToken.deleteMany({
    where: { OR: [{ identifier: exact }, { identifier: { startsWith } }] },
  });
}

/** The link tokens the `registration-form` template uses, for one person. */
export function registrationFormVars(input: {
  link: string;
  expires: Date;
  expiryDays: number;
  rateName: string;
  timezone: string;
}): Record<string, string> {
  return {
    registrationFormLink: input.link,
    rateName: input.rateName,
    linkExpiresIn: input.expiryDays === 1 ? "1 day" : `${input.expiryDays} days`,
    linkExpiresOn: formatDateInTz(input.expires, input.timezone),
  };
}

export interface SendRegistrationFormsInput extends PrepareRegistrationFormsInput {
  expiryDays: number;
  appUrl: string;
  organizerName?: string;
  organizerSignature?: string;
}

export type SendRegistrationFormsResult =
  | {
      ok: true;
      sent: number;
      skipped: RegistrationFormSkip[];
      errors: string[];
      rateName: string;
      rateClosesAt: Date | null;
    }
  | { ok: false; code: PrepareRegistrationFormsErrorCode | "TEMPLATE_MISSING"; message: string };

/** The Send Registration Form button: check, stamp, link and email each person. */
export async function sendRegistrationForms(input: SendRegistrationFormsInput): Promise<SendRegistrationFormsResult> {
  const prepared = await prepareRegistrationForms(input);
  if (!prepared.ok) return prepared;

  const template = await getEventTemplate(input.eventId, "registration-form");
  if (!template) {
    apiLogger.error({ msg: "registration-form:template-missing", eventId: input.eventId });
    return { ok: false, code: "TEMPLATE_MISSING", message: "The registration form email template is missing." };
  }

  let sent = 0;
  const errors: string[] = [];
  for (const person of prepared.ready) {
    try {
      const { url, expires } = await mintRegistrationFormLink({
        registrationId: person.registrationId,
        eventSlug: prepared.event.slug,
        rate: input.rate,
        expiryDays: input.expiryDays,
        appUrl: input.appUrl,
      });
      const vars = {
        title: person.title ? `${person.title}.` : "",
        firstName: person.firstName,
        lastName: person.lastName,
        ticketType: person.ticketTypeName ?? "",
        organizerName: input.organizerName ?? "",
        organizerSignature: input.organizerSignature ?? "",
        personalMessage: "",
        ...registrationFormVars({
          link: url,
          expires,
          expiryDays: input.expiryDays,
          rateName: prepared.rateName,
          timezone: prepared.event.timezone,
        }),
      };
      const rendered = renderAndWrap(template, vars, template.branding);
      const result = await sendEmail({
        to: [{ email: person.email, name: `${person.firstName} ${person.lastName}` }],
        subject: rendered.subject,
        htmlContent: rendered.htmlContent,
        textContent: rendered.textContent,
        from: brandingFrom(template.branding),
        emailType: "registration_completion",
        stream: "bulk",
        logContext: {
          organizationId: input.organizationId,
          eventId: input.eventId,
          entityType: "REGISTRATION",
          entityId: person.registrationId,
          templateSlug: "registration-form",
          triggeredByUserId: input.actorUserId,
        },
      });
      if (result.success) {
        sent++;
        continue;
      }
      // The stamp stays (it is the organiser's decision, not the email's);
      // only the link that never arrived is removed.
      await revokeRegistrationFormLinks(person.registrationId);
      apiLogger.warn({ msg: "registration-form:send-failed", registrationId: person.registrationId, error: result.error });
      errors.push(`${person.email}: failed to deliver email (${result.error || "provider rejected"})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      apiLogger.error({ msg: "registration-form:send-error", registrationId: person.registrationId, err: message });
      errors.push(`${person.email}: ${message}`);
    }
  }

  apiLogger.info({
    msg: "registration-form:sent",
    eventId: input.eventId,
    rate: input.rate.kind === "rate" ? input.rate.slug : "complimentary",
    expiryDays: input.expiryDays,
    sent,
    skipped: prepared.skipped.length,
    errors: errors.length,
  });
  return { ok: true, sent, skipped: prepared.skipped, errors, rateName: prepared.rateName, rateClosesAt: prepared.rateClosesAt };
}
