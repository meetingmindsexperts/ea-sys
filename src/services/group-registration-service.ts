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
 * Seat accounting: GROUP_REGISTER rows count on the TICKET-TYPE counter (the
 * seat model routes only PUBLIC_REGISTER+tier rows to the tier counter), so
 * the claim here is per-type `claimSeats` + one event-wide `claimEventSeats`,
 * all-or-nothing inside the same transaction — sold-out mid-group rolls the
 * whole group back.
 */
import {
  PaymentStatus,
  RegistrationStatus,
  AttendanceMode,
} from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { generateBarcode } from "@/lib/utils";
import { getNextSerialId } from "@/lib/registration-serial";
import { claimSeats, claimEventSeats } from "@/lib/registration-seat-db";
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
import { createGroupInvoice, sendGroupInvoiceEmail } from "@/lib/invoice-service";
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
    { tierId: string | null; price: number; name: string; currency: string; requiresApproval: boolean }
  >();
  for (const t of ticketTypes) {
    const tier = pickCurrentPricingTier(t.pricingTiers, now);
    pricingByType.set(t.id, {
      tierId: tier?.id ?? null,
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
  type CreatedMemberRow = {
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

      // All-or-nothing seat claims: per-type counts, then the event-wide cap.
      const countByType = new Map<string, number>();
      for (const m of members) {
        countByType.set(m.ticketTypeId, (countByType.get(m.ticketTypeId) ?? 0) + 1);
      }
      for (const [typeId, count] of countByType) {
        const claimed = await claimSeats(tx, { kind: "ticketType", id: typeId }, count);
        if (!claimed) {
          throw new GroupServiceSentinel("SOLD_OUT", {
            ticketTypeId: typeId,
            ticketTypeName: pricingByType.get(typeId)?.name,
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
            groupId: group.id,
            ticketTypeId: m.ticketTypeId,
            pricingTierId: pricing.tierId,
            attendeeId: attendeeRecord.id,
            // The coordinator's own member row links their account so it
            // shows in /my-registration; other members are account-less.
            userId:
              a.email === coordinatorEmail ? input.coordinatorUserId : null,
            serialId,
            createdSource: "GROUP_REGISTER",
            status: pricing.requiresApproval
              ? RegistrationStatus.PENDING
              : RegistrationStatus.CONFIRMED,
            // The payer owes (pay-later v1): UNPAID until the group settles.
            paymentStatus: PaymentStatus.UNPAID,
            attendanceMode: AttendanceMode.IN_PERSON,
            billingAccountId: billingAccount.id,
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
