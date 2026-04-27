import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getNextSerialId } from "@/lib/registration-serial";
import { generateBarcode, normalizeTag } from "@/lib/utils";
import { syncToContact } from "@/lib/contact-sync";
import { refreshEventStats } from "@/lib/event-stats";
import { notifyEventAdmins } from "@/lib/notifications";
import {
  createRegistration,
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
  type ToolExecutor,
} from "./_shared";

const ALL_PAYMENT_STATUSES = new Set(["UNASSIGNED", "UNPAID", "PENDING", "PAID", "COMPLIMENTARY", "REFUNDED", "FAILED"]);
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
    const PAYMENT_STATUSES = new Set(["UNPAID", "PENDING", "PAID", "REFUNDED", "COMPLIMENTARY"]);
    const paymentStatusValue = input.paymentStatus ? String(input.paymentStatus) : undefined;
    if (paymentStatusValue && !PAYMENT_STATUSES.has(paymentStatusValue)) {
      return { error: `Invalid paymentStatus "${paymentStatusValue}". Must be one of: ${[...PAYMENT_STATUSES].join(", ")}` };
    }
    const registrations = await db.registration.findMany({
      where: {
        eventId: ctx.eventId,
        ...(statusValue ? { status: statusValue as never } : {}),
        ...(paymentStatusValue ? { paymentStatus: paymentStatusValue as never } : {}),
        ...(input.ticketTypeId
          ? { ticketTypeId: String(input.ticketTypeId) }
          : {}),
      },
      select: {
        id: true,
        status: true,
        paymentStatus: true,
        createdAt: true,
        attendee: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
            organization: true,
          },
        },
        ticketType: { select: { name: true } },
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

    const result = await createRegistration({
      eventId: ctx.eventId,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      ticketTypeId,
      pricingTierId: input.pricingTierId ? String(input.pricingTierId) : undefined,
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

const checkInRegistration: ToolExecutor = async (input, ctx) => {
  try {
    const registrationId = String(input.registrationId ?? "").trim();
    const allowCancelled = Boolean(input.allowCancelled);
    if (!registrationId) return { error: "registrationId is required" };

    const reg = await db.registration.findFirst({
      where: { id: registrationId, eventId: ctx.eventId },
      select: { id: true, status: true, checkedInAt: true, attendee: { select: { firstName: true, lastName: true } } },
    });
    if (!reg) return { error: `Registration ${registrationId} not found` };
    if (reg.checkedInAt) return { alreadyCheckedIn: true, checkedInAt: reg.checkedInAt, attendee: reg.attendee };

    if (reg.status === "CANCELLED" && !allowCancelled) {
      return {
        error: `Registration ${registrationId} is CANCELLED. Reinstate it (set status to CONFIRMED) before checking in, or pass allowCancelled=true to override.`,
        code: "REGISTRATION_CANCELLED",
        currentStatus: reg.status,
        suggestion: "update_registration with status=CONFIRMED, then retry check_in_registration.",
      };
    }

    await db.registration.update({
      where: { id: registrationId },
      data: { checkedInAt: new Date(), status: "CHECKED_IN" },
    });

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(ctx.eventId);

    return { success: true, attendee: reg.attendee, checkedInAt: new Date() };
  } catch (err) {
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

const updateRegistration: ToolExecutor = async (input, ctx) => {
  try {
    const registrationId = String(input.registrationId ?? "").trim();
    if (!registrationId) return { error: "registrationId is required" };

    // Verify the registration belongs to the authenticated org's event
    const existing = await db.registration.findFirst({
      where: { id: registrationId, event: { organizationId: ctx.organizationId } },
      select: {
        id: true,
        eventId: true,
        status: true,
        paymentStatus: true,
        ticketTypeId: true,
        attendeeId: true,
        attendee: { select: { id: true, firstName: true, lastName: true, email: true, tags: true } },
      },
    });
    if (!existing) return { error: `Registration ${registrationId} not found or access denied` };

    const status = input.status ? String(input.status) : undefined;
    if (status && !REGISTRATION_STATUSES.has(status)) {
      return { error: `Invalid status. Must be one of: ${[...REGISTRATION_STATUSES].join(", ")}` };
    }
    const paymentStatus = input.paymentStatus ? String(input.paymentStatus) : undefined;
    if (paymentStatus && !ALL_PAYMENT_STATUSES.has(paymentStatus)) {
      return { error: `Invalid paymentStatus. Must be one of: ${[...ALL_PAYMENT_STATUSES].join(", ")}` };
    }

    const newTicketTypeId = input.ticketTypeId ? String(input.ticketTypeId) : undefined;
    if (newTicketTypeId && newTicketTypeId !== existing.ticketTypeId) {
      const ticket = await db.ticketType.findFirst({
        where: { id: newTicketTypeId, eventId: existing.eventId },
        select: { id: true },
      });
      if (!ticket) return { error: `ticketTypeId ${newTicketTypeId} not found in this event` };
    }

    const attendeeUpdates: Prisma.AttendeeUpdateInput = {};
    const a = input.attendee as Record<string, unknown> | undefined;
    if (a && typeof a === "object") {
      if (a.title != null) {
        const t = String(a.title);
        if (t === "") attendeeUpdates.title = null;
        else if (TITLE_VALUES.has(t)) attendeeUpdates.title = t as never;
        else return { error: `Invalid title. Must be one of: ${[...TITLE_VALUES].join(", ")}` };
      }
      if (a.firstName != null) attendeeUpdates.firstName = String(a.firstName).slice(0, 100);
      if (a.lastName != null) attendeeUpdates.lastName = String(a.lastName).slice(0, 100);
      if (a.organization != null) attendeeUpdates.organization = String(a.organization).slice(0, 255);
      if (a.jobTitle != null) attendeeUpdates.jobTitle = String(a.jobTitle).slice(0, 255);
      if (a.phone != null) attendeeUpdates.phone = String(a.phone).slice(0, 50);
      if (a.city != null) attendeeUpdates.city = String(a.city).slice(0, 255);
      if (a.country != null) attendeeUpdates.country = String(a.country).slice(0, 255);
      if (a.bio != null) attendeeUpdates.bio = String(a.bio).slice(0, 5000);
      if (a.specialty != null) attendeeUpdates.specialty = String(a.specialty).slice(0, 255);
      if (Array.isArray(a.tags)) {
        attendeeUpdates.tags = (a.tags as unknown[])
          .map((t) => normalizeTag(String(t).slice(0, 100)))
          .filter(Boolean);
      }
      if (a.dietaryReqs != null) attendeeUpdates.dietaryReqs = String(a.dietaryReqs).slice(0, 2000);
    }

    // Optimistic-lock token (W2-F8 fix). Optional during rollout — when
    // missing, the conditional updateMany below falls back to id-only
    // matching with a warn log so we can audit which clients haven't
    // migrated.
    const expectedUpdatedAt = typeof input.expectedUpdatedAt === "string" ? input.expectedUpdatedAt : null;
    if (!expectedUpdatedAt) {
      apiLogger.warn({
        msg: "optimistic-lock:missing-expectedUpdatedAt",
        resource: "registration",
        resourceId: registrationId,
        source: "mcp",
      });
    }

    // Transaction: ticket type change needs soldCount adjustments on both
    // tiers. The optimistic-lock check on registration sits inside the
    // same transaction so a stale-write rejection rolls back any
    // soldCount delta we just applied.
    type UpdateResult = {
      ok: true;
      registration: {
        id: string;
        status: string;
        paymentStatus: string;
        ticketTypeId: string | null;
        notes: string | null;
        attendee: { id: string; firstName: string; lastName: string; email: string };
      };
    } | { ok: false; reason: "STALE_WRITE" | "REGISTRATION_DISAPPEARED" };

    const txResult: UpdateResult = await db.$transaction(async (tx) => {
      if (newTicketTypeId && newTicketTypeId !== existing.ticketTypeId) {
        if (existing.ticketTypeId) {
          await tx.ticketType.update({
            where: { id: existing.ticketTypeId },
            data: { soldCount: { decrement: 1 } },
          });
        }
        await tx.ticketType.update({
          where: { id: newTicketTypeId },
          data: { soldCount: { increment: 1 } },
        });
      }

      const regData: Prisma.RegistrationUncheckedUpdateInput = { updatedAt: new Date() };
      if (status) regData.status = status as never;
      if (paymentStatus) regData.paymentStatus = paymentStatus as never;
      if (newTicketTypeId) regData.ticketTypeId = newTicketTypeId;
      if (input.badgeType !== undefined) regData.badgeType = input.badgeType as string | null;
      if (input.dtcmBarcode !== undefined) regData.dtcmBarcode = input.dtcmBarcode as string | null;
      if (input.notes !== undefined) regData.notes = String(input.notes).slice(0, 2000);

      const updateRes = await tx.registration.updateMany({
        where: {
          id: registrationId,
          ...(expectedUpdatedAt && { updatedAt: new Date(expectedUpdatedAt) }),
        },
        data: regData,
      });
      if (updateRes.count === 0) {
        // Throw to roll back the soldCount changes above. The reason is
        // smuggled out via the message so the outer catch can branch
        // on a clean code rather than parsing an opaque error.
        throw new Error(expectedUpdatedAt ? "STALE_WRITE" : "REGISTRATION_DISAPPEARED");
      }

      const updated = await tx.registration.findUniqueOrThrow({
        where: { id: registrationId },
        select: {
          id: true,
          status: true,
          paymentStatus: true,
          ticketTypeId: true,
          notes: true,
          attendee: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      });

      if (Object.keys(attendeeUpdates).length > 0) {
        await tx.attendee.update({
          where: { id: existing.attendeeId },
          data: attendeeUpdates,
        });
      }

      return { ok: true as const, registration: updated };
    }).catch((err) => {
      if (err instanceof Error && err.message === "STALE_WRITE") {
        return { ok: false as const, reason: "STALE_WRITE" as const };
      }
      if (err instanceof Error && err.message === "REGISTRATION_DISAPPEARED") {
        return { ok: false as const, reason: "REGISTRATION_DISAPPEARED" as const };
      }
      throw err;
    });

    if (!txResult.ok && txResult.reason === "STALE_WRITE") {
      apiLogger.info({ msg: "registration:stale-write-rejected", registrationId, source: "mcp" });
      return {
        error: "This registration was modified after you fetched it. Re-read the row and retry with the new updatedAt.",
        code: "STALE_WRITE",
      };
    }
    if (!txResult.ok && txResult.reason === "REGISTRATION_DISAPPEARED") {
      return { error: `Registration ${registrationId} not found or access denied` };
    }
    if (!txResult.ok) {
      // Exhaustive guard — both `ok: false` reasons handled above. Keeps
      // the type-narrowing happy without an unsafe cast.
      return { error: "Failed to update registration" };
    }
    const result = txResult.registration;

    await db.auditLog.create({
      data: {
        eventId: existing.eventId,
        userId: ctx.userId,
        action: "UPDATE",
        entityType: "Registration",
        entityId: registrationId,
        changes: {
          source: "mcp",
          before: { status: existing.status, paymentStatus: existing.paymentStatus, ticketTypeId: existing.ticketTypeId },
          after: { status: result.status, paymentStatus: result.paymentStatus, ticketTypeId: result.ticketTypeId },
          attendeeFieldsChanged: Object.keys(attendeeUpdates),
        },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:update_registration audit-log-failed"));

    // Sync to contact store (fire-and-forget)
    if (Object.keys(attendeeUpdates).length > 0) {
      syncToContact({
        organizationId: ctx.organizationId,
        eventId: existing.eventId,
        email: result.attendee.email,
        firstName: result.attendee.firstName,
        lastName: result.attendee.lastName,
      }).catch((err) => apiLogger.error({ err }, "agent:update_registration contact-sync-failed"));
    }

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(ctx.eventId);

    return { success: true, registration: result };
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
    if (paymentStatus && !ALL_PAYMENT_STATUSES.has(paymentStatus)) {
      return { error: `Invalid paymentStatus. Must be one of: ${[...ALL_PAYMENT_STATUSES].join(", ")}` };
    }
    if (!status && !paymentStatus) {
      return { error: "At least one of status or paymentStatus must be provided" };
    }

    const data: Prisma.RegistrationUpdateManyMutationInput = {};
    if (status) data.status = status as never;
    if (paymentStatus) data.paymentStatus = paymentStatus as never;

    const result = await db.registration.updateMany({
      where: {
        id: { in: registrationIds },
        event: { organizationId: ctx.organizationId },
      },
      data,
    });

    await db.auditLog.create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: "BULK_UPDATE",
        entityType: "Registration",
        entityId: `bulk-${result.count}`,
        changes: {
          source: "mcp",
          registrationIds,
          updates: { status, paymentStatus },
          updatedCount: result.count,
        },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:bulk_update_registration_status audit-log-failed"));

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(ctx.eventId);

    return {
      success: true,
      updated: result.count,
      notFound: registrationIds.length - result.count,
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
    // without hitting the DB N times.
    const ticketTypes = await db.ticketType.findMany({
      where: { eventId: ctx.eventId },
      select: { id: true, name: true, quantity: true },
    });
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

        const duplicate = await db.registration.findFirst({
          where: { eventId: ctx.eventId, attendee: { email } },
          select: { id: true },
        });
        if (duplicate) {
          errors.push({ index: i, email, error: `Registration for ${email} already exists`, code: "ALREADY_EXISTS" });
          continue;
        }

        const result = await db.$transaction(async (tx) => {
          const attendee = await tx.attendee.create({
            data: {
              email,
              firstName,
              lastName,
              title: (rawTitle as never) ?? null,
              organization: row.organization ? String(row.organization).slice(0, 255) : null,
              jobTitle: row.jobTitle ? String(row.jobTitle).slice(0, 255) : null,
              phone: row.phone ? String(row.phone).slice(0, 50) : null,
              country: row.country ? String(row.country).slice(0, 255) : null,
              specialty: row.specialty ? String(row.specialty).slice(0, 255) : null,
              registrationType: ticketType.name,
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

          const qrCode = generateBarcode();
          const serialId = await getNextSerialId(tx, ctx.eventId);
          const registration = await tx.registration.create({
            data: {
              eventId: ctx.eventId,
              ticketTypeId: ticketType.id,
              attendeeId: attendee.id,
              serialId,
              status: rawStatus as never,
              qrCode,
            },
            select: { id: true },
          });
          return { attendeeId: attendee.id, registrationId: registration.id };
        });

        created.push({ index: i, email, ...result });

        // Fire-and-forget Contact upsert so bulk-created attendees reach the
        // org-wide Contact store (parity with the single `create_registration`
        // executor — otherwise bulk-imported attendees silently don't sync).
        syncToContact({
          organizationId: ctx.organizationId,
          eventId: ctx.eventId,
          email,
          firstName,
          lastName,
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
        status: {
          type: "string",
          enum: ["PENDING", "CONFIRMED", "WAITLISTED"],
          description: "Registration status (default: CONFIRMED). Overridden to PENDING if the ticket type requires approval.",
        },
        paymentStatus: {
          type: "string",
          enum: ["UNASSIGNED", "UNPAID", "PAID", "COMPLIMENTARY"],
          description: "Admin-settable payment status. Default: UNASSIGNED for paid tickets, COMPLIMENTARY for free. Stripe-driven states (PENDING/REFUNDED/FAILED) are webhook-owned and cannot be set here.",
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
    description: "Mark a registration as checked in at the event. CANCELLED registrations are blocked by default (returns REGISTRATION_CANCELLED); pass allowCancelled=true to override if the cancellation was a mistake.",
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
