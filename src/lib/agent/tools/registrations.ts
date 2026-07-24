import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { parseDateRangeFilters } from "@/lib/date-range-filter";
import { getNextSerialId } from "@/lib/registration-serial";
import { generateBarcode, normalizeTag } from "@/lib/utils";
import { holdsSeat, seatCounter, type SeatCounter } from "@/lib/registration-seat";
import {
  claimPromoUsage,
  claimSeatsOverselling,
  incrementEventSeatsOverselling,
  releaseEventSeats,
  releasePromoUsage,
  releaseSeats,
} from "@/lib/registration-seat-db";
import { syncToContact } from "@/lib/contact-sync";
import { checkInGate, executeCheckIn } from "@/lib/check-in";
import { refreshEventStats } from "@/lib/event-stats";
import { expireOpenCheckoutSessionOnCancel } from "@/lib/checkout-session-cleanup";
import { notifyEventAdmins } from "@/lib/notifications";
import {
  CONFIRMATION_EVENT_SELECT,
  createRegistration,
  sendRegistrationConfirmationEmail,
  updateRegistration as updateRegistrationService,
  type ManualPaymentStatus,
  type ManualRegistrationStatus,
  type RegistrationAttendeeRole,
  type RegistrationTitle,
} from "@/services/registration-service";
import {
  EMAIL_RE,
  TITLE_VALUES,
  REGISTRATION_STATUSES,
  MANUAL_REGISTRATION_STATUSES,
  ALL_PAYMENT_STATUSES,
  ADMIN_SETTABLE_PAYMENT_STATUSES,
  PAYMENT_STATUS_WRITE_REJECTION,
  type ToolExecutor,
} from "./_shared";
const UNPAID_STATUSES = ["UNPAID", "PENDING", "FAILED"];
const BULK_MAX = 100;

// Mirrors Prisma's AttendeeRole enum. Listed here so MCP input validation
// doesn't need to reach into @prisma/client at runtime.
const ATTENDEE_ROLE_VALUES = new Set([
  "ACADEMIA", "ALLIED_HEALTH", "MEDICAL_DEVICES", "PHARMA",
  "PHYSICIAN", "RESIDENT", "SPEAKER", "STUDENT", "OTHERS",
]);

// RFC-light email regex, shared with other MCP inputs via EMAIL_RE.
// Duplicated tolerance here because additionalEmail is optional and the
// simplest "empty OR valid" check is clearer inline than a Zod wrapper.

const listRegistrations: ToolExecutor = async (input, ctx) => {
  try {
    const limit = Math.min(Number(input.limit ?? 50), 200);
    const statusValue = input.status ? String(input.status) : undefined;
    if (statusValue && !REGISTRATION_STATUSES.has(statusValue)) {
      return { error: `Invalid status "${statusValue}". Must be one of: ${[...REGISTRATION_STATUSES].join(", ")}` };
    }
    // Use the single Prisma-derived set (was a local hardcoded list missing
    // UNASSIGNED + INCLUSIVE, so the agent couldn't filter the list by
    // sponsor-paid / payment-pending registrations).
    const paymentStatusValue = input.paymentStatus ? String(input.paymentStatus) : undefined;
    if (paymentStatusValue && !ALL_PAYMENT_STATUSES.has(paymentStatusValue)) {
      return { error: `Invalid paymentStatus "${paymentStatusValue}". Must be one of: ${[...ALL_PAYMENT_STATUSES].join(", ")}` };
    }
    // Incremental-sync date filters (shared parser with the REST GETs). An
    // invalid value is a tool error, never a silently-dropped filter.
    const dateRange = parseDateRangeFilters((k) => (input[k] == null ? null : String(input[k])));
    if (!dateRange.ok) {
      return { error: dateRange.message, code: "INVALID_DATE_FILTER" };
    }
    const registrations = await db.registration.findMany({
      where: {
        eventId: ctx.eventId,
        ...(statusValue ? { status: statusValue as never } : {}),
        ...(paymentStatusValue ? { paymentStatus: paymentStatusValue as never } : {}),
        ...(input.ticketTypeId
          ? { ticketTypeId: String(input.ticketTypeId) }
          : {}),
        ...dateRange.where,
      },
      select: {
        id: true,
        status: true,
        paymentStatus: true,
        createdAt: true,
        updatedAt: true,
        // Check-in + badge analytics fields so the agent can read who's
        // arrived and whose badge has been printed without a second call.
        checkedInAt: true,
        badgePrintedAt: true,
        badgePrintCount: true,
        // Barcodes — qrCode is the entry/check-in value; dtcmBarcode is the
        // Dubai compliance code (present only on flagged events).
        qrCode: true,
        dtcmBarcode: true,
        attendee: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
            // Secondary CC inbox the registrant supplied.
            additionalEmail: true,
            organization: true,
            // Profile fields n8n needs to sync attendees to a CRM.
            jobTitle: true,
            country: true,
            role: true,
            bio: true,
            photo: true,
          },
        },
        // isFaculty flags speaker companion registrations so MCP clients can
        // distinguish faculty (attend-ready speakers) from real delegates.
        ticketType: { select: { name: true, isFaculty: true } },
      },
      take: limit,
      orderBy: { createdAt: "desc" },
    });
    return { registrations, total: registrations.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_registrations failed");
    return { error: "Failed to fetch registrations" };
  }
};

const listTicketTypes: ToolExecutor = async (_input, ctx) => {
  try {
    const ticketTypes = await db.ticketType.findMany({
      where: { eventId: ctx.eventId },
      select: {
        id: true,
        name: true,
        description: true,
        isDefault: true,
        _count: { select: { registrations: true } },
      },
      orderBy: { sortOrder: "asc" },
    });
    return { ticketTypes, total: ticketTypes.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_ticket_types failed");
    return { error: "Failed to fetch ticket types" };
  }
};

const createTicketType: ToolExecutor = async (input, ctx) => {
  try {
    const name = String(input.name ?? "").trim();
    if (!name) return { error: "Ticket type name is required" };

    // Check for duplicate (case-insensitive)
    const existing = await db.ticketType.findFirst({
      where: { eventId: ctx.eventId, name: { equals: name, mode: "insensitive" } },
      select: { id: true, name: true },
    });
    if (existing) {
      return {
        alreadyExists: true,
        ticketType: existing,
        message: `A ticket type named "${existing.name}" already exists for this event.`,
      };
    }

    // Get next sort order
    const maxOrder = await db.ticketType.findFirst({
      where: { eventId: ctx.eventId },
      select: { sortOrder: true },
      orderBy: { sortOrder: "desc" },
    });
    const sortOrder = (maxOrder?.sortOrder ?? -1) + 1;

    const ticketType = await db.ticketType.create({
      data: {
        eventId: ctx.eventId,
        name,
        description: input.description ? String(input.description) : null,
        isDefault: input.isDefault === true,
        isActive: true,
        sortOrder,
        pricingTiers: {
          create: [
            { name: "Early Bird", price: 0, currency: "USD", isActive: false, sortOrder: 0 },
            { name: "Standard",   price: 0, currency: "USD", isActive: false, sortOrder: 1 },
            { name: "Onsite",     price: 0, currency: "USD", isActive: false, sortOrder: 2 },
          ],
        },
      },
      select: {
        id: true,
        name: true,
        isActive: true,
        pricingTiers: { select: { id: true, name: true, price: true, isActive: true } },
      },
    });

    return {
      success: true,
      ticketType,
      message:
        "Ticket type created with 3 inactive pricing tiers (Early Bird, Standard, Onsite) at $0. Go to Settings → Registration Types to set prices and activate tiers.",
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_ticket_type failed");
    return { error: "Failed to create ticket type" };
  }
};

const createRegistrationTool: ToolExecutor = async (input, ctx) => {
  try {
    const email = String(input.email ?? "").trim().toLowerCase();
    const firstName = String(input.firstName ?? "").trim();
    const lastName = String(input.lastName ?? "").trim();
    const ticketTypeId = String(input.ticketTypeId ?? "").trim();

    if (!email || !firstName || !lastName || !ticketTypeId) {
      return { error: "email, firstName, lastName, and ticketTypeId are all required" };
    }
    if (!EMAIL_RE.test(email)) return { error: "Invalid email format" };

    // MCP-side input validation (fast-fail before service call). Stays in
    // the tool layer — service trusts its typed inputs per convention.
    const rawStatus = input.status ? String(input.status) : "CONFIRMED";
    if (!MANUAL_REGISTRATION_STATUSES.has(rawStatus)) {
      return { error: `Invalid status "${rawStatus}". Must be one of: ${[...MANUAL_REGISTRATION_STATUSES].join(", ")}` };
    }
    const rawTitle = input.title ? String(input.title) : undefined;
    if (rawTitle && !TITLE_VALUES.has(rawTitle)) {
      return { error: `Invalid title "${rawTitle}". Must be one of: ${[...TITLE_VALUES].join(", ")}` };
    }
    const rawRole = input.role ? String(input.role) : undefined;
    if (rawRole && !ATTENDEE_ROLE_VALUES.has(rawRole)) {
      return { error: `Invalid role "${rawRole}". Must be one of: ${[...ATTENDEE_ROLE_VALUES].join(", ")}` };
    }
    const rawAdditionalEmail = input.additionalEmail
      ? String(input.additionalEmail).trim().toLowerCase()
      : undefined;
    if (rawAdditionalEmail && !EMAIL_RE.test(rawAdditionalEmail)) {
      return { error: `Invalid additionalEmail format "${rawAdditionalEmail}"` };
    }

    const rawMode = input.attendanceMode ? String(input.attendanceMode).toUpperCase() : undefined;
    if (rawMode && rawMode !== "IN_PERSON" && rawMode !== "VIRTUAL") {
      return { error: `Invalid attendanceMode "${rawMode}". Must be IN_PERSON or VIRTUAL.` };
    }

    const result = await createRegistration({
      eventId: ctx.eventId,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      ticketTypeId,
      pricingTierId: input.pricingTierId ? String(input.pricingTierId) : undefined,
      attendanceMode: rawMode as "IN_PERSON" | "VIRTUAL" | undefined,
      attendee: {
        title: (rawTitle as RegistrationTitle | undefined) ?? null,
        role: (rawRole as RegistrationAttendeeRole | undefined) ?? null,
        email,
        additionalEmail: rawAdditionalEmail ?? null,
        firstName,
        lastName,
        organization: input.organization ? String(input.organization) : null,
        jobTitle: input.jobTitle ? String(input.jobTitle) : null,
        phone: input.phone ? String(input.phone) : null,
        city: input.city ? String(input.city) : null,
        state: input.state ? String(input.state) : null,
        zipCode: input.zipCode ? String(input.zipCode) : null,
        country: input.country ? String(input.country) : null,
        specialty: input.specialty ? String(input.specialty) : null,
        customSpecialty: input.customSpecialty ? String(input.customSpecialty) : null,
        associationName: input.associationName ? String(input.associationName) : null,
        memberId: input.memberId ? String(input.memberId) : null,
        studentId: input.studentId ? String(input.studentId) : null,
        // Service accepts string | Date | null; pass through as-is, the
        // service parses ISO strings and tolerates invalid dates by
        // setting the field to null.
        studentIdExpiry: input.studentIdExpiry ? String(input.studentIdExpiry) : null,
      },
      status: rawStatus as ManualRegistrationStatus,
      paymentStatus: input.paymentStatus as ManualPaymentStatus | undefined,
      // Sponsor attribution — required when paymentStatus = INCLUSIVE. Service
      // returns INCLUSIVE_REQUIRES_SPONSOR / SPONSOR_NOT_FOUND with the
      // available-sponsors list in meta so Claude can self-correct.
      sponsorId: input.sponsorId ? String(input.sponsorId) : null,
      // "Charge to another account" — service validates the id is an active
      // BillingAccount in the event's org (BILLING_ACCOUNT_NOT_FOUND /
      // BILLING_ACCOUNT_INACTIVE). Orthogonal to paymentStatus.
      billingAccountId: input.billingAccountId ? String(input.billingAccountId) : null,
      payerReference: input.payerReference ? String(input.payerReference) : null,
      attendeeIsGuarantor:
        typeof input.attendeeIsGuarantor === "boolean" ? input.attendeeIsGuarantor : undefined,
      source: "mcp",
    });

    if (!result.ok) {
      // Preserve the MCP auto-pivot hint on duplicate so Claude knows to
      // call update_registration instead of retrying. Preserve the
      // ticketType hint on NOT_FOUND so Claude knows to call list_ticket_types.
      if (result.code === "ALREADY_REGISTERED") {
        return {
          alreadyExists: true,
          existingRegistrationId: result.meta?.existingRegistrationId,
          message: `A registration for ${email} already exists for this event.`,
          suggestion: "Use update_registration with registrationId to modify this registration",
        };
      }
      if (result.code === "TICKET_TYPE_NOT_FOUND") {
        return {
          error: "Ticket type not found or inactive. Use list_ticket_types to get valid IDs.",
          code: result.code,
        };
      }
      if (result.code === "EVENT_NOT_FOUND") {
        return { error: "Event not found or access denied", code: result.code };
      }
      return { error: result.message, code: result.code, ...(result.meta ?? {}) };
    }

    // Preserve the pre-refactor MCP response shape: { success, attendee: { slim },
    // registration: { slim } }. Reshape the service's full return payload.
    const { registration } = result;
    return {
      success: true,
      attendee: {
        id: registration.attendee.id,
        firstName: registration.attendee.firstName,
        lastName: registration.attendee.lastName,
        email: registration.attendee.email,
      },
      registration: {
        id: registration.id,
        status: registration.status,
        paymentStatus: registration.paymentStatus,
        serialId: registration.serialId,
        qrCode: registration.qrCode,
        ticketType: registration.ticketType
          ? { name: registration.ticketType.name }
          : null,
      },
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_registration failed");
    return { error: "Failed to create registration" };
  }
};

// Shares the SAME business gate + commit fan-out as the two REST check-in
// handlers via src/lib/check-in.ts (review H9 — this executor used to skip
// the payment gate, write no audit row, and its allowCancelled override
// reactivated outside the seat/promo transition).
const checkInRegistration: ToolExecutor = async (input, ctx) => {
  try {
    const registrationId = String(input.registrationId ?? "").trim();
    const allowCancelled = Boolean(input.allowCancelled);
    if (!registrationId) return { error: "registrationId is required" };

    const reg = await db.registration.findFirst({
      where: { id: registrationId, eventId: ctx.eventId },
      select: {
        id: true, status: true, paymentStatus: true, checkedInAt: true,
        attendanceMode: true, ticketTypeId: true, pricingTierId: true,
        createdSource: true, promoCodeId: true,
        ticketType: { select: { price: true } },
        pricingTier: { select: { price: true } },
        attendee: { select: { firstName: true, lastName: true } },
      },
    });
    if (!reg) return { error: `Registration ${registrationId} not found` };
    if (reg.checkedInAt) return { alreadyCheckedIn: true, checkedInAt: reg.checkedInAt, attendee: reg.attendee };

    const gate = checkInGate(
      {
        status: reg.status,
        paymentStatus: reg.paymentStatus,
        checkedInAt: reg.checkedInAt,
        ticketTypePrice: reg.ticketType?.price,
        pricingTierPrice: reg.pricingTier?.price,
      },
      { allowCancelled },
    );
    if (gate?.code === "CANCELLED") {
      return {
        error: `Registration ${registrationId} is CANCELLED. Reinstate it (set status to CONFIRMED) before checking in, or pass allowCancelled=true to override.`,
        code: "REGISTRATION_CANCELLED",
        currentStatus: reg.status,
        suggestion: "update_registration with status=CONFIRMED, then retry check_in_registration.",
      };
    }
    if (gate?.code === "PAYMENT_REQUIRED") {
      // Same gate the desk enforces — an agent bulk check-in must not admit
      // unpaid attendees the desk would refuse.
      apiLogger.warn({ msg: "agent:check-in-payment-required", registrationId, source: "mcp" });
      return {
        error: "Cannot check in — payment required (unpaid/pending registration). Settle or comp it first.",
        code: "PAYMENT_REQUIRED",
        paymentStatus: reg.paymentStatus,
      };
    }

    // The CANCELLED override is a REACTIVATION — it must move the seat +
    // promo counters through the shared transition (atomic capacity guard),
    // not flip status via a raw update.
    const reactivating = reg.status === "CANCELLED";
    const seatFields = {
      attendanceMode: reg.attendanceMode,
      ticketTypeId: reg.ticketTypeId,
      pricingTierId: reg.pricingTierId,
      createdSource: reg.createdSource,
    };
    const updated = await executeCheckIn({
      eventId: ctx.eventId,
      registrationId,
      actorUserId: ctx.userId ?? null,
      attendeeName: `${reg.attendee?.firstName ?? ""} ${reg.attendee?.lastName ?? ""}`.trim(),
      source: "mcp",
      auditExtras: reactivating ? { allowCancelledOverride: true } : undefined,
      reactivation: reactivating
        ? {
            prev: { status: reg.status, ...seatFields },
            next: { status: "CHECKED_IN", ...seatFields },
            promoCodeId: reg.promoCodeId,
            eventId: ctx.eventId,
          }
        : undefined,
    });

    return { success: true, attendee: reg.attendee, checkedInAt: updated.checkedInAt };
  } catch (err) {
    if (err instanceof Error && err.message === "CAPACITY_EXCEEDED") {
      apiLogger.warn({ msg: "agent:check-in-reactivate-capacity-exceeded", source: "mcp" });
      return {
        error: "Cannot check in this cancelled registration — its registration type is sold out. Increase its quantity first.",
        code: "CAPACITY_EXCEEDED",
      };
    }
    if (err instanceof Error && err.message === "EVENT_FULL") {
      apiLogger.warn({ msg: "agent:check-in-reactivate-event-full", source: "mcp" });
      return {
        error: "Cannot check in this cancelled registration — the event has reached its maximum attendees. Raise the cap in Settings → Registration first.",
        code: "EVENT_FULL",
      };
    }
    apiLogger.error({ err }, "agent:check_in_registration failed");
    return { error: "Failed to check in registration" };
  }
};

// ─── Contact Executors ────────────────────────────────────────────────────────

const listUnpaidRegistrations: ToolExecutor = async (input, ctx) => {
  try {
    const limit = Math.min(Number(input.limit ?? 100), 500);
    const daysPending = input.daysPending != null ? Number(input.daysPending) : null;
    const ageCutoff = daysPending != null && daysPending > 0
      ? new Date(Date.now() - daysPending * 24 * 60 * 60 * 1000)
      : null;

    const registrations = await db.registration.findMany({
      where: {
        eventId: ctx.eventId,
        paymentStatus: { in: UNPAID_STATUSES as never[] },
        status: { not: "CANCELLED" },
        ...(ageCutoff ? { createdAt: { lte: ageCutoff } } : {}),
      },
      select: {
        id: true,
        status: true,
        paymentStatus: true,
        createdAt: true,
        serialId: true,
        attendee: { select: { firstName: true, lastName: true, email: true, organization: true } },
        ticketType: { select: { name: true } },
      },
      take: limit,
      orderBy: { createdAt: "asc" }, // Oldest first
    });

    const now = Date.now();
    const enriched = registrations.map((r) => ({
      ...r,
      daysSinceRegistration: Math.floor((now - r.createdAt.getTime()) / (24 * 60 * 60 * 1000)),
    }));

    return { registrations: enriched, total: registrations.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_unpaid_registrations failed");
    return { error: "Failed to list unpaid registrations" };
  }
};

// Thin MCP wrapper — the update domain logic (sponsor invariant, billing/
// ticket-type validation, shared repricing, seat/promo transition, optimistic
// lock, attendee patch, audit/sync/stats fan-out) lives in
// registration-service.updateRegistration (cross-caller #5: this executor and
// the REST PUT used to hand-mirror it, with live drift). Boundary keeps the
// loose-input parsing. Parity notes vs the old copy: the lookup is now
// EVENT-scoped (M1 — a mis-scoped call can no longer touch a sibling event's
// registration), the INCLUSIVE↔sponsor invariant fires only when the request
// touches those fields (M7), and attendee empty strings now CLEAR fields to
// null instead of persisting "" (L4).
const updateRegistration: ToolExecutor = async (input, ctx) => {
  try {
    const registrationId = String(input.registrationId ?? "").trim();
    if (!registrationId) return { error: "registrationId is required" };

    const status = input.status ? String(input.status) : undefined;
    if (status && !REGISTRATION_STATUSES.has(status)) {
      return { error: `Invalid status. Must be one of: ${[...REGISTRATION_STATUSES].join(", ")}` };
    }
    const rawMode = input.attendanceMode ? String(input.attendanceMode).toUpperCase() : undefined;
    if (rawMode && rawMode !== "IN_PERSON" && rawMode !== "VIRTUAL") {
      return { error: `Invalid attendanceMode "${rawMode}". Must be IN_PERSON or VIRTUAL.` };
    }

    // Loose → typed attendee patch. `undefined` keeps a field; empty string
    // clears it (the service collapses "" → null on every path).
    let attendeePatch:
      | {
          title?: string | null; firstName?: string; lastName?: string;
          additionalEmail?: string | null; organization?: string; jobTitle?: string;
          phone?: string; city?: string; country?: string; bio?: string;
          specialty?: string; tags?: string[]; dietaryReqs?: string;
        }
      | undefined;
    const a = input.attendee as Record<string, unknown> | undefined;
    if (a && typeof a === "object") {
      if (a.title != null && String(a.title) !== "" && !TITLE_VALUES.has(String(a.title))) {
        return { error: `Invalid title. Must be one of: ${[...TITLE_VALUES].join(", ")}` };
      }
      attendeePatch = {
        ...(a.title != null && { title: String(a.title) }),
        ...(a.firstName != null && String(a.firstName).trim() && { firstName: String(a.firstName).slice(0, 100) }),
        ...(a.lastName != null && String(a.lastName).trim() && { lastName: String(a.lastName).slice(0, 100) }),
        ...(a.additionalEmail !== undefined && { additionalEmail: a.additionalEmail == null ? null : String(a.additionalEmail).slice(0, 255) }),
        ...(a.organization != null && { organization: String(a.organization).slice(0, 255) }),
        ...(a.jobTitle != null && { jobTitle: String(a.jobTitle).slice(0, 255) }),
        ...(a.phone != null && { phone: String(a.phone).slice(0, 50) }),
        ...(a.city != null && { city: String(a.city).slice(0, 255) }),
        ...(a.country != null && { country: String(a.country).slice(0, 255) }),
        ...(a.bio != null && { bio: String(a.bio).slice(0, 5000) }),
        ...(a.specialty != null && { specialty: String(a.specialty).slice(0, 255) }),
        ...(Array.isArray(a.tags) && {
          tags: (a.tags as unknown[]).map((t) => normalizeTag(String(t).slice(0, 100))).filter(Boolean),
        }),
        ...(a.dietaryReqs != null && { dietaryReqs: String(a.dietaryReqs).slice(0, 2000) }),
      };
      if (Object.keys(attendeePatch).length === 0) attendeePatch = undefined;
    }

    const expectedUpdatedAt = typeof input.expectedUpdatedAt === "string" ? input.expectedUpdatedAt : null;

    const result = await updateRegistrationService({
      eventId: ctx.eventId,
      registrationId,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      source: "mcp",
      expectedUpdatedAt,
      ...(status && { status: status as never }),
      ...(input.paymentStatus != null && { paymentStatus: String(input.paymentStatus) }),
      ...(input.sponsorId !== undefined && { sponsorId: input.sponsorId === null ? null : String(input.sponsorId) }),
      ...(input.billingAccountId !== undefined && { billingAccountId: input.billingAccountId === null ? null : String(input.billingAccountId) }),
      ...(input.payerReference !== undefined && { payerReference: String(input.payerReference ?? "").trim() || null }),
      ...(typeof input.attendeeIsGuarantor === "boolean" && { attendeeIsGuarantor: input.attendeeIsGuarantor }),
      ...(input.badgeType !== undefined && { badgeType: input.badgeType as string | null }),
      ...(input.dtcmBarcode !== undefined && { dtcmBarcode: input.dtcmBarcode as string | null }),
      ...(input.ticketTypeId != null && String(input.ticketTypeId).trim() && { ticketTypeId: String(input.ticketTypeId).trim() }),
      ...(input.pricingTierId !== undefined && {
        pricingTierId:
          input.pricingTierId === null || String(input.pricingTierId).trim() === ""
            ? null
            : String(input.pricingTierId).trim(),
      }),
      ...(rawMode && { attendanceMode: rawMode as never }),
      ...(input.notes !== undefined && { notes: String(input.notes).slice(0, 2000) }),
      ...(attendeePatch && { attendee: attendeePatch }),
    });

    if (!result.ok) {
      // REPRICING_BLOCKED surfaces the resolver's sub-code (parity with REST).
      const code = result.code === "REPRICING_BLOCKED" ? (result.repricingCode ?? result.code) : result.code;
      // Agent-actionable phrasing for the optimistic-lock loser (the shared
      // message is human-phrased for the dashboard toast).
      const message =
        result.code === "STALE_WRITE"
          ? "This registration was modified after you fetched it. Re-read the row and retry with the new updatedAt."
          : result.message;
      return { error: message, code, ...(result.meta ?? {}) };
    }

    const r = result.registration;
    return {
      success: true,
      registration: {
        id: r.id,
        status: r.status,
        paymentStatus: r.paymentStatus,
        ticketTypeId: r.ticketTypeId,
        notes: r.notes,
        attendee: {
          id: r.attendee.id,
          firstName: r.attendee.firstName,
          lastName: r.attendee.lastName,
          email: r.attendee.email,
        },
      },
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:update_registration failed");
    return { error: err instanceof Error ? err.message : "Failed to update registration" };
  }
};

const bulkUpdateRegistrationStatus: ToolExecutor = async (input, ctx) => {
  try {
    const rawIds = input.registrationIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return { error: "registrationIds must be a non-empty array" };
    }
    if (rawIds.length > 200) {
      return { error: "Max 200 registrationIds per call" };
    }
    const registrationIds = rawIds.map((x) => String(x).trim()).filter(Boolean);

    const status = input.status ? String(input.status) : undefined;
    if (status && !REGISTRATION_STATUSES.has(status)) {
      return { error: `Invalid status. Must be one of: ${[...REGISTRATION_STATUSES].join(", ")}` };
    }
    const paymentStatus = input.paymentStatus ? String(input.paymentStatus) : undefined;
    if (paymentStatus && !ADMIN_SETTABLE_PAYMENT_STATUSES.has(paymentStatus)) {
      return {
        error: `Invalid paymentStatus "${paymentStatus}". Settable values: ${[...ADMIN_SETTABLE_PAYMENT_STATUSES].join(", ")}. ${PAYMENT_STATUS_WRITE_REJECTION}`,
        code: "PAYMENT_STATUS_NOT_SETTABLE",
      };
    }
    if (!status && !paymentStatus) {
      return { error: "At least one of status or paymentStatus must be provided" };
    }

    const data: Prisma.RegistrationUpdateManyMutationInput = {};
    if (status) data.status = status as never;
    if (paymentStatus) data.paymentStatus = paymentStatus as never;

    // A bulk STATUS change moves seats: cancelling must release soldCount
    // and reactivating must re-acquire it, per ticket type — mirroring the
    // single REST PUT / MCP update_registration paths. Without this, "cancel
    // all unpaid registrations" silently left soldCount inflated and the
    // event falsely reported sold-out. paymentStatus-only bulk updates have
    // no soldCount impact and take the plain path.
    let updatedCount: number;
    // Registrations that BECOME cancelled in this call — their open Stripe
    // checkout sessions are expired post-commit (review H2 sub-item).
    const cancelledIds: string[] = [];
    if (status) {
      const affected = await db.registration.findMany({
        where: {
          id: { in: registrationIds },
          event: { organizationId: ctx.organizationId },
        },
        // Seat-routing fields: release/claim the counter each reg actually holds
        // (tier vs ticket type), and skip virtual regs (no seat) — P1.1 + hybrid.
        select: {
          id: true,
          status: true,
          ticketTypeId: true,
          promoCodeId: true,
          pricingTierId: true,
          createdSource: true,
          attendanceMode: true,
        },
      });
      const toRelease = new Map<string, { counter: SeatCounter; count: number }>();
      const toClaim = new Map<string, { counter: SeatCounter; count: number }>();
      const promoRelease = new Map<string, number>(); // promoCodeId → uses released on cancel
      const promoClaim = new Map<string, number>(); // promoCodeId → uses re-claimed on reactivation (H6 symmetry)
      // Event-wide seat counter: rows whose "holds an event seat" boolean flips
      // (a row holds an event seat iff it holds a seat on ANY counter).
      let eventSeatRelease = 0;
      let eventSeatClaim = 0;
      const bump = (m: Map<string, { counter: SeatCounter; count: number }>, c: SeatCounter) => {
        const k = `${c.kind}:${c.id}`;
        const e = m.get(k);
        if (e) e.count++;
        else m.set(k, { counter: c, count: 1 });
      };
      for (const r of affected) {
        const becomingCancelled = status === "CANCELLED" && r.status !== "CANCELLED";
        const reactivating = status !== "CANCELLED" && r.status === "CANCELLED";
        if (becomingCancelled) cancelledIds.push(r.id);
        // DATA-1: bulk cancel releases each consumed promo code's usage count;
        // reactivation re-claims it (H6 symmetry, same policy as
        // applyRegistrationTransition — without the re-claim, bulk cancel →
        // reactivate → cancel double-released the counter).
        if (becomingCancelled && r.promoCodeId) {
          promoRelease.set(r.promoCodeId, (promoRelease.get(r.promoCodeId) ?? 0) + 1);
        } else if (reactivating && r.promoCodeId) {
          promoClaim.set(r.promoCodeId, (promoClaim.get(r.promoCodeId) ?? 0) + 1);
        }
        if (becomingCancelled) {
          // Release only the seat it actually held (in-person + was non-cancelled).
          if (holdsSeat(r.status, r.attendanceMode)) {
            const c = seatCounter(r);
            if (c) {
              bump(toRelease, c);
              eventSeatRelease++;
            }
          }
        } else if (reactivating) {
          // Claim only if it will hold a seat after reactivation (in-person).
          if (holdsSeat(status as typeof r.status, r.attendanceMode)) {
            const c = seatCounter(r);
            if (c) {
              bump(toClaim, c);
              eventSeatClaim++;
            }
          }
        }
      }
      updatedCount = await db.$transaction(async (tx) => {
        // Guarded release — never drives usedCount negative (was an unguarded
        // `promoCode.update({ decrement })` before the seat/promo consolidation).
        for (const [promoId, n] of promoRelease) {
          await releasePromoUsage(tx, promoId, n);
        }
        for (const [promoId, n] of promoClaim) {
          await claimPromoUsage(tx, promoId, n);
        }
        for (const { counter, count } of toRelease.values()) {
          await releaseSeats(tx, counter, count);
        }
        for (const { counter, count } of toClaim.values()) {
          // Bulk reactivation can't cleanly partial-fail 200 rows on a capacity
          // guard, so it's allowed to oversell — but logged so it's never silent
          // (single-row paths still hard-block via CAPACITY_EXCEEDED).
          const res = await claimSeatsOverselling(tx, counter, count);
          if (res.oversold) {
            apiLogger.warn({
              msg: "registration:bulk-reactivate-oversold",
              ...(counter.kind === "tier"
                ? { pricingTierId: counter.id, tierName: res.counterName }
                : { ticketTypeId: counter.id, ticketName: res.counterName }),
              newSoldCount: res.newSoldCount,
              quantity: res.quantity,
              source: "mcp",
            });
          }
        }
        // Event-wide counter moves with the per-counter seats. Bulk reactivation
        // keeps the oversell-and-warn posture (never partial-fails 200 rows).
        if (eventSeatRelease > 0) {
          await releaseEventSeats(tx, ctx.eventId, eventSeatRelease);
        }
        if (eventSeatClaim > 0) {
          const evRes = await incrementEventSeatsOverselling(tx, ctx.eventId, eventSeatClaim);
          if (evRes.oversold) {
            apiLogger.warn({
              msg: "registration:bulk-reactivate-event-oversold",
              eventId: ctx.eventId,
              newSeatCount: evRes.newSeatCount,
              maxAttendees: evRes.maxAttendees,
              source: "mcp",
            });
          }
        }
        const res = await tx.registration.updateMany({
          where: {
            id: { in: registrationIds },
            event: { organizationId: ctx.organizationId },
          },
          data,
        });
        return res.count;
      });
    } else {
      const res = await db.registration.updateMany({
        where: {
          id: { in: registrationIds },
          event: { organizationId: ctx.organizationId },
        },
        data,
      });
      updatedCount = res.count;
    }

    await db.auditLog.create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: "BULK_UPDATE",
        entityType: "Registration",
        entityId: `bulk-${updatedCount}`,
        changes: {
          source: "mcp",
          registrationIds,
          updates: { status, paymentStatus },
          updatedCount,
        },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:bulk_update_registration_status audit-log-failed"));

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(ctx.eventId);

    // Cancels kill any still-open Stripe payment tabs (review H2 sub-item).
    // Fire-and-forget per row — the helper never throws and no-ops when the
    // registration holds no open session.
    for (const id of cancelledIds) {
      void expireOpenCheckoutSessionOnCancel(id, "mcp-bulk");
    }

    return {
      success: true,
      updated: updatedCount,
      notFound: registrationIds.length - updatedCount,
      requestedCount: registrationIds.length,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:bulk_update_registration_status failed");
    return { error: err instanceof Error ? err.message : "Failed to bulk update" };
  }
};

// ─── Tranche C: Recently shipped features ─────────────────────────────────────

const createRegistrationsBulk: ToolExecutor = async (input, ctx) => {
  try {
    const items = Array.isArray(input.registrations) ? (input.registrations as unknown[]) : null;
    if (!items || !items.length) return { error: "registrations must be a non-empty array", code: "MISSING_REGISTRATIONS" };
    if (items.length > BULK_MAX) {
      return { error: `Max ${BULK_MAX} registrations per call; got ${items.length}`, code: "TOO_MANY_ROWS" };
    }

    // Pre-load the event's ticket types once so we can validate ticketTypeId
    // without hitting the DB N times. requiresApproval / sales window /
    // currency are needed for the M8 parity fixes below; the event row (loaded
    // once, service-shared select) feeds the per-row confirmation emails.
    const [ticketTypes, confirmationEvent] = await Promise.all([
      db.ticketType.findMany({
        where: { eventId: ctx.eventId },
        select: {
          id: true, name: true, quantity: true, price: true, currency: true,
          requiresApproval: true, salesStart: true, salesEnd: true,
        },
      }),
      db.event.findFirst({ where: { id: ctx.eventId }, select: CONFIRMATION_EVENT_SELECT }),
    ]);
    const ticketTypeById = new Map(ticketTypes.map((t) => [t.id, t]));

    const seenEmails = new Set<string>();
    const created: Array<{ index: number; registrationId: string; email: string; attendeeId: string }> = [];
    const errors: Array<{ index: number; email?: string; error: string; code?: string }> = [];

    for (let i = 0; i < items.length; i++) {
      const row = items[i] as Record<string, unknown>;
      try {
        const email = String(row.email ?? "").trim().toLowerCase();
        const firstName = String(row.firstName ?? "").trim();
        const lastName = String(row.lastName ?? "").trim();
        const ticketTypeId = String(row.ticketTypeId ?? "").trim();
        if (!email || !firstName || !lastName || !ticketTypeId) {
          errors.push({ index: i, email: email || undefined, error: "email, firstName, lastName, ticketTypeId required", code: "MISSING_FIELDS" });
          continue;
        }
        if (!EMAIL_RE.test(email)) {
          errors.push({ index: i, email, error: "Invalid email format", code: "INVALID_EMAIL" });
          continue;
        }
        if (seenEmails.has(email)) {
          errors.push({ index: i, email, error: "Duplicate email in this batch", code: "DUPLICATE_IN_BATCH" });
          continue;
        }
        seenEmails.add(email);

        const ticketType = ticketTypeById.get(ticketTypeId);
        if (!ticketType) {
          errors.push({ index: i, email, error: `Ticket type ${ticketTypeId} not found for this event`, code: "INVALID_TICKET_TYPE" });
          continue;
        }

        const rawTitle = row.title ? String(row.title) : undefined;
        if (rawTitle && !TITLE_VALUES.has(rawTitle)) {
          errors.push({ index: i, email, error: `Invalid title`, code: "INVALID_TITLE" });
          continue;
        }
        const rawStatus = row.status ? String(row.status) : "CONFIRMED";
        if (!MANUAL_REGISTRATION_STATUSES.has(rawStatus)) {
          errors.push({ index: i, email, error: `Invalid status`, code: "INVALID_STATUS" });
          continue;
        }

        // Sales-window enforcement (M8 parity with the single-create service —
        // the bulk path used to skip it entirely).
        const now = new Date();
        if (ticketType.salesStart && now < ticketType.salesStart) {
          errors.push({ index: i, email, error: `Ticket sales for ${ticketType.name} have not started yet`, code: "SALES_NOT_STARTED" });
          continue;
        }
        if (ticketType.salesEnd && now > ticketType.salesEnd) {
          errors.push({ index: i, email, error: `Ticket sales for ${ticketType.name} have ended`, code: "SALES_ENDED" });
          continue;
        }

        // Approval-gated types force PENDING regardless of the caller's status
        // (M8 parity — the bulk path used to ignore requiresApproval).
        const finalStatus = ticketType.requiresApproval ? "PENDING" : rawStatus;

        // Payment default parity (M8): paid tickets start UNASSIGNED (money
        // owed, chased by payment reminders), free tickets COMPLIMENTARY —
        // the bulk path used to leave the schema default (UNPAID), so FREE
        // rows were chased by the Chase-Unpaid workflow.
        const price = Number(ticketType.price ?? 0);
        const finalPaymentStatus = price > 0 ? "UNASSIGNED" : "COMPLIMENTARY";

        const duplicate = await db.registration.findFirst({
          // CANCELLED rows don't block a re-registration (M8 parity — the
          // single-create service excludes them from the duplicate check).
          where: { eventId: ctx.eventId, status: { not: "CANCELLED" }, attendee: { email } },
          select: { id: true },
        });
        if (duplicate) {
          errors.push({ index: i, email, error: `Registration for ${email} already exists`, code: "ALREADY_EXISTS" });
          continue;
        }

        // Parse the row's optional attendee fields ONCE. These same values feed
        // three consumers — the Attendee row, the confirmation email, and the
        // Contact-store sync — and rebuilding them per consumer is exactly how
        // the sync came to carry only name+email (contacts review M3): the
        // attendee got the full set, the CRM got a husk. One object, three uses.
        // Typed as plain strings (NOT `as never`) so the shared payload keeps
        // its type-safety at the syncToContact boundary; the Prisma enum cast
        // stays where it belongs — on the Prisma call.
        const attendeeFields: {
          title: string | null;
          organization: string | null;
          jobTitle: string | null;
          phone: string | null;
          country: string | null;
          specialty: string | null;
          registrationType: string;
        } = {
          title: rawTitle ?? null,
          organization: row.organization ? String(row.organization).slice(0, 255) : null,
          jobTitle: row.jobTitle ? String(row.jobTitle).slice(0, 255) : null,
          phone: row.phone ? String(row.phone).slice(0, 50) : null,
          country: row.country ? String(row.country).slice(0, 255) : null,
          specialty: row.specialty ? String(row.specialty).slice(0, 255) : null,
          registrationType: ticketType.name,
        };

        const result = await db.$transaction(async (tx) => {
          const attendee = await tx.attendee.create({
            data: {
              email,
              firstName,
              lastName,
              ...attendeeFields,
              // `rawTitle` is already validated against TITLE_VALUES above.
              title: (attendeeFields.title as never) ?? null,
            },
            select: { id: true, email: true },
          });

          // Atomic increment with sold-out guard — prevents overbooking under
          // concurrent bulk + single registrations. Uses the cached outer
          // `ticketType.quantity` — updateMany's where-clause evaluates the
          // current DB value of soldCount, so we don't need a fresh SELECT.
          const incremented = await tx.ticketType.updateMany({
            where: { id: ticketType.id, soldCount: { lt: ticketType.quantity } },
            data: { soldCount: { increment: 1 } },
          });
          if (incremented.count === 0) throw new Error("SOLD_OUT");

          // Event-wide cap: bulk creates follow the imports-bypass policy
          // (owner decision July 24, 2026) — proceed past a full event and
          // warn-log, mirroring claimSeatsOverselling. Single creates
          // hard-block via the service's EVENT_FULL instead.
          const eventSeat = await incrementEventSeatsOverselling(tx, ctx.eventId);
          if (eventSeat.oversold) {
            apiLogger.warn({
              msg: "registration:bulk-create-event-oversold",
              eventId: ctx.eventId,
              newSeatCount: eventSeat.newSeatCount,
              maxAttendees: eventSeat.maxAttendees,
              source: "mcp",
            });
          }

          const qrCode = generateBarcode();
          const serialId = await getNextSerialId(tx, ctx.eventId);
          const registration = await tx.registration.create({
            data: {
              eventId: ctx.eventId,
              ticketTypeId: ticketType.id,
              attendeeId: attendee.id,
              serialId,
              createdSource: "MCP_AGENT",
              status: finalStatus as never,
              paymentStatus: finalPaymentStatus as never,
              qrCode,
              // In-person, no-tier bulk create → base price is the ticket-type
              // price. Stamp it so the subtotal never resolves to 0.
              originalPrice: price,
            },
            select: { id: true, serialId: true, qrCode: true },
          });
          return { attendeeId: attendee.id, registrationId: registration.id, serialId: registration.serialId, qrCode: registration.qrCode };
        });

        created.push({ index: i, email, attendeeId: result.attendeeId, registrationId: result.registrationId });

        // Confirmation email + quote PDF for money-owed rows (M8 parity —
        // the bulk path used to skip the email silently, so bulk-imported
        // paying registrants never received their quote/pay link). Same
        // owes-money gate + shared assembly as the single-create service;
        // fire-and-forget with its own log key.
        if (confirmationEvent && price > 0 && finalPaymentStatus === "UNASSIGNED") {
          sendRegistrationConfirmationEmail({
            event: confirmationEvent,
            registration: { id: result.registrationId, serialId: result.serialId, qrCode: result.qrCode },
            attendee: {
              email,
              firstName,
              lastName,
              title: attendeeFields.title,
              organization: attendeeFields.organization,
              jobTitle: attendeeFields.jobTitle,
              country: attendeeFields.country,
            },
            ticketTypeName: ticketType.name,
            ticketCurrency: ticketType.currency,
            price,
            attendanceMode: "IN_PERSON",
            logKey: "agent:create_registrations_bulk confirmation-send-failed",
          });
        }

        // Fire-and-forget Contact upsert so bulk-created attendees reach the
        // org-wide Contact store — with the FULL row, not just name+email
        // (contacts review M3). It used to pass only { email, firstName,
        // lastName }: because `syncToContact` is ENRICH-ONLY, that is a silent
        // NO-OP against an existing contact — the call succeeded, logged
        // nothing, and changed nothing — so a 100-row agent import produced 100
        // husk CRM rows while the Attendee rows held the full data. Same class
        // as H4 (MCP update_speaker); the bulk paths are deliberately not
        // service-backed, so the single-create service's fix didn't reach here.
        syncToContact({
          organizationId: ctx.organizationId,
          eventId: ctx.eventId,
          email,
          firstName,
          lastName,
          ...attendeeFields,
        }).catch((err) => apiLogger.error({ err, index: i, email }, "agent:create_registrations_bulk contact-sync-failed"));
      } catch (err) {
        const rowEmail = (items[i] as { email?: string }).email;
        const message = err instanceof Error ? err.message : "Unknown error";
        errors.push({ index: i, email: rowEmail, error: message, code: "ROW_FAILED" });
        apiLogger.warn(
          { err, eventId: ctx.eventId, index: i, email: rowEmail },
          "agent:create_registrations_bulk row-failed",
        );
      }
    }

    apiLogger.info(
      { eventId: ctx.eventId, created: created.length, failed: errors.length, total: items.length },
      "agent:create_registrations_bulk",
    );

    if (created.length > 0) {
      db.auditLog.create({
        data: {
          eventId: ctx.eventId,
          userId: ctx.userId,
          action: "CREATE",
          entityType: "Registration",
          entityId: `bulk:${created.length}`,
          changes: { source: "mcp", bulk: true, created: created.length, failed: errors.length },
        },
      }).catch((err) => apiLogger.error({ err }, "agent:create_registrations_bulk audit-log-failed"));

      // Refresh denormalized event stats (fire-and-forget)
      refreshEventStats(ctx.eventId);

      // Parity with REST — one batched admin notification per bulk call
      // instead of per-row (would swamp the inbox on a 100-row import).
      notifyEventAdmins(ctx.eventId, {
        type: "REGISTRATION",
        title: "Registrations Added (Bulk)",
        message: `${created.length} registration${created.length === 1 ? "" : "s"} added via MCP bulk import${errors.length ? ` (${errors.length} failed)` : ""}`,
        link: `/events/${ctx.eventId}/registrations`,
      }).catch((err) => apiLogger.error({ err }, "agent:create_registrations_bulk notify-admins-failed"));
    }

    return {
      success: true,
      createdCount: created.length,
      failedCount: errors.length,
      created,
      errors,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_registrations_bulk failed");
    return { error: err instanceof Error ? err.message : "Failed to bulk-create registrations" };
  }
};

export const REGISTRATION_TOOL_DEFINITIONS: Tool[] = [
  {
    name: "list_registrations",
    description:
      "List registrations for this event. Optionally filter by status, paymentStatus, or ticketTypeId.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["PENDING", "CONFIRMED", "CANCELLED", "WAITLISTED", "CHECKED_IN"],
        },
        paymentStatus: {
          type: "string",
          enum: ["UNPAID", "PENDING", "PAID", "REFUNDED", "COMPLIMENTARY"],
          description: "Filter by payment status, e.g. UNPAID to find who hasn't paid",
        },
        ticketTypeId: { type: "string", description: "Filter by ticket type ID" },
        createdAfter: {
          type: "string",
          description: "Only rows created at/after this ISO 8601 datetime (inclusive)",
        },
        createdBefore: {
          type: "string",
          description: "Only rows created at/before this ISO 8601 datetime (inclusive)",
        },
        updatedAfter: {
          type: "string",
          description: "Only rows updated at/after this ISO 8601 datetime (inclusive) — the incremental-sync checkpoint",
        },
        updatedBefore: {
          type: "string",
          description: "Only rows updated at/before this ISO 8601 datetime (inclusive)",
        },
        limit: {
          type: "number",
          description: "Max results to return (default 50, max 200)",
        },
      },
      required: [],
    },
  },
  {
    name: "list_ticket_types",
    description: "List all registration/ticket types for this event.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "create_ticket_type",
    description:
      "Create a new registration/ticket type for this event if one with the same name does not already exist. Automatically creates Early Bird, Standard, and Onsite pricing tiers at $0 and inactive — organizers can set prices and activate tiers later.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Ticket type name, e.g. 'Standard Delegate', 'VIP', 'Student'" },
        description: { type: "string", description: "Optional description" },
        isDefault: { type: "boolean", description: "Whether this is the default ticket type (default: false)" },
      },
      required: ["name"],
    },
  },
  {
    name: "create_registration",
    description:
      "Manually add a registration for an attendee. Requires email, firstName, lastName, and ticketTypeId (use list_ticket_types to get IDs). Sends a confirmation email + quote PDF automatically when the ticket is paid and payment is outstanding (default paymentStatus: UNASSIGNED for paid, COMPLIMENTARY for free).",
    input_schema: {
      type: "object" as const,
      properties: {
        email: { type: "string", description: "Attendee email address" },
        firstName: { type: "string" },
        lastName: { type: "string" },
        ticketTypeId: { type: "string", description: "ID of the ticket type (use list_ticket_types to get IDs)" },
        pricingTierId: { type: "string", description: "Optional pricing tier ID" },
        attendanceMode: { type: "string", enum: ["IN_PERSON", "VIRTUAL"], description: "IN_PERSON (default) or VIRTUAL. Only meaningful on HYBRID events. VIRTUAL ⇒ no entry barcode/badge, uncapped (skips seat count), priced via the ticket's virtualPrice." },
        status: {
          type: "string",
          enum: ["PENDING", "CONFIRMED", "WAITLISTED"],
          description: "Registration status (default: CONFIRMED). Overridden to PENDING if the ticket type requires approval.",
        },
        paymentStatus: {
          type: "string",
          enum: ["UNASSIGNED", "UNPAID", "PAID", "COMPLIMENTARY", "INCLUSIVE"],
          description: "Admin-settable payment status. Default: UNASSIGNED for paid tickets, COMPLIMENTARY for free. Stripe-driven states (PENDING/REFUNDED/FAILED) are webhook-owned and cannot be set here. INCLUSIVE means sponsor-paid — requires sponsorId.",
        },
        sponsorId: {
          type: "string",
          description: "Sponsor attribution id (from Event.settings.sponsors[]). Required when paymentStatus is INCLUSIVE. Use list_sponsors to see available ids.",
        },
        billingAccountId: {
          type: "string",
          description: "\"Charge to another account\" — id of a reusable org BillingAccount (the attendee's hospital, or a pharma/grant covering this HCP). When set, the invoice is addressed to that payer instead of the attendee. ORTHOGONAL to paymentStatus: money is still owed and the registration stays UNPAID/PENDING until the payer settles. Billing accounts are managed in Settings → Billing; there is no agent tool to create them.",
        },
        payerReference: {
          type: "string",
          description: "Optional PO / grant / authorization reference printed on the invoice. Only meaningful with billingAccountId.",
        },
        attendeeIsGuarantor: {
          type: "boolean",
          description: "If true and a billingAccountId is set, the attendee remains guarantor for an unpaid third-party invoice (keeps their Pay-Now path; lets finance revert the payer). Default false.",
        },
        title: {
          type: "string",
          enum: ["DR", "MR", "MRS", "MS", "PROF"],
        },
        role: {
          type: "string",
          enum: ["ACADEMIA", "ALLIED_HEALTH", "MEDICAL_DEVICES", "PHARMA", "PHYSICIAN", "RESIDENT", "SPEAKER", "STUDENT", "OTHERS"],
          description: "Attendee demographic/professional role. Matches the public registration form classifications.",
        },
        additionalEmail: {
          type: "string",
          description: "Secondary email (cc on notifications). Optional.",
        },
        organization: { type: "string" },
        jobTitle: { type: "string" },
        phone: { type: "string" },
        city: { type: "string" },
        state: { type: "string" },
        zipCode: { type: "string" },
        country: { type: "string" },
        specialty: { type: "string" },
        customSpecialty: {
          type: "string",
          description: "Free-text specialty when `specialty` is 'Others'.",
        },
        associationName: { type: "string" },
        memberId: {
          type: "string",
          description: "Member ID — required on the public form when registrationType name contains 'member'.",
        },
        studentId: {
          type: "string",
          description: "Student ID — required on the public form when registrationType name contains 'student'.",
        },
        studentIdExpiry: {
          type: "string",
          description: "ISO 8601 date (YYYY-MM-DD) for student ID expiry. Invalid dates are stored as null.",
        },
      },
      required: ["email", "firstName", "lastName", "ticketTypeId"],
    },
  },
  {
    name: "check_in_registration",
    description: "Mark a registration as checked in at the event. Enforces the same gates as the registration desk: UNPAID/PENDING registrations are refused with PAYMENT_REQUIRED unless complimentary/free — settle or comp them first. CANCELLED registrations are blocked by default (returns REGISTRATION_CANCELLED); pass allowCancelled=true to override if the cancellation was a mistake (the override reactivates the registration, re-claiming its seat — can fail with CAPACITY_EXCEEDED if the type is sold out).",
    input_schema: {
      type: "object" as const,
      properties: {
        registrationId: { type: "string", description: "Registration ID to check in" },
        allowCancelled: { type: "boolean", description: "If true, check in even if the registration is CANCELLED. The status will be overwritten to CHECKED_IN. Use sparingly; default false." },
      },
      required: ["registrationId"],
    },
  },
];

export const REGISTRATION_EXECUTORS: Record<string, ToolExecutor> = {
  list_registrations: listRegistrations,
  create_registration: createRegistrationTool,
  update_registration: updateRegistration,
  bulk_update_registration_status: bulkUpdateRegistrationStatus,
  create_registrations_bulk: createRegistrationsBulk,
  check_in_registration: checkInRegistration,
  list_unpaid_registrations: listUnpaidRegistrations,
  list_ticket_types: listTicketTypes,
  create_ticket_type: createTicketType,
};
