/**
 * Group registration service (docs/GROUP_REGISTRATION_PLAN.md, Phase 1).
 *
 * ONE operation: a coordinator registers N members with ONE company payer and
 * ONE consolidated invoice, atomically. Called by the public
 * `POST /api/public/events/[slug]/group-register` route (Phase 1); the "My
 * Group" portal's add-member lands in Phase 3.
 *
 * Follows the services convention (src/services/README.md): errors as values,
 * already-typed inputs, service owns the transaction + side effects, never
 * imports next/server.
 *
 * Money model (owner decisions July 30, 2026):
 *  - per-member price = the ticket type's CURRENTLY-on-sale pricing tier
 *    (pickCurrentPricingTier — "whatever is open at submission"), else the
 *    base price; stamped as `originalPrice`.
 *  - members are created UNPAID (the payer owes; pay-later v1) and are NEVER
 *    dunned individually — their confirmation email carries a "covered by
 *    {payer}" note instead of Pay Now, no quote PDF.
 *  - the consolidated invoice (createGroupInvoice) is the single money
 *    artifact, emailed to the payer + coordinator.
 *
 * Seat accounting (owner ruling Aug 6, 2026 — review M4): a public group is a
 * public door, so tier price implies tier inventory — GROUP_REGISTER rows with
 * a `pricingTierId` count on the PRICING-TIER counter exactly like individual
 * public registrations (the seat model's `seatCounter` routes them; release
 * paths follow automatically). Tier-less members count on the ticket-type
 * counter. Claims are aggregated per COUNTER via the shared `seatCounter`
 * helper (never re-derived here) + one event-wide `claimEventSeats`,
 * all-or-nothing inside the same transaction — a sold-out tier or type
 * mid-group rolls the whole group back.
 */
import {
  PaymentStatus,
  RegistrationStatus,
  AttendanceMode,
  type Prisma,
} from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { generateBarcode } from "@/lib/utils";
import { getNextSerialId } from "@/lib/registration-serial";
import { claimSeats, claimEventSeats } from "@/lib/registration-seat-db";
import { seatCounter, type SeatCounter } from "@/lib/registration-seat";
import { pickCurrentPricingTier } from "@/lib/current-pricing-tier";
import {
  readGroupRegistrationSettings,
  groupSizeOutOfBounds,
  GROUP_MEMBERS_HARD_CEILING,
} from "@/lib/group-registration-settings";
import { findOrCreateBillingAccount } from "@/services/billing-account-service";
import {
  sendRegistrationConfirmationEmail,
  CONFIRMATION_EVENT_SELECT,
  type ConfirmationEventRow,
} from "@/services/registration-service";
import { createGroupInvoice, sendGroupInvoiceEmail, cancelInvoice } from "@/lib/invoice-service";
import { syncToContact } from "@/lib/contact-sync";
import { refreshEventStats } from "@/lib/event-stats";
import { notifyEventAdmins } from "@/lib/notifications";
import { sendEmail, getEventTemplate, getDefaultTemplate, renderAndWrap, brandingFrom } from "@/lib/email";
import { escapeHtml } from "@/lib/html";
import { round2 } from "@/lib/registration-financials";

// ── Input / result shapes ────────────────────────────────────────────────────

export interface GroupMemberAttendeeInput {
  title?: string | null;
  firstName: string;
  lastName: string;
  email: string;
  additionalEmail?: string | null;
  organization?: string | null;
  jobTitle?: string | null;
  phone?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  country?: string | null;
  role?: string | null;
  specialty?: string | null;
  customSpecialty?: string | null;
}

export interface GroupMemberInput {
  ticketTypeId: string;
  attendee: GroupMemberAttendeeInput;
}

export interface CreateGroupRegistrationInput {
  eventId: string;
  organizationId: string;
  /** The coordinator's REGISTRANT account (null when account creation failed
   * — the group still stands; the snapshots below identify them). */
  coordinatorUserId: string | null;
  coordinator: { name: string; email: string };
  coordinatorAttending: boolean;
  payer: {
    name: string;
    contactName?: string | null;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
    city?: string | null;
    country?: string | null;
    taxNumber?: string | null;
  };
  payerReference?: string | null;
  /** ALL member rows — when the coordinator attends, the route includes
   * their row here (matched to the coordinator by email for userId linking). */
  members: GroupMemberInput[];
  requestIp?: string | null;
}

export type CreateGroupRegistrationErrorCode =
  | "EVENT_NOT_FOUND"
  | "GROUP_DISABLED"
  | "GROUP_SIZE_OUT_OF_BOUNDS"
  | "TICKET_TYPE_NOT_FOUND"
  | "TICKET_TYPE_IS_FACULTY"
  | "SALES_NOT_STARTED"
  | "SALES_ENDED"
  | "DUPLICATE_IN_GROUP"
  | "ALREADY_REGISTERED"
  | "SOLD_OUT"
  | "EVENT_FULL"
  | "PAYER_INVALID"
  | "MIXED_CURRENCY"
  | "UNKNOWN";

export interface CreatedGroupSummary {
  groupId: string;
  billingAccountId: string;
  memberCount: number;
  subtotal: number;
  currency: string;
  invoiceNumber: string | null;
  members: Array<{
    registrationId: string;
    serialId: number | null;
    email: string;
    firstName: string;
    lastName: string;
    ticketTypeName: string;
    price: number;
  }>;
}

export type CreateGroupRegistrationResult =
  | { ok: true; group: CreatedGroupSummary }
  | {
      ok: false;
      code: CreateGroupRegistrationErrorCode;
      message: string;
      meta?: Record<string, unknown>;
    };

/** Public base URL for links minted into coordinator emails. */
const appUrl = () =>
  process.env.NEXT_PUBLIC_APP_URL ||
  process.env.NEXTAUTH_URL ||
  "https://events.meetingmindsgroup.com";

/** Internal sentinel for tx rollback → error-code mapping (house pattern). */
class GroupServiceSentinel extends Error {
  constructor(
    public code: CreateGroupRegistrationErrorCode,
    public meta: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "GroupServiceSentinel";
  }
}

// ── The operation ────────────────────────────────────────────────────────────

/** A member row as created inside the transaction. */
export type CreatedMemberRow = {
  registrationId: string;
  serialId: number | null;
  email: string;
  firstName: string;
  lastName: string;
  ticketTypeName: string;
  price: number;
  attendee: GroupMemberAttendeeInput;
  qrCode: string;
  ticketTypeId: string;
  currency: string;
};

/** Per-type resolved pricing (the tier on sale NOW, else the base price). */
export type ResolvedTypePricing = {
  tierId: string | null;
  tierName: string | null;
  price: number;
  name: string;
  currency: string;
  requiresApproval: boolean;
};

/**
 * Claim the seats for a set of members, then create their attendee +
 * registration rows. Runs INSIDE a caller-provided transaction.
 *
 * Shared by the initial group create and by adding members later, so the two
 * can never drift on the part that would be most damaging if they did: seat
 * accounting. Claims are all-or-nothing and aggregated per COUNTER via the
 * shared `seatCounter` helper (tier-priced members burn the TIER's inventory,
 * tier-less members the ticket type's), then the event-wide cap — never
 * re-derived here, so the claim side always matches the release side used by
 * cancel/delete.
 *
 * Throws `GroupServiceSentinel` on SOLD_OUT / EVENT_FULL so the caller's
 * transaction rolls the whole batch back.
 */
async function claimSeatsAndCreateMembers(
  tx: Prisma.TransactionClient,
  args: {
    eventId: string;
    organizationId: string;
    groupId: string;
    members: Array<{ ticketTypeId: string; attendee: GroupMemberAttendeeInput }>;
    pricingByType: Map<string, ResolvedTypePricing>;
    billingAccountId: string;
    payerReference: string | null;
    /** Links this member's row to the coordinator's own account, if they attend. */
    coordinatorEmail: string;
    /** Null when the coordinator has no account (creation failed) — their own
     *  member row is then account-less, exactly like the others. */
    coordinatorUserId: string | null;
  },
): Promise<CreatedMemberRow[]> {
  const {
    eventId, organizationId, groupId, members, pricingByType,
    billingAccountId, payerReference, coordinatorEmail, coordinatorUserId,
  } = args;

  const countByCounter = new Map<
    string,
    { counter: SeatCounter; count: number; label: string; ticketTypeId: string }
  >();
  for (const m of members) {
    const pricing = pricingByType.get(m.ticketTypeId)!;
    const counter = seatCounter({
      createdSource: "GROUP_REGISTER",
      pricingTierId: pricing.tierId,
      ticketTypeId: m.ticketTypeId,
    });
    if (!counter) continue; // unreachable: every member has a ticket type
    const key = `${counter.kind}:${counter.id}`;
    const label =
      counter.kind === "tier" && pricing.tierName
        ? `${pricing.name} — ${pricing.tierName}`
        : pricing.name;
    const entry = countByCounter.get(key) ?? {
      counter,
      count: 0,
      label,
      ticketTypeId: m.ticketTypeId,
    };
    entry.count += 1;
    countByCounter.set(key, entry);
  }
  for (const { counter, count, label, ticketTypeId } of countByCounter.values()) {
    const claimed = await claimSeats(tx, counter, count);
    if (!claimed) {
      throw new GroupServiceSentinel("SOLD_OUT", {
        ticketTypeId,
        ticketTypeName: label,
      });
    }
  }
  const eventClaimed = await claimEventSeats(tx, eventId, members.length);
  if (!eventClaimed) {
    throw new GroupServiceSentinel("EVENT_FULL", {});
  }

  const rows: CreatedMemberRow[] = [];
  for (const m of members) {
    const pricing = pricingByType.get(m.ticketTypeId)!;
    const a = m.attendee;
    const attendeeRecord = await tx.attendee.create({
      data: {
        organizationId,
        title: (a.title as never) ?? null,
        role: (a.role as never) ?? null,
        email: a.email,
        additionalEmail: a.additionalEmail ?? null,
        firstName: a.firstName,
        lastName: a.lastName,
        organization: a.organization || null,
        jobTitle: a.jobTitle || null,
        phone: a.phone || null,
        city: a.city || null,
        state: a.state || null,
        zipCode: a.zipCode || null,
        country: a.country || null,
        specialty: a.specialty || null,
        customSpecialty: a.customSpecialty || null,
        registrationType: pricing.name,
      },
      select: { id: true },
    });
    const serialId = await getNextSerialId(tx, eventId, organizationId);
    const qrCode = generateBarcode();
    const reg = await tx.registration.create({
      data: {
        organizationId,
        eventId,
        groupId,
        ticketTypeId: m.ticketTypeId,
        pricingTierId: pricing.tierId,
        attendeeId: attendeeRecord.id,
        // The coordinator's own member row links their account so it
        // shows in /my-registration; other members are account-less.
        userId: a.email === coordinatorEmail ? coordinatorUserId : null,
        serialId,
        createdSource: "GROUP_REGISTER",
        status: pricing.requiresApproval
          ? RegistrationStatus.PENDING
          : RegistrationStatus.CONFIRMED,
        // The payer owes: UNPAID until the group settles.
        paymentStatus: PaymentStatus.UNPAID,
        attendanceMode: AttendanceMode.IN_PERSON,
        billingAccountId,
        payerReference,
        qrCode,
        originalPrice: pricing.price,
      },
      select: { id: true, serialId: true },
    });
    rows.push({
      registrationId: reg.id,
      serialId: reg.serialId,
      email: a.email,
      firstName: a.firstName,
      lastName: a.lastName,
      ticketTypeName: pricing.name,
      price: pricing.price,
      attendee: a,
      qrCode,
      ticketTypeId: m.ticketTypeId,
      currency: pricing.currency,
    });
  }
  return rows;
}

export async function createGroupRegistration(
  input: CreateGroupRegistrationInput,
): Promise<CreateGroupRegistrationResult> {
  const { eventId, organizationId } = input;

  // 1. Event + enablement + bounds (defense in depth — the route pre-checks).
  const event = await db.event.findFirst({
    where: { id: eventId, organizationId },
    select: {
      ...CONFIRMATION_EVENT_SELECT,
      settings: true,
      id: true,
      // Branded sender for the coordinator email — getEventTemplate only
      // returns branding when a DB template row exists, and no event has one
      // for the NEW group slug yet, so the from must be threaded explicitly
      // (caught live: the fallback env sender failed SES verification).
      emailFromAddress: true,
      emailFromName: true,
    },
  });
  if (!event) {
    return { ok: false, code: "EVENT_NOT_FOUND", message: "Event not found" };
  }
  const settings = readGroupRegistrationSettings(event.settings);
  if (!settings.enabled) {
    return {
      ok: false,
      code: "GROUP_DISABLED",
      message: "Group registration is not open for this event.",
    };
  }
  if (input.members.length > GROUP_MEMBERS_HARD_CEILING) {
    return {
      ok: false,
      code: "GROUP_SIZE_OUT_OF_BOUNDS",
      message: `A group can have at most ${GROUP_MEMBERS_HARD_CEILING} members.`,
    };
  }
  const bounds = groupSizeOutOfBounds(input.members.length, settings);
  if (!bounds.ok) {
    return {
      ok: false,
      code: "GROUP_SIZE_OUT_OF_BOUNDS",
      message: bounds.message,
      meta: { minMembers: settings.minMembers, maxMembers: settings.maxMembers },
    };
  }

  // 2. Normalize members + in-batch duplicate check.
  const members = input.members.map((m) => ({
    ticketTypeId: m.ticketTypeId,
    attendee: {
      ...m.attendee,
      email: m.attendee.email.trim().toLowerCase(),
      additionalEmail: m.attendee.additionalEmail
        ? m.attendee.additionalEmail.trim().toLowerCase()
        : null,
    },
  }));
  const seen = new Set<string>();
  for (const m of members) {
    if (seen.has(m.attendee.email)) {
      return {
        ok: false,
        code: "DUPLICATE_IN_GROUP",
        message: `${m.attendee.email} appears more than once in the group.`,
        meta: { email: m.attendee.email },
      };
    }
    seen.add(m.attendee.email);
  }

  // 3. Ticket types: exist + active + delegate + PUBLIC sales window open
  //    (no staff override on the public path); resolve the live tier price.
  const now = new Date();
  const distinctTypeIds = [...new Set(members.map((m) => m.ticketTypeId))];
  const ticketTypes = await db.ticketType.findMany({
    where: { id: { in: distinctTypeIds }, eventId, isActive: true },
    select: {
      id: true,
      name: true,
      price: true,
      currency: true,
      quantity: true,
      soldCount: true,
      salesStart: true,
      salesEnd: true,
      requiresApproval: true,
      isFaculty: true,
      pricingTiers: {
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          price: true,
          currency: true,
          quantity: true,
          soldCount: true,
          isActive: true,
          salesStart: true,
          salesEnd: true,
          sortOrder: true,
        },
      },
    },
  });
  const typeById = new Map(ticketTypes.map((t) => [t.id, t]));
  for (const id of distinctTypeIds) {
    const t = typeById.get(id);
    if (!t) {
      return {
        ok: false,
        code: "TICKET_TYPE_NOT_FOUND",
        message: "One of the selected registration types was not found or is inactive.",
        meta: { ticketTypeId: id },
      };
    }
    if (t.isFaculty) {
      return {
        ok: false,
        code: "TICKET_TYPE_IS_FACULTY",
        message: `"${t.name}" is reserved for speakers and cannot be used for group members.`,
        meta: { ticketTypeId: id },
      };
    }
    if (t.salesStart && new Date(t.salesStart) > now) {
      return {
        ok: false,
        code: "SALES_NOT_STARTED",
        message: `Sales for "${t.name}" have not started yet.`,
        meta: { ticketTypeId: id },
      };
    }
    if (t.salesEnd && new Date(t.salesEnd) < now) {
      return {
        ok: false,
        code: "SALES_ENDED",
        message: `Sales for "${t.name}" have ended.`,
        meta: { ticketTypeId: id },
      };
    }
  }

  // Mixed-currency guard (review M3): summing member prices across currencies
  // would produce a nonsense consolidated invoice under one currency label.
  const currencies = [...new Set(ticketTypes.map((t) => t.currency ?? "USD"))];
  if (currencies.length > 1) {
    return {
      ok: false,
      code: "MIXED_CURRENCY",
      message: `The selected registration types use different currencies (${currencies.join(", ")}) — a group must be billed in one currency.`,
      meta: { currencies },
    };
  }

  // Per-type resolved pricing: the tier on sale NOW (owner decision — the
  // live window at submission), else the base price.
  const pricingByType = new Map<
    string,
    {
      tierId: string | null;
      tierName: string | null;
      price: number;
      name: string;
      currency: string;
      requiresApproval: boolean;
    }
  >();
  for (const t of ticketTypes) {
    const tier = pickCurrentPricingTier(t.pricingTiers, now);
    pricingByType.set(t.id, {
      tierId: tier?.id ?? null,
      tierName: tier?.name ?? null,
      price: Number(tier?.price ?? t.price),
      name: t.name,
      currency: t.currency ?? "USD",
      requiresApproval: t.requiresApproval,
    });
  }

  // 4. Payer: org-level find-or-create (exact-name reuse; near-duplicates
  //    flagged needsReview) + per-event attachment. Pre-tx by design — a
  //    payer row is a reusable org entity, harmless without a group.
  const payerResult = await findOrCreateBillingAccount({
    organizationId,
    userId: input.coordinatorUserId,
    source: "public",
    requestIp: input.requestIp ?? undefined,
    name: input.payer.name,
    contactName: input.payer.contactName ?? undefined,
    email: input.payer.email ?? undefined,
    phone: input.payer.phone ?? undefined,
    address: input.payer.address ?? undefined,
    city: input.payer.city ?? undefined,
    country: input.payer.country ?? undefined,
    taxNumber: input.payer.taxNumber ?? undefined,
  });
  if (!payerResult.ok) {
    return {
      ok: false,
      code: "PAYER_INVALID",
      message: payerResult.message,
    };
  }
  const billingAccount = payerResult.billingAccount;
  await db.eventBillingAccount.upsert({
    where: {
      eventId_billingAccountId: { eventId, billingAccountId: billingAccount.id },
    },
    create: { eventId, billingAccountId: billingAccount.id },
    update: {},
  });

  const payerReference = input.payerReference?.trim() || null;
  const coordinatorEmail = input.coordinator.email.trim().toLowerCase();

  // 5. THE transaction: dup check → group row → seat claims → members.
  let groupId: string;
  let createdMembers: CreatedMemberRow[];
  try {
    const txResult = await tenantTransaction(async (tx) => {
      // Review H3: serialize same-coordinator submissions for this event — a
      // double-click / proxy retry racing a slow 50-member tx would otherwise
      // pass the read-based dup check twice and mint TWO groups + TWO
      // consolidated invoices. pg_advisory_xact_lock is the pooler-safe
      // variant (the webinar-sequence pattern); the loser waits, then its dup
      // check sees the winner's members → ALREADY_REGISTERED.
      // ::text cast — pg_advisory_xact_lock returns `void`, which Prisma 6.19's
      // $queryRaw cannot deserialize (caught in the live smoke; the bare form
      // throws "Failed to deserialize column of type 'void'").
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`group-register:${eventId}:${coordinatorEmail}`}))::text`;

      // Existing-registration duplicate check (non-CANCELLED, this event).
      // mode:"insensitive" — legacy CSV-era attendees can carry mixed-case
      // emails; a case-sensitive IN would let a duplicate person through
      // (review M9, the grant-flow lesson).
      const existing = await tx.registration.findFirst({
        where: {
          eventId,
          status: { notIn: [RegistrationStatus.CANCELLED] },
          attendee: {
            OR: members.map((m) => ({
              email: { equals: m.attendee.email, mode: "insensitive" as const },
            })),
          },
        },
        select: { attendee: { select: { email: true } } },
      });
      if (existing) {
        throw new GroupServiceSentinel("ALREADY_REGISTERED", {
          email: existing.attendee.email,
        });
      }

      const group = await tx.registrationGroup.create({
        data: {
          eventId,
          organizationId,
          coordinatorUserId: input.coordinatorUserId,
          coordinatorName: input.coordinator.name,
          coordinatorEmail,
          coordinatorAttending: input.coordinatorAttending,
          billingAccountId: billingAccount.id,
          payerReference,
        },
        select: { id: true },
      });

      // Seat claims + member rows: the SHARED helper, so this path and the
      // add-members path can never drift on seat accounting.
      const rows = await claimSeatsAndCreateMembers(tx, {
        eventId,
        organizationId,
        groupId: group.id,
        members,
        pricingByType,
        billingAccountId: billingAccount.id,
        payerReference,
        coordinatorEmail,
        coordinatorUserId: input.coordinatorUserId,
      });
      return { groupId: group.id, rows };
    // Review M5: a 50-member group runs ~150 sequential statements while
    // holding the serial-counter row lock — the 5s default interactive-tx
    // timeout is not enough under pooler latency (the bulk-tags precedent).
    }, { timeout: 30_000, maxWait: 10_000 });
    groupId = txResult.groupId;
    createdMembers = txResult.rows;
  } catch (err) {
    if (err instanceof GroupServiceSentinel) {
      const messages: Record<string, string> = {
        ALREADY_REGISTERED: `${err.meta.email} is already registered for this event.`,
        SOLD_OUT: `"${err.meta.ticketTypeName ?? "A registration type"}" sold out — not enough seats for the whole group.`,
        EVENT_FULL: "This event has reached its maximum number of attendees.",
      };
      apiLogger.warn(
        { code: err.code, meta: err.meta, eventId, members: members.length },
        "group-registration:create-rejected",
      );
      return {
        ok: false,
        code: err.code,
        message: messages[err.code] ?? err.code,
        meta: err.meta,
      };
    }
    apiLogger.error({ err, eventId }, "group-registration:create-failed");
    return {
      ok: false,
      code: "UNKNOWN",
      message: err instanceof Error ? err.message : "Failed to create the group registration",
    };
  }

  const subtotal = round2(createdMembers.reduce((s, m) => s + m.price, 0));
  const currency = createdMembers[0]?.currency ?? "USD";

  // ── Post-commit side effects (each failure-isolated — the group stands) ──

  // Consolidated invoice + its email to payer + coordinator.
  let invoiceNumber: string | null = null;
  try {
    const invoice = await createGroupInvoice({ groupId, eventId, organizationId });
    invoiceNumber = invoice.invoiceNumber;
    try {
      await sendGroupInvoiceEmail(invoice.id);
    } catch (err) {
      apiLogger.error({ err, groupId, invoiceId: invoice.id }, "group-registration:invoice-email-failed");
    }
  } catch (err) {
    apiLogger.error({ err, groupId }, "group-registration:invoice-create-failed");
    notifyEventAdmins(eventId, {
      type: "REGISTRATION",
      title: "⚠ Group invoice could not be created",
      message: `A group registration (${createdMembers.length} members, coordinator ${input.coordinator.name}) was created but its consolidated invoice failed — create one manually.`,
      link: `/events/${eventId}/registrations`,
    }).catch((e) => apiLogger.error({ err: e, groupId }, "group-registration:invoice-fail-notify-failed"));
  }

  // Member confirmations: barcode included, Pay Now REPLACED by "covered by
  // {payer}" (members are never dunned), no quote PDF.
  const eventRow = event as unknown as ConfirmationEventRow;
  for (const m of createdMembers) {
    sendRegistrationConfirmationEmail({
      event: eventRow,
      registration: { id: m.registrationId, serialId: m.serialId, qrCode: m.qrCode },
      attendee: {
        email: m.email,
        additionalEmail: m.attendee.additionalEmail ?? null,
        firstName: m.firstName,
        lastName: m.lastName,
        title: m.attendee.title ?? null,
        organization: m.attendee.organization ?? null,
        jobTitle: m.attendee.jobTitle ?? null,
        city: m.attendee.city ?? null,
        country: m.attendee.country ?? null,
      },
      ticketTypeName: m.ticketTypeName,
      ticketCurrency: m.currency,
      price: m.price,
      attendanceMode: AttendanceMode.IN_PERSON,
      coveredByGroupPayerName: billingAccount.name,
      logKey: "group-registration:member-confirmation-failed",
    });
  }

  // Coordinator summary email (editable system template).
  sendCoordinatorConfirmation({
    groupId,
    event: event as unknown as {
      id: string;
      emailFromAddress: string | null;
      emailFromName: string | null;
    } & ConfirmationEventRow,
    coordinator: input.coordinator,
    payerName: billingAccount.name,
    members: createdMembers,
    subtotal,
    currency,
    invoiceNumber,
    taxRate: eventRow.taxRate ? Number(eventRow.taxRate) : null,
  }).catch((err) =>
    apiLogger.error({ err, groupId }, "group-registration:coordinator-email-failed"),
  );

  // Contact sync per member (enrich-only; never throws upstream).
  for (const m of createdMembers) {
    await syncToContact({
      organizationId,
      eventId,
      email: m.email,
      firstName: m.firstName,
      lastName: m.lastName,
      title: m.attendee.title ?? null,
      role: m.attendee.role ?? null,
      additionalEmail: m.attendee.additionalEmail ?? null,
      organization: m.attendee.organization ?? null,
      jobTitle: m.attendee.jobTitle ?? null,
      phone: m.attendee.phone ?? null,
      city: m.attendee.city ?? null,
      state: m.attendee.state ?? null,
      zipCode: m.attendee.zipCode ?? null,
      country: m.attendee.country ?? null,
      specialty: m.attendee.specialty ?? null,
      customSpecialty: m.attendee.customSpecialty ?? null,
      registrationType: m.ticketTypeName,
    });
  }

  // Audit (fire-and-forget with logged catch) + admin notify + stats.
  db.auditLog
    .create({
      data: {
        eventId,
        organizationId,
        userId: input.coordinatorUserId,
        action: "CREATE",
        entityType: "RegistrationGroup",
        entityId: groupId,
        changes: {
          source: "public-group-register",
          memberCount: createdMembers.length,
          billingAccountId: billingAccount.id,
          payerName: billingAccount.name,
          payerReused: payerResult.reused,
          coordinatorEmail,
          coordinatorAttending: input.coordinatorAttending,
          subtotal,
          currency,
          invoiceNumber,
          ...(input.requestIp ? { ip: input.requestIp } : {}),
        },
      },
    })
    .catch((err) => apiLogger.error({ err, groupId }, "group-registration:audit-failed"));

  notifyEventAdmins(eventId, {
    type: "REGISTRATION",
    title: "New group registration",
    message: `${input.coordinator.name} registered a group of ${createdMembers.length} (billed to ${billingAccount.name}).`,
    link: `/events/${eventId}/registrations`,
  }).catch((err) => apiLogger.error({ err, groupId }, "group-registration:notify-failed"));

  refreshEventStats(eventId);

  apiLogger.info(
    {
      groupId,
      eventId,
      members: createdMembers.length,
      subtotal,
      currency,
      invoiceNumber,
      payerReused: payerResult.reused,
    },
    "group-registration:created",
  );

  return {
    ok: true,
    group: {
      groupId,
      billingAccountId: billingAccount.id,
      memberCount: createdMembers.length,
      subtotal,
      currency,
      invoiceNumber,
      members: createdMembers.map((m) => ({
        registrationId: m.registrationId,
        serialId: m.serialId,
        email: m.email,
        firstName: m.firstName,
        lastName: m.lastName,
        ticketTypeName: m.ticketTypeName,
        price: m.price,
      })),
    },
  };
}

// ── Coordinator confirmation email ───────────────────────────────────────────

async function sendCoordinatorConfirmation(args: {
  groupId: string;
  event: {
    id: string;
    emailFromAddress: string | null;
    emailFromName: string | null;
  } & ConfirmationEventRow;
  coordinator: { name: string; email: string };
  payerName: string;
  members: Array<{ firstName: string; lastName: string; email: string; ticketTypeName: string }>;
  subtotal: number;
  currency: string;
  invoiceNumber: string | null;
  taxRate: number | null;
}): Promise<void> {
  const { event, coordinator, members } = args;
  const taxAmount = args.taxRate ? round2(args.subtotal * (args.taxRate / 100)) : 0;
  const total = round2(args.subtotal + taxAmount);

  const memberSummary = `<table style="width: 100%; border-collapse: collapse; font-size: 14px;">${members
    .map(
      (m) =>
        `<tr><td style="padding: 6px 0; border-bottom: 1px solid #e5e7eb;">${escapeHtml(`${m.firstName} ${m.lastName}`)}</td><td style="padding: 6px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280;">${escapeHtml(m.email)}</td><td style="padding: 6px 0; border-bottom: 1px solid #e5e7eb;">${escapeHtml(m.ticketTypeName)}</td></tr>`,
    )
    .join("")}</table>`;
  const memberSummaryText = members
    .map((m) => `- ${m.firstName} ${m.lastName} (${m.email}) — ${m.ticketTypeName}`)
    .join("\n");

  const dbTpl = await getEventTemplate(event.id, "group-registration-confirmation");
  const defTpl = getDefaultTemplate("group-registration-confirmation");
  const tpl = dbTpl ?? defTpl;
  if (!tpl) {
    apiLogger.error({ eventId: event.id }, "group-registration:coordinator-template-missing");
    return;
  }
  const branding = dbTpl?.branding ?? {
    eventName: event.name,
    emailFromAddress: event.emailFromAddress,
    emailFromName: event.emailFromName,
  };

  const eventDate = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(event.startDate));

  const rendered = renderAndWrap(
    tpl,
    {
      coordinatorName: coordinator.name,
      eventName: event.name,
      eventDate,
      eventVenue: [event.venue, event.city].filter(Boolean).join(", "),
      payerName: args.payerName,
      memberCount: members.length,
      memberSummary,
      memberSummaryText,
      totalAmount: `${args.currency} ${total.toFixed(2)}`,
      invoiceNumber: args.invoiceNumber ?? "",
      // My Group portal. Falls back to the event's public page rather than
      // minting a broken `/e//my-group` when the slug is somehow absent —
      // the session-proposal email-link lesson.
      manageGroupLink: event.slug
        ? `${appUrl()}/e/${event.slug}/my-group`
        : appUrl(),
    },
    branding,
  );

  await sendEmail({
    to: [{ email: coordinator.email, name: coordinator.name }],
    from: brandingFrom(branding),
    subject: rendered.subject,
    htmlContent: rendered.htmlContent,
    textContent: rendered.textContent,
    emailType: "group-registration-confirmation",
    stream: "transactional",
    logContext: {
      organizationId: event.organizationId ?? null,
      eventId: event.id,
      // entityId = the group (review L9) so the group's email history is
      // queryable per-entity, matching the invoice email's convention.
      entityType: "OTHER",
      entityId: args.groupId,
      templateSlug: "group-registration-confirmation",
    },
  });
}

// ── H4: group-invoice drift on member cancellation ───────────────────────────

/**
 * A group's consolidated invoice freezes its totals at issue, but its line
 * items derive from live (non-cancelled) members — cancelling/deleting a
 * member makes the document internally inconsistent until finance acts
 * (review H4). This flags it: warn log + admin notification per affected
 * group. Fire-and-forget contract — NEVER throws (the cancellation already
 * committed); call with the ids BEFORE the rows are deleted.
 */
export async function flagGroupInvoiceDriftForCancelledMembers(
  eventId: string,
  registrationIds: string[],
): Promise<void> {
  try {
    if (registrationIds.length === 0) return;
    const members = await db.registration.findMany({
      where: { id: { in: registrationIds }, eventId, groupId: { not: null } },
      select: {
        groupId: true,
        attendee: { select: { firstName: true, lastName: true } },
        group: {
          select: {
            billingAccount: { select: { name: true } },
            invoices: { where: { status: { notIn: ["CANCELLED"] } }, select: { invoiceNumber: true }, take: 1 },
          },
        },
      },
    });
    const byGroup = new Map<string, { names: string[]; payer: string; invoiceNumber: string | null }>();
    for (const m of members) {
      if (!m.groupId) continue;
      const cur = byGroup.get(m.groupId) ?? {
        names: [],
        payer: m.group?.billingAccount.name ?? "the payer",
        invoiceNumber: m.group?.invoices[0]?.invoiceNumber ?? null,
      };
      cur.names.push(`${m.attendee.firstName} ${m.attendee.lastName}`.trim());
      byGroup.set(m.groupId, cur);
    }
    for (const [groupId, info] of byGroup) {
      apiLogger.warn(
        { groupId, eventId, cancelledMembers: info.names, invoiceNumber: info.invoiceNumber },
        "group-registration:member-cancelled-invoice-drift",
      );
      notifyEventAdmins(eventId, {
        type: "REGISTRATION",
        title: "⚠ Group invoice no longer matches its members",
        message: `${info.names.join(", ")} cancelled from a group registration billed to ${info.payer}${info.invoiceNumber ? ` (invoice ${info.invoiceNumber})` : ""}. The invoice total still includes them — issue a credit note or reissue the invoice.`,
        link: `/events/${eventId}/invoices`,
      }).catch((err) =>
        apiLogger.error({ err, groupId }, "group-registration:drift-notify-failed"),
      );
    }
  } catch (err) {
    apiLogger.error({ err, eventId }, "group-registration:drift-flag-failed");
  }
}

// ── Adding members to an existing group (Phase 3b) ───────────────────────────

export interface AddGroupMembersInput {
  groupId: string;
  /** The signed-in coordinator — ownership, and the only way in. */
  coordinatorUserId: string;
  members: GroupMemberInput[];
  requestIp?: string | null;
}

export type AddGroupMembersErrorCode =
  | "GROUP_NOT_FOUND"
  | "NO_MEMBERS"
  | "GROUP_SIZE_OUT_OF_BOUNDS"
  | "TICKET_TYPE_NOT_FOUND"
  | "TICKET_TYPE_IS_FACULTY"
  | "SALES_NOT_STARTED"
  | "SALES_ENDED"
  | "DUPLICATE_IN_GROUP"
  | "ALREADY_REGISTERED"
  | "SOLD_OUT"
  | "EVENT_FULL"
  | "MIXED_CURRENCY"
  | "UNKNOWN";

export interface AddGroupMembersSummary {
  groupId: string;
  addedCount: number;
  /** The invoice raised for this addition, if one could be raised. */
  invoiceNumber: string | null;
  /** True when an unpaid invoice was cancelled and reissued rather than a
   *  supplementary one being added alongside a settled invoice. */
  reissued: boolean;
  members: Array<{
    registrationId: string;
    serialId: number | null;
    email: string;
    firstName: string;
    lastName: string;
    ticketTypeName: string;
    price: number;
  }>;
}

export type AddGroupMembersResult =
  | { ok: true; result: AddGroupMembersSummary }
  | {
      ok: false;
      code: AddGroupMembersErrorCode;
      message: string;
      meta?: Record<string, unknown>;
    };

/**
 * Add members to a group the coordinator already owns.
 *
 * Money model — the whole reason this is not just "create N registrations":
 *
 *   Each group invoice records WHICH members it bills
 *   (`Invoice.coveredRegistrationIds`). After the new rows are created, the
 *   people already covered by a SETTLED invoice are subtracted, any
 *   still-outstanding invoice is cancelled, and ONE new invoice is raised for
 *   whoever is left. That single rule covers all four situations without
 *   branching on them:
 *
 *     - nothing invoiced yet (create-time invoice failed) → bills everyone
 *     - one unpaid invoice                                → cancel + reissue for everyone
 *     - one paid invoice                                  → supplementary for the new arrivals only
 *     - a paid one AND a later unpaid one                 → cancel the unpaid,
 *       bill the new arrivals plus whoever the unpaid one covered — never the
 *       people who already paid
 *
 * An invoice with an EMPTY covered set predates this column and means "every
 * member that existed at the time", so the set captured before the add is used
 * for it. Cancelling and reissuing is only ever done to an UNPAID invoice — a
 * settled one is a historical record with money booked against it.
 */
export async function addGroupMembers(
  input: AddGroupMembersInput,
): Promise<AddGroupMembersResult> {
  const { groupId, coordinatorUserId } = input;

  if (input.members.length === 0) {
    return { ok: false, code: "NO_MEMBERS", message: "No members to add." };
  }

  // 1. Load + ownership. Bound on coordinatorUserId, NOT organizationId: a
  //    REGISTRANT is org-null by design, so the coordinator link IS the
  //    boundary (docs/MULTI_TENANCY_IMPACT.md §8.1). A group they don't own
  //    is a 404, not a 403 — no existence leak.
  const group = await db.registrationGroup.findFirst({
    where: { id: groupId, coordinatorUserId },
    select: {
      id: true,
      eventId: true,
      organizationId: true,
      coordinatorEmail: true,
      coordinatorName: true,
      billingAccountId: true,
      payerReference: true,
      billingAccount: { select: { id: true, name: true } },
      registrations: { select: { id: true, status: true } },
    },
  });
  if (!group || !group.organizationId) {
    apiLogger.warn({ groupId, coordinatorUserId }, "group-add-members:not-found");
    return { ok: false, code: "GROUP_NOT_FOUND", message: "Group not found." };
  }
  const eventId = group.eventId;
  const organizationId = group.organizationId;

  const event = await db.event.findFirst({
    where: { id: eventId, organizationId },
    select: {
      ...CONFIRMATION_EVENT_SELECT,
      settings: true,
      id: true,
      emailFromAddress: true,
      emailFromName: true,
    },
  });
  if (!event) {
    return { ok: false, code: "GROUP_NOT_FOUND", message: "Event not found." };
  }

  // 2. Size: the cap counts LIVE members — a cancelled member frees their slot
  //    exactly as they free their seat.
  const existingBillableIds = group.registrations
    .filter((r) => r.status !== RegistrationStatus.CANCELLED)
    .map((r) => r.id);
  const settings = readGroupRegistrationSettings(event.settings);
  const nextTotal = existingBillableIds.length + input.members.length;
  if (nextTotal > GROUP_MEMBERS_HARD_CEILING) {
    return {
      ok: false,
      code: "GROUP_SIZE_OUT_OF_BOUNDS",
      message: `A group can have at most ${GROUP_MEMBERS_HARD_CEILING} members.`,
    };
  }
  if (settings.maxMembers && nextTotal > settings.maxMembers) {
    return {
      ok: false,
      code: "GROUP_SIZE_OUT_OF_BOUNDS",
      message: `This group can have at most ${settings.maxMembers} members (it currently has ${existingBillableIds.length}).`,
      meta: { maxMembers: settings.maxMembers, current: existingBillableIds.length },
    };
  }

  // 3. Normalize + in-batch duplicate check.
  const members = input.members.map((m) => ({
    ticketTypeId: m.ticketTypeId,
    attendee: {
      ...m.attendee,
      email: m.attendee.email.trim().toLowerCase(),
      additionalEmail: m.attendee.additionalEmail
        ? m.attendee.additionalEmail.trim().toLowerCase()
        : null,
    },
  }));
  const seen = new Set<string>();
  for (const m of members) {
    if (seen.has(m.attendee.email)) {
      return {
        ok: false,
        code: "DUPLICATE_IN_GROUP",
        message: `${m.attendee.email} appears more than once.`,
        meta: { email: m.attendee.email },
      };
    }
    seen.add(m.attendee.email);
  }

  // 4. Ticket types + live pricing — identical rules to the initial create
  //    (active, delegate-only, public sales window open, tier on sale NOW).
  const now = new Date();
  const distinctTypeIds = [...new Set(members.map((m) => m.ticketTypeId))];
  const ticketTypes = await db.ticketType.findMany({
    where: { id: { in: distinctTypeIds }, eventId, isActive: true },
    select: {
      id: true, name: true, price: true, currency: true,
      salesStart: true, salesEnd: true, requiresApproval: true, isFaculty: true,
      pricingTiers: {
        where: { isActive: true },
        select: {
          id: true, name: true, price: true, currency: true,
          quantity: true, soldCount: true, isActive: true,
          salesStart: true, salesEnd: true, sortOrder: true,
        },
      },
    },
  });
  const typeById = new Map(ticketTypes.map((t) => [t.id, t]));
  for (const id of distinctTypeIds) {
    const t = typeById.get(id);
    if (!t) {
      return {
        ok: false, code: "TICKET_TYPE_NOT_FOUND",
        message: "One of the selected registration types was not found or is inactive.",
        meta: { ticketTypeId: id },
      };
    }
    if (t.isFaculty) {
      return {
        ok: false, code: "TICKET_TYPE_IS_FACULTY",
        message: `"${t.name}" is reserved for speakers and cannot be used for group members.`,
        meta: { ticketTypeId: id },
      };
    }
    if (t.salesStart && new Date(t.salesStart) > now) {
      return {
        ok: false, code: "SALES_NOT_STARTED",
        message: `Sales for "${t.name}" have not started yet.`,
        meta: { ticketTypeId: id },
      };
    }
    if (t.salesEnd && new Date(t.salesEnd) < now) {
      return {
        ok: false, code: "SALES_ENDED",
        message: `Sales for "${t.name}" have ended.`,
        meta: { ticketTypeId: id },
      };
    }
  }

  // Currency must match the GROUP's, not merely be internally consistent — a
  // company is billed in one currency, and the existing invoice already
  // committed to it.
  const groupCurrency =
    (await db.registration.findFirst({
      where: { groupId, status: { not: RegistrationStatus.CANCELLED } },
      select: { ticketType: { select: { currency: true } } },
      orderBy: { createdAt: "asc" },
    }))?.ticketType?.currency ?? null;
  const currencies = [...new Set(ticketTypes.map((t) => t.currency ?? "USD"))];
  if (groupCurrency) currencies.push(groupCurrency);
  const distinctCurrencies = [...new Set(currencies)];
  if (distinctCurrencies.length > 1) {
    return {
      ok: false, code: "MIXED_CURRENCY",
      message: `This group is billed in ${groupCurrency}; the selected registration types use ${distinctCurrencies.filter((c) => c !== groupCurrency).join(", ")}.`,
      meta: { currencies: distinctCurrencies },
    };
  }

  const pricingByType = new Map<string, ResolvedTypePricing>();
  for (const t of ticketTypes) {
    const tier = pickCurrentPricingTier(t.pricingTiers, now);
    pricingByType.set(t.id, {
      tierId: tier?.id ?? null,
      tierName: tier?.name ?? null,
      price: Number(tier?.price ?? t.price),
      name: t.name,
      currency: t.currency ?? "USD",
      requiresApproval: t.requiresApproval,
    });
  }

  // 5. The transaction: dup check → seat claims → rows.
  let createdMembers: CreatedMemberRow[];
  try {
    createdMembers = await tenantTransaction(async (tx) => {
      // Same advisory-lock key as the initial create, so a coordinator
      // double-clicking Add cannot race their own submission past the
      // read-based duplicate check below.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`group-register:${eventId}:${group.coordinatorEmail}`}))::text`;

      const existing = await tx.registration.findFirst({
        where: {
          eventId,
          status: { notIn: [RegistrationStatus.CANCELLED] },
          attendee: {
            email: { in: members.map((m) => m.attendee.email), mode: "insensitive" },
          },
        },
        select: { attendee: { select: { email: true } } },
      });
      if (existing) {
        throw new GroupServiceSentinel("ALREADY_REGISTERED", {
          email: existing.attendee?.email,
        });
      }

      return claimSeatsAndCreateMembers(tx, {
        eventId,
        organizationId,
        groupId,
        members,
        pricingByType,
        billingAccountId: group.billingAccountId,
        payerReference: group.payerReference,
        coordinatorEmail: group.coordinatorEmail,
        coordinatorUserId,
      });
    }, { timeout: 30_000, maxWait: 10_000 });
  } catch (err) {
    if (err instanceof GroupServiceSentinel) {
      const messages: Record<string, string> = {
        ALREADY_REGISTERED: `${err.meta.email} is already registered for this event.`,
        SOLD_OUT: `"${err.meta.ticketTypeName ?? "A registration type"}" sold out — not enough seats.`,
        EVENT_FULL: "This event has reached its maximum number of attendees.",
      };
      apiLogger.warn(
        { code: err.code, meta: err.meta, groupId, members: members.length },
        "group-add-members:rejected",
      );
      return {
        ok: false,
        code: err.code as AddGroupMembersErrorCode,
        message: messages[err.code] ?? err.code,
        meta: err.meta,
      };
    }
    apiLogger.error({ err, groupId }, "group-add-members:failed");
    return {
      ok: false,
      code: "UNKNOWN",
      message: err instanceof Error ? err.message : "Failed to add members",
    };
  }

  const newIds = createdMembers.map((m) => m.registrationId);

  // ── Post-commit side effects (each failure-isolated — the members stand) ──

  let invoiceNumber: string | null = null;
  let reissued = false;
  try {
    const invoices = await db.invoice.findMany({
      where: { groupId, type: "INVOICE", status: { not: "CANCELLED" } },
      select: { id: true, status: true, coveredRegistrationIds: true },
    });

    // An empty covered set predates the column and means "everyone who
    // existed then" — i.e. the members present before this add.
    const coveredBy = (inv: { coveredRegistrationIds: string[] }) =>
      inv.coveredRegistrationIds.length > 0
        ? inv.coveredRegistrationIds
        : existingBillableIds;

    const settledIds = new Set(
      invoices.filter((i) => i.status === "PAID").flatMap(coveredBy),
    );
    const outstanding = invoices.filter((i) => i.status !== "PAID");

    // Only ever cancel an UNPAID invoice; a settled one stays untouched.
    for (const inv of outstanding) {
      // organizationId compound-wheres the transition (defence #1), so a
      // cross-org invoice id could not be cancelled here even if the lookup
      // above were ever loosened.
      await cancelInvoice(inv.id, {
        source: "rest",
        actorUserId: coordinatorUserId,
        organizationId,
        ip: input.requestIp ?? null,
      });
      reissued = true;
    }

    const toBill = [...existingBillableIds, ...newIds].filter(
      (id) => !settledIds.has(id),
    );
    if (toBill.length > 0) {
      const invoice = await createGroupInvoice({
        groupId,
        eventId,
        organizationId,
        registrationIds: toBill,
      });
      invoiceNumber = invoice.invoiceNumber;
      try {
        await sendGroupInvoiceEmail(invoice.id);
      } catch (err) {
        apiLogger.error({ err, groupId, invoiceId: invoice.id }, "group-add-members:invoice-email-failed");
      }
    }
  } catch (err) {
    apiLogger.error({ err, groupId }, "group-add-members:invoice-failed");
    notifyEventAdmins(eventId, {
      type: "REGISTRATION",
      title: "⚠ Group invoice not raised for added members",
      message: `${createdMembers.length} member(s) were added to a group (coordinator ${group.coordinatorName}) but the invoice failed — raise one manually.`,
      link: `/events/${eventId}/registrations`,
    }).catch((e) => apiLogger.error({ err: e, groupId }, "group-add-members:invoice-fail-notify-failed"));
  }

  // Member confirmations — same shape as the initial create: barcode included,
  // Pay Now replaced by "covered by {payer}", no quote PDF.
  const eventRow = event as unknown as ConfirmationEventRow;
  for (const m of createdMembers) {
    sendRegistrationConfirmationEmail({
      event: eventRow,
      registration: { id: m.registrationId, serialId: m.serialId, qrCode: m.qrCode },
      attendee: {
        email: m.email,
        additionalEmail: m.attendee.additionalEmail ?? null,
        firstName: m.firstName,
        lastName: m.lastName,
        title: m.attendee.title ?? null,
        organization: m.attendee.organization ?? null,
        jobTitle: m.attendee.jobTitle ?? null,
        city: m.attendee.city ?? null,
        country: m.attendee.country ?? null,
      },
      ticketTypeName: m.ticketTypeName,
      ticketCurrency: m.currency,
      price: m.price,
      attendanceMode: AttendanceMode.IN_PERSON,
      coveredByGroupPayerName: group.billingAccount?.name ?? null,
      logKey: "group-add-members:member-confirmation-failed",
    });

    await syncToContact({
      organizationId,
      eventId,
      email: m.email,
      firstName: m.firstName,
      lastName: m.lastName,
      title: m.attendee.title ?? null,
      role: m.attendee.role ?? null,
      additionalEmail: m.attendee.additionalEmail ?? null,
      organization: m.attendee.organization ?? null,
      jobTitle: m.attendee.jobTitle ?? null,
      phone: m.attendee.phone ?? null,
      city: m.attendee.city ?? null,
      state: m.attendee.state ?? null,
      zipCode: m.attendee.zipCode ?? null,
      country: m.attendee.country ?? null,
      specialty: m.attendee.specialty ?? null,
      customSpecialty: m.attendee.customSpecialty ?? null,
      registrationType: m.ticketTypeName,
    });
  }

  db.auditLog
    .create({
      data: {
        organizationId,
        eventId,
        userId: coordinatorUserId,
        action: "CREATE",
        entityType: "RegistrationGroup",
        entityId: groupId,
        changes: {
          source: "group-portal-add-members",
          addedCount: createdMembers.length,
          registrationIds: newIds,
          invoiceNumber,
          reissuedOutstandingInvoice: reissued,
        },
        ipAddress: input.requestIp ?? null,
      },
    })
    .catch((err) => apiLogger.error({ err, groupId }, "group-add-members:audit-failed"));

  notifyEventAdmins(eventId, {
    type: "REGISTRATION",
    title: "Members added to a group",
    message: `${createdMembers.length} member(s) added to ${group.coordinatorName}'s group${invoiceNumber ? ` — invoice ${invoiceNumber}` : ""}.`,
    link: `/events/${eventId}/registrations`,
  }).catch((err) => apiLogger.error({ err, groupId }, "group-add-members:notify-failed"));

  refreshEventStats(eventId);

  apiLogger.info(
    { groupId, added: createdMembers.length, invoiceNumber, reissued },
    "group-add-members:done",
  );

  return {
    ok: true,
    result: {
      groupId,
      addedCount: createdMembers.length,
      invoiceNumber,
      reissued,
      members: createdMembers.map((m) => ({
        registrationId: m.registrationId,
        serialId: m.serialId,
        email: m.email,
        firstName: m.firstName,
        lastName: m.lastName,
        ticketTypeName: m.ticketTypeName,
        price: m.price,
      })),
    },
  };
}
