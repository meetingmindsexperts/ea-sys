import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { refreshEventStats } from "@/lib/event-stats";
import { slugify, deriveEventCode } from "@/lib/utils";
import { provisionWebinar } from "@/lib/webinar-provisioner";
import { DEFAULT_REGISTRATION_TERMS_HTML, DEFAULT_SPEAKER_AGREEMENT_HTML } from "@/lib/default-terms";
import type { ToolExecutor } from "./_shared";

const EVENT_TYPES = new Set(["CONFERENCE", "WEBINAR", "HYBRID"]);
const EVENT_STATUSES = new Set(["DRAFT", "PUBLISHED", "LIVE", "COMPLETED", "CANCELLED"]);

const CODE_RE = /^[A-Z0-9-]+$/;

const listEventInfo: ToolExecutor = async (_input, ctx) => {
  try {
    const event = await db.event.findFirst({
      where: { id: ctx.eventId, organizationId: ctx.organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        startDate: true,
        endDate: true,
        venue: true,
        city: true,
        country: true,
        specialty: true,
        eventType: true,
        _count: {
          select: {
            registrations: true,
            speakers: true,
            eventSessions: true,
            tracks: true,
          },
        },
      },
    });
    if (!event) return { error: "Event not found" };
    return event;
  } catch (err) {
    apiLogger.error({ err }, "agent:list_event_info failed");
    return { error: "Failed to fetch event info" };
  }
};

const listTracks: ToolExecutor = async (_input, ctx) => {
  try {
    const tracks = await db.track.findMany({
      where: { eventId: ctx.eventId },
      select: {
        id: true,
        name: true,
        color: true,
        description: true,
        sortOrder: true,
        _count: { select: { eventSessions: true } },
      },
      orderBy: { sortOrder: "asc" },
    });
    return { tracks, total: tracks.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_tracks failed");
    return { error: "Failed to fetch tracks" };
  }
};

const createTrack: ToolExecutor = async (input, ctx) => {
  try {
    const name = String(input.name ?? "").trim();
    if (!name) return { error: "Track name is required" };

    const color = String(input.color ?? "#3B82F6");
    if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
      return { error: "Color must be a valid hex code like #3B82F6" };
    }

    // Get next sort order
    const maxOrder = await db.track.findFirst({
      where: { eventId: ctx.eventId },
      select: { sortOrder: true },
      orderBy: { sortOrder: "desc" },
    });
    const sortOrder = (maxOrder?.sortOrder ?? -1) + 1;

    const track = await db.track.create({
      data: {
        eventId: ctx.eventId,
        name,
        color,
        description: input.description ? String(input.description) : null,
        sortOrder,
      },
      select: { id: true, name: true, color: true, description: true },
    });

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(ctx.eventId);

    return { success: true, track };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_track failed");
    return { error: "Failed to create track" };
  }
};

const createEvent: ToolExecutor = async (input, ctx) => {
  try {
    const name = String(input.name ?? "").trim();
    const startDateStr = String(input.startDate ?? "").trim();
    const endDateStr = String(input.endDate ?? "").trim();
    if (!name) return { error: "name is required" };
    if (name.length < 2 || name.length > 255) return { error: "name must be 2-255 chars" };
    if (!startDateStr || !endDateStr) return { error: "startDate and endDate are required (ISO 8601)" };

    const startDate = new Date(startDateStr);
    const endDate = new Date(endDateStr);
    if (isNaN(startDate.getTime())) return { error: "startDate is not a valid ISO 8601 date" };
    if (isNaN(endDate.getTime())) return { error: "endDate is not a valid ISO 8601 date" };
    if (endDate < startDate) return { error: "endDate must be on or after startDate" };

    const eventType = input.eventType ? String(input.eventType) : undefined;
    if (eventType && !EVENT_TYPES.has(eventType)) {
      return { error: `Invalid eventType. Must be one of: ${[...EVENT_TYPES].join(", ")}` };
    }
    const status = input.status ? String(input.status) : undefined;
    if (status && !EVENT_STATUSES.has(status)) {
      return { error: `Invalid status. Must be one of: ${[...EVENT_STATUSES].join(", ")}` };
    }

    // Slug generation: start from requested (or slugified name), then retry with
    // -1, -2, ... up to 10 times if collides within this org. Fail loudly rather
    // than silently creating a duplicate (which was the old POST-route behavior
    // of appending Date.now() — confusing for humans).
    const requestedSlug = input.slug ? slugify(String(input.slug)) : slugify(name);
    if (!requestedSlug) return { error: "Could not generate a valid slug from name" };

    let slug = requestedSlug;
    for (let i = 0; i < 11; i++) {
      const existing = await db.event.findFirst({
        where: { organizationId: ctx.organizationId, slug },
        select: { id: true },
      });
      if (!existing) break;
      if (i === 10) {
        return { error: `Slug "${requestedSlug}" is taken; tried 10 suffixes. Pass an explicit slug.` };
      }
      slug = `${requestedSlug}-${i + 1}`;
    }

    // Resolve event.code (invoice-number prefix). Caller can pass explicit; we
    // validate + uppercase. If omitted, derive from name so invoice generation
    // works out of the box without forcing a second admin-UI visit.
    let code: string;
    if (input.code != null) {
      const raw = String(input.code).trim().toUpperCase();
      if (!raw) return { error: "code cannot be empty", code: "INVALID_CODE" };
      if (raw.length > 20) return { error: "code must be at most 20 chars", code: "INVALID_CODE" };
      if (!CODE_RE.test(raw)) {
        return { error: "code must contain only A-Z, 0-9, and hyphens", code: "INVALID_CODE" };
      }
      code = raw;
    } else {
      code = deriveEventCode(name);
    }

    const event = await db.event.create({
      data: {
        organizationId: ctx.organizationId,
        name,
        slug,
        code,
        description: input.description ? String(input.description).slice(0, 2000) : null,
        startDate,
        endDate,
        timezone: input.timezone ? String(input.timezone) : "Asia/Dubai",
        venue: input.venue ? String(input.venue).slice(0, 255) : null,
        address: input.address ? String(input.address).slice(0, 500) : null,
        city: input.city ? String(input.city).slice(0, 255) : null,
        country: input.country ? String(input.country).slice(0, 255) : null,
        eventType: (eventType as never) ?? null,
        tag: input.tag ? String(input.tag).slice(0, 255) : null,
        specialty: input.specialty ? String(input.specialty).slice(0, 255) : null,
        status: (status as never) ?? "DRAFT",
        registrationTermsHtml: DEFAULT_REGISTRATION_TERMS_HTML,
        speakerAgreementHtml: DEFAULT_SPEAKER_AGREEMENT_HTML,
      },
      select: {
        id: true,
        name: true,
        slug: true,
        code: true,
        status: true,
        eventType: true,
        startDate: true,
        endDate: true,
        timezone: true,
        venue: true,
      },
    });

    await db.auditLog.create({
      data: {
        eventId: event.id,
        userId: ctx.userId,
        action: "CREATE",
        entityType: "Event",
        entityId: event.id,
        changes: {
          source: "mcp",
          name: event.name,
          slug: event.slug,
          code: event.code,
          eventType: event.eventType ?? null,
        },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:create_event audit-log-failed"));

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(event.id);

    // Fire-and-forget WEBINAR auto-provisioning (anchor session + Zoom + email sequence)
    if (event.eventType === "WEBINAR") {
      provisionWebinar(event.id, { actorUserId: ctx.userId }).catch((err) =>
        apiLogger.error({ err, eventId: event.id }, "agent:create_event webinar-provision-failed"),
      );
    }

    return { success: true, event };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_event failed");
    return { error: "Failed to create event" };
  }
};

// breaking public URLs, email scheduling, Zoom provisioning, or timezone math.
// slug + startDate + endDate + eventType + timezone are intentionally excluded
// because they cascade to registered URLs, scheduled-email fire times, webinar
// provisioning, and session start/end math respectively.
const EVENT_UPDATE_FIELD_WHITELIST = new Set([
  "name",
  "description",
  "venue",
  "address",
  "city",
  "country",
  "tag",
  "specialty",
  "code",
  "taxRate",
  "taxLabel",
  "bankDetails",
  "badgeVerticalOffset",
]);
const EVENT_UPDATE_FIELD_BLACKLIST = new Set([
  "slug",
  "startDate",
  "endDate",
  "eventType",
  "timezone",
  "organizationId",
  "id",
]);

const updateEvent: ToolExecutor = async (input, ctx) => {
  try {
    const eventId = String(input.eventId ?? "").trim();
    if (!eventId) return { error: "eventId is required", code: "MISSING_EVENT_ID" };

    const existing = await db.event.findFirst({
      where: { id: eventId, organizationId: ctx.organizationId },
      select: { id: true, name: true },
    });
    if (!existing) return { error: `Event ${eventId} not found or access denied`, code: "EVENT_NOT_FOUND" };

    // Reject any blacklisted field explicitly so the caller learns why and can
    // re-route through the dashboard (where cascading effects are handled).
    // Both rejections get a warn-level log so admins can see if someone is
    // repeatedly trying to bypass the whitelist via MCP.
    for (const key of Object.keys(input)) {
      if (key === "eventId") continue;
      if (EVENT_UPDATE_FIELD_BLACKLIST.has(key)) {
        apiLogger.warn(
          { eventId, userId: ctx.userId, field: key, source: "mcp" },
          "agent:update_event field-not-allowed",
        );
        return {
          error:
            `Field "${key}" cannot be changed via MCP because it cascades to ` +
            `public URLs, scheduled emails, Zoom provisioning, or timezone math. ` +
            `Use the dashboard Settings page instead.`,
          code: "FIELD_NOT_ALLOWED",
          field: key,
        };
      }
      if (key !== "eventId" && !EVENT_UPDATE_FIELD_WHITELIST.has(key)) {
        apiLogger.warn(
          { eventId, userId: ctx.userId, field: key, source: "mcp" },
          "agent:update_event unknown-field",
        );
        return {
          error: `Unknown field "${key}". Allowed: ${[...EVENT_UPDATE_FIELD_WHITELIST].join(", ")}`,
          code: "UNKNOWN_FIELD",
          field: key,
        };
      }
    }

    const updates: Prisma.EventUpdateInput = {};

    if (input.name != null) {
      const n = String(input.name).trim();
      if (n.length < 2 || n.length > 255) {
        return { error: "name must be 2-255 chars", code: "INVALID_NAME" };
      }
      updates.name = n;
    }
    if (input.description !== undefined) {
      updates.description = input.description === null ? null : String(input.description).slice(0, 5000);
    }
    if (input.venue !== undefined) updates.venue = input.venue === null ? null : String(input.venue).slice(0, 255);
    if (input.address !== undefined) updates.address = input.address === null ? null : String(input.address).slice(0, 500);
    if (input.city !== undefined) updates.city = input.city === null ? null : String(input.city).slice(0, 255);
    if (input.country !== undefined) updates.country = input.country === null ? null : String(input.country).slice(0, 255);
    if (input.tag !== undefined) updates.tag = input.tag === null ? null : String(input.tag).slice(0, 255);
    if (input.specialty !== undefined) updates.specialty = input.specialty === null ? null : String(input.specialty).slice(0, 255);

    if (input.code !== undefined) {
      if (input.code === null || input.code === "") {
        updates.code = null;
      } else {
        const raw = String(input.code).trim().toUpperCase();
        if (raw.length > 20) return { error: "code must be at most 20 chars", code: "INVALID_CODE" };
        if (!CODE_RE.test(raw)) {
          return { error: "code must contain only A-Z, 0-9, and hyphens", code: "INVALID_CODE" };
        }
        updates.code = raw;
      }
    }

    if (input.taxRate !== undefined) {
      if (input.taxRate === null) {
        updates.taxRate = null;
      } else {
        const rate = Number(input.taxRate);
        if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
          return { error: "taxRate must be between 0 and 100", code: "INVALID_TAX_RATE" };
        }
        updates.taxRate = rate;
      }
    }
    if (input.taxLabel !== undefined) {
      updates.taxLabel = input.taxLabel === null ? null : String(input.taxLabel).slice(0, 50);
    }
    if (input.bankDetails !== undefined) {
      updates.bankDetails = input.bankDetails === null ? null : String(input.bankDetails).slice(0, 5000);
    }
    if (input.badgeVerticalOffset != null) {
      const offset = Math.round(Number(input.badgeVerticalOffset));
      if (!Number.isFinite(offset) || offset < -500 || offset > 500) {
        return { error: "badgeVerticalOffset must be between -500 and 500", code: "INVALID_BADGE_OFFSET" };
      }
      updates.badgeVerticalOffset = offset;
    }

    if (Object.keys(updates).length === 0) {
      return { error: "No fields provided to update", code: "NO_FIELDS" };
    }

    const updated = await db.event.update({
      where: { id: eventId },
      data: updates,
      select: {
        id: true,
        name: true,
        slug: true,
        code: true,
        venue: true,
        address: true,
        city: true,
        country: true,
        tag: true,
        specialty: true,
        taxRate: true,
        taxLabel: true,
        badgeVerticalOffset: true,
      },
    });

    db.auditLog.create({
      data: {
        eventId: updated.id,
        userId: ctx.userId,
        action: "UPDATE",
        entityType: "Event",
        entityId: updated.id,
        changes: { source: "mcp", fieldsChanged: Object.keys(updates) },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:update_event audit-log-failed"));

    return { success: true, event: updated };
  } catch (err) {
    apiLogger.error({ err }, "agent:update_event failed");
    return { error: err instanceof Error ? err.message : "Failed to update event" };
  }
};

export const EVENT_TOOL_DEFINITIONS: Tool[] = [
  {
    name: "list_event_info",
    description:
      "Get current event details including name, dates, venue, status, specialty, and counts of registrations, speakers, sessions, and tracks.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "list_tracks",
    description:
      "List all tracks for this event with their names, colors, descriptions, and session counts.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "create_track",
    description:
      "Create a new track for organizing sessions. Provide a name, optional color (hex like #3B82F6), and optional description.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Track name" },
        color: {
          type: "string",
          description: "Hex color code, e.g. #3B82F6",
          pattern: "^#[0-9A-Fa-f]{6}$",
        },
        description: { type: "string", description: "Optional description" },
      },
      required: ["name"],
    },
  },
];

export const EVENT_EXECUTORS: Record<string, ToolExecutor> = {
  list_event_info: listEventInfo,
  list_tracks: listTracks,
  create_track: createTrack,
  create_event: createEvent,
  update_event: updateEvent,
};
