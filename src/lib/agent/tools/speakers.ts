import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { normalizeTag } from "@/lib/utils";
import { syncToContact } from "@/lib/contact-sync";
import { refreshEventStats } from "@/lib/event-stats";
import { notifyEventAdmins } from "@/lib/notifications";
import { checkRateLimit } from "@/lib/security";
import {
  createSpeaker,
  type SpeakerAttendeeRole,
  type SpeakerStatus,
  type SpeakerTitle,
} from "@/services/speaker-service";

// Mirrors Prisma's AttendeeRole enum — validated at the MCP boundary.
const ATTENDEE_ROLE_VALUES = new Set([
  "ACADEMIA", "ALLIED_HEALTH", "MEDICAL_DEVICES", "PHARMA",
  "PHYSICIAN", "RESIDENT", "SPEAKER", "STUDENT", "OTHERS",
]);
import {
  SPEAKER_AGREEMENT_TEMPLATE_MAX_SIZE,
  SpeakerAgreementTemplateError,
  saveSpeakerAgreementTemplate,
} from "@/lib/speaker-agreement";
import {
  EMAIL_RE,
  TITLE_VALUES,
  SPEAKER_STATUSES,
  type ToolExecutor,
} from "./_shared";

const BULK_MAX = 100;

const listSpeakers: ToolExecutor = async (input, ctx) => {
  try {
    const limit = Math.min(Number(input.limit ?? 50), 200);
    const statusValue = input.status ? String(input.status) : undefined;
    if (statusValue && !SPEAKER_STATUSES.has(statusValue)) {
      return { error: `Invalid status "${statusValue}". Must be one of: ${[...SPEAKER_STATUSES].join(", ")}` };
    }
    const speakers = await db.speaker.findMany({
      where: {
        eventId: ctx.eventId,
        ...(statusValue ? { status: statusValue as never } : {}),
      },
      select: {
        id: true,
        title: true,
        firstName: true,
        lastName: true,
        email: true,
        organization: true,
        jobTitle: true,
        specialty: true,
        status: true,
      },
      take: limit,
      orderBy: { createdAt: "desc" },
    });
    return { speakers, total: speakers.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_speakers failed");
    return { error: "Failed to fetch speakers" };
  }
};

const createSpeakerTool: ToolExecutor = async (input, ctx) => {
  try {
    const email = String(input.email ?? "").trim().toLowerCase();
    const firstName = String(input.firstName ?? "").trim();
    const lastName = String(input.lastName ?? "").trim();
    if (!email || !firstName || !lastName) {
      return { error: "email, firstName, and lastName are required" };
    }
    if (!EMAIL_RE.test(email)) return { error: "Invalid email format" };

    const rawTitle = input.title ? String(input.title) : undefined;
    if (rawTitle && !TITLE_VALUES.has(rawTitle)) {
      return { error: `Invalid title. Must be one of: ${[...TITLE_VALUES].join(", ")}` };
    }
    const rawStatus = input.status ? String(input.status) : undefined;
    if (rawStatus && !SPEAKER_STATUSES.has(rawStatus)) {
      return { error: `Invalid status. Must be one of: ${[...SPEAKER_STATUSES].join(", ")}` };
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

    const result = await createSpeaker({
      eventId: ctx.eventId,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      email,
      firstName,
      lastName,
      title: (rawTitle as SpeakerTitle | undefined) ?? null,
      role: (rawRole as SpeakerAttendeeRole | undefined) ?? null,
      additionalEmail: rawAdditionalEmail ?? null,
      bio: input.bio ? String(input.bio).slice(0, 5000) : null,
      organization: input.organization ? String(input.organization).slice(0, 255) : null,
      jobTitle: input.jobTitle ? String(input.jobTitle).slice(0, 255) : null,
      phone: input.phone ? String(input.phone).slice(0, 50) : null,
      city: input.city ? String(input.city).slice(0, 255) : null,
      state: input.state ? String(input.state).slice(0, 255) : null,
      zipCode: input.zipCode ? String(input.zipCode).slice(0, 20) : null,
      country: input.country ? String(input.country).slice(0, 255) : null,
      photo: input.photo ? String(input.photo).slice(0, 500) : null,
      specialty: input.specialty ? String(input.specialty).slice(0, 255) : null,
      customSpecialty: input.customSpecialty ? String(input.customSpecialty).slice(0, 255) : null,
      registrationType: input.registrationType ? String(input.registrationType).slice(0, 255) : null,
      status: (rawStatus as SpeakerStatus | undefined) ?? "INVITED",
      source: "mcp",
    });

    if (!result.ok) {
      // Preserve the MCP auto-pivot hint on duplicate so Claude knows to
      // call update_speaker instead of retrying.
      if (result.code === "SPEAKER_ALREADY_EXISTS") {
        return {
          error: result.message,
          code: result.code,
          existingId: result.meta?.existingSpeakerId,
          suggestion: "Use update_speaker with speakerId to modify this speaker, or use a different email",
        };
      }
      return { error: result.message, code: result.code, ...(result.meta ?? {}) };
    }

    // Preserve the pre-refactor MCP response shape (slim select).
    return {
      success: true,
      speaker: {
        id: result.speaker.id,
        firstName: result.speaker.firstName,
        lastName: result.speaker.lastName,
        email: result.speaker.email,
        status: result.speaker.status,
      },
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_speaker failed");
    return { error: "Failed to create speaker" };
  }
};

const listSpeakerAgreements: ToolExecutor = async (input, ctx) => {
  try {
    const filter = input.filter ? String(input.filter) : "unsigned";
    if (!["signed", "unsigned", "all"].includes(filter)) {
      return { error: `Invalid filter. Must be: signed, unsigned, or all` };
    }
    const limit = Math.min(Number(input.limit ?? 100), 500);

    // Exclude CANCELLED always. For the "unsigned" filter also exclude
    // DECLINED — chasing declined speakers for signatures is operationally
    // wrong (F10). "all" and "signed" keep DECLINED visible so operators
    // can still audit the full list.
    const where: Prisma.SpeakerWhereInput = {
      eventId: ctx.eventId,
      status: filter === "unsigned" ? { notIn: ["CANCELLED", "DECLINED"] } : { not: "CANCELLED" },
    };
    if (filter === "signed") where.agreementAcceptedAt = { not: null };
    if (filter === "unsigned") where.agreementAcceptedAt = null;

    const speakers = await db.speaker.findMany({
      where,
      select: {
        id: true,
        title: true,
        firstName: true,
        lastName: true,
        email: true,
        status: true,
        organization: true,
        agreementAcceptedAt: true,
      },
      take: limit,
      orderBy: [{ agreementAcceptedAt: { sort: "asc", nulls: "first" } }, { lastName: "asc" }],
    });

    return { filter, speakers, total: speakers.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_speaker_agreements failed");
    return { error: "Failed to list speaker agreements" };
  }
};


const updateSpeaker: ToolExecutor = async (input, ctx) => {
  try {
    const speakerId = String(input.speakerId ?? "").trim();
    if (!speakerId) return { error: "speakerId is required" };

    const existing = await db.speaker.findFirst({
      where: { id: speakerId, event: { organizationId: ctx.organizationId } },
      select: { id: true, eventId: true, email: true, firstName: true, lastName: true, status: true },
    });
    if (!existing) return { error: `Speaker ${speakerId} not found or access denied` };

    const status = input.status ? String(input.status) : undefined;
    if (status && !SPEAKER_STATUSES.has(status)) {
      return { error: `Invalid status. Must be one of: ${[...SPEAKER_STATUSES].join(", ")}` };
    }

    const updates: Prisma.SpeakerUpdateInput = {};
    if (status) updates.status = status as never;
    if (input.title != null) {
      const t = String(input.title);
      if (t === "") updates.title = null;
      else if (TITLE_VALUES.has(t)) updates.title = t as never;
      else return { error: `Invalid title. Must be one of: ${[...TITLE_VALUES].join(", ")}` };
    }
    if (input.firstName != null) updates.firstName = String(input.firstName).slice(0, 100);
    if (input.lastName != null) updates.lastName = String(input.lastName).slice(0, 100);
    if (input.bio != null) updates.bio = String(input.bio).slice(0, 5000);
    if (input.organization != null) updates.organization = String(input.organization).slice(0, 255);
    if (input.jobTitle != null) updates.jobTitle = String(input.jobTitle).slice(0, 255);
    if (input.phone != null) updates.phone = String(input.phone).slice(0, 50);
    if (input.city != null) updates.city = String(input.city).slice(0, 255);
    if (input.country != null) updates.country = String(input.country).slice(0, 255);
    if (input.specialty != null) updates.specialty = String(input.specialty).slice(0, 255);
    if (input.website != null) updates.website = String(input.website).slice(0, 500);
    if (input.photo !== undefined) updates.photo = input.photo as string | null;
    if (Array.isArray(input.tags)) {
      updates.tags = (input.tags as unknown[])
        .map((t) => normalizeTag(String(t).slice(0, 100)))
        .filter(Boolean);
    }

    if (Object.keys(updates).length === 0) {
      return { error: "No fields provided to update" };
    }

    // Optimistic-lock token (W2-F8 fix): when supplied, the conditional
    // updateMany rejects writes that would silently overwrite a concurrent
    // edit. Optional during rollout — missing tokens fall back to the
    // legacy unconditional path with a warn log.
    const expectedUpdatedAt = typeof input.expectedUpdatedAt === "string" ? input.expectedUpdatedAt : null;
    if (!expectedUpdatedAt) {
      apiLogger.warn({
        msg: "optimistic-lock:missing-expectedUpdatedAt",
        resource: "speaker",
        resourceId: speakerId,
        source: "mcp",
      });
    }

    const updateResult = await db.speaker.updateMany({
      where: {
        id: speakerId,
        ...(expectedUpdatedAt && { updatedAt: new Date(expectedUpdatedAt) }),
      },
      data: { ...updates, updatedAt: new Date() },
    });
    if (updateResult.count === 0) {
      // Distinguish the row-gone case from a stale-write rejection.
      const stillExists = await db.speaker.findFirst({
        where: { id: speakerId, event: { organizationId: ctx.organizationId } },
        select: { id: true },
      });
      if (!stillExists) return { error: `Speaker ${speakerId} not found or access denied` };
      apiLogger.info({ msg: "speaker:stale-write-rejected", speakerId, source: "mcp" });
      return {
        error: "This speaker was modified after you fetched it. Re-read the row and retry with the new updatedAt.",
        code: "STALE_WRITE",
      };
    }

    const updated = await db.speaker.findUniqueOrThrow({
      where: { id: speakerId },
      select: {
        id: true,
        title: true,
        firstName: true,
        lastName: true,
        email: true,
        status: true,
        organization: true,
        jobTitle: true,
      },
    });

    await db.auditLog.create({
      data: {
        eventId: existing.eventId,
        userId: ctx.userId,
        action: "UPDATE",
        entityType: "Speaker",
        entityId: speakerId,
        changes: {
          source: "mcp",
          before: { status: existing.status },
          after: { status: updated.status },
          fieldsChanged: Object.keys(updates),
        },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:update_speaker audit-log-failed"));

    syncToContact({
      organizationId: ctx.organizationId,
      eventId: existing.eventId,
      email: updated.email,
      firstName: updated.firstName,
      lastName: updated.lastName,
    }).catch((err) => apiLogger.error({ err }, "agent:update_speaker contact-sync-failed"));

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(ctx.eventId);

    return { success: true, speaker: updated };
  } catch (err) {
    apiLogger.error({ err }, "agent:update_speaker failed");
    return { error: err instanceof Error ? err.message : "Failed to update speaker" };
  }
};

// Upload a .docx mail-merge template for an event via MCP. Shares the exact
// same storage/validation path as the dashboard POST endpoint via the
// factored `saveSpeakerAgreementTemplate()` helper — no drift risk.
//
// Transport note: MCP is JSON-RPC only (no multipart), so the caller has to
// base64-encode the .docx bytes. 2MB pre-encode cap + magic-byte check are
// enforced identically to the dashboard route.
const uploadSpeakerAgreementTemplate: ToolExecutor = async (input, ctx) => {
  try {
    // Same per-user 10/hr bucket as the dashboard upload route so this tool
    // can't be used to bypass that quota.
    const UPLOAD_LIMIT = 10;
    const UPLOAD_WINDOW_MS = 60 * 60 * 1000;
    const rl = checkRateLimit({
      key: `agreement-template-upload:${ctx.userId}`,
      limit: UPLOAD_LIMIT,
      windowMs: UPLOAD_WINDOW_MS,
    });
    if (!rl.allowed) {
      return {
        error: `Rate limit exceeded: ${UPLOAD_LIMIT} speaker-agreement template uploads per hour. Retry after ${rl.retryAfterSeconds}s.`,
        code: "RATE_LIMITED",
        retryAfterSeconds: rl.retryAfterSeconds,
        limit: UPLOAD_LIMIT,
        windowSeconds: Math.floor(UPLOAD_WINDOW_MS / 1000),
      };
    }

    const base64Content = input.base64Content ? String(input.base64Content) : "";
    const filename = input.filename ? String(input.filename) : "";
    if (!base64Content) return { error: "base64Content is required (base64-encoded .docx bytes)", code: "MISSING_CONTENT" };
    if (!filename) return { error: "filename is required", code: "MISSING_FILENAME" };
    if (!/\.docx$/i.test(filename)) {
      return { error: "filename must end with .docx", code: "INVALID_FILENAME" };
    }

    // Reject anything that obviously won't decode before we materialize the
    // buffer — keeps the error surface local to this tool.
    if (!/^[A-Za-z0-9+/=\s]+$/.test(base64Content)) {
      return { error: "base64Content contains invalid characters", code: "INVALID_BASE64" };
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(base64Content, "base64");
    } catch {
      return { error: "Failed to decode base64Content", code: "INVALID_BASE64" };
    }
    if (buffer.length === 0) {
      return { error: "Decoded content is empty", code: "EMPTY_CONTENT" };
    }
    if (buffer.length > SPEAKER_AGREEMENT_TEMPLATE_MAX_SIZE) {
      return {
        error: `Decoded template must be under ${Math.round(SPEAKER_AGREEMENT_TEMPLATE_MAX_SIZE / 1024 / 1024)}MB (got ${buffer.length} bytes)`,
        code: "TEMPLATE_TOO_LARGE",
      };
    }

    try {
      const meta = await saveSpeakerAgreementTemplate({
        eventId: ctx.eventId,
        organizationId: ctx.organizationId,
        buffer,
        filename,
        actorUserId: ctx.userId,
      });

      db.auditLog.create({
        data: {
          eventId: ctx.eventId,
          userId: ctx.userId,
          action: "UPDATE",
          entityType: "Event",
          entityId: ctx.eventId,
          changes: {
            source: "mcp",
            field: "speakerAgreementTemplate",
            filename: meta.filename,
          },
        },
      }).catch((err) => apiLogger.error({ err }, "agent:upload_speaker_agreement_template audit-log-failed"));

      apiLogger.info(
        { eventId: ctx.eventId, filename: meta.filename, actorUserId: ctx.userId },
        "agreement-template:uploaded-via-mcp",
      );

      return { success: true, template: meta };
    } catch (err) {
      if (err instanceof SpeakerAgreementTemplateError) {
        return { error: err.message, code: err.code };
      }
      throw err;
    }
  } catch (err) {
    apiLogger.error({ err }, "agent:upload_speaker_agreement_template failed");
    return {
      error: "Failed to upload speaker agreement template",
      code: "UNKNOWN",
      details: err instanceof Error ? err.message : "Unknown error",
    };
  }
};

const getSpeakerAgreementTemplate: ToolExecutor = async (_input, ctx) => {
  try {
    const event = await db.event.findFirst({
      where: { id: ctx.eventId, organizationId: ctx.organizationId },
      select: { speakerAgreementTemplate: true },
    });
    if (!event) return { error: "Event not found or access denied" };

    return { template: event.speakerAgreementTemplate ?? null };
  } catch (err) {
    apiLogger.error({ err }, "agent:get_speaker_agreement_template failed");
    return { error: "Failed to fetch speaker agreement template" };
  }
};

const createSpeakersBulk: ToolExecutor = async (input, ctx) => {
  try {
    const items = Array.isArray(input.speakers) ? (input.speakers as unknown[]) : null;
    if (!items || !items.length) return { error: "speakers must be a non-empty array", code: "MISSING_SPEAKERS" };
    if (items.length > BULK_MAX) {
      return { error: `Max ${BULK_MAX} speakers per call; got ${items.length}`, code: "TOO_MANY_ROWS" };
    }

    // Pre-flight: de-dup the input by lowercased email so a duplicate row in
    // the same payload doesn't race against itself with a unique-constraint 500.
    const seenEmails = new Set<string>();
    const created: Array<{ index: number; id: string; email: string; firstName: string; lastName: string }> = [];
    const errors: Array<{ index: number; email?: string; error: string; code?: string }> = [];

    for (let i = 0; i < items.length; i++) {
      const row = items[i] as Record<string, unknown>;
      try {
        const email = String(row.email ?? "").trim().toLowerCase();
        const firstName = String(row.firstName ?? "").trim();
        const lastName = String(row.lastName ?? "").trim();
        if (!email || !firstName || !lastName) {
          errors.push({ index: i, email: email || undefined, error: "email, firstName, lastName required", code: "MISSING_FIELDS" });
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

        const title = row.title ? String(row.title) : undefined;
        if (title && !TITLE_VALUES.has(title)) {
          errors.push({ index: i, email, error: `Invalid title; must be one of ${[...TITLE_VALUES].join(", ")}`, code: "INVALID_TITLE" });
          continue;
        }
        const status = row.status ? String(row.status) : undefined;
        if (status && !SPEAKER_STATUSES.has(status)) {
          errors.push({ index: i, email, error: `Invalid status; must be one of ${[...SPEAKER_STATUSES].join(", ")}`, code: "INVALID_STATUS" });
          continue;
        }

        const existing = await db.speaker.findFirst({
          where: { eventId: ctx.eventId, email },
          select: { id: true },
        });
        if (existing) {
          errors.push({ index: i, email, error: `Speaker with email ${email} already exists`, code: "ALREADY_EXISTS" });
          continue;
        }

        const speaker = await db.speaker.create({
          data: {
            eventId: ctx.eventId,
            email,
            firstName,
            lastName,
            title: (title as never) ?? null,
            bio: row.bio ? String(row.bio).slice(0, 5000) : null,
            organization: row.organization ? String(row.organization).slice(0, 255) : null,
            jobTitle: row.jobTitle ? String(row.jobTitle).slice(0, 255) : null,
            phone: row.phone ? String(row.phone).slice(0, 50) : null,
            specialty: row.specialty ? String(row.specialty).slice(0, 255) : null,
            status: (status as never) ?? "INVITED",
          },
          select: { id: true, email: true, firstName: true, lastName: true },
        });
        created.push({ index: i, ...speaker });
      } catch (err) {
        const email = (items[i] as { email?: string }).email;
        const message = err instanceof Error ? err.message : "Unknown error";
        errors.push({ index: i, email, error: message, code: "ROW_FAILED" });
        // Per-row visibility for ops — the aggregate info log at the end only
        // says "X failed", which isn't enough to diagnose a systematic bug
        // (e.g., every row tripping the same unique-constraint race).
        apiLogger.warn(
          { err, eventId: ctx.eventId, index: i, email },
          "agent:create_speakers_bulk row-failed",
        );
      }
    }

    apiLogger.info(
      { eventId: ctx.eventId, created: created.length, failed: errors.length, total: items.length },
      "agent:create_speakers_bulk",
    );

    // Only audit when at least one row was created. A 0/N batch is noise in
    // the audit log (per-row failures are visible via the warn logs above).
    if (created.length > 0) {
      db.auditLog.create({
        data: {
          eventId: ctx.eventId,
          userId: ctx.userId,
          action: "CREATE",
          entityType: "Speaker",
          entityId: `bulk:${created.length}`,
          changes: { source: "mcp", bulk: true, created: created.length, failed: errors.length },
        },
      }).catch((err) => apiLogger.error({ err }, "agent:create_speakers_bulk audit-log-failed"));

      // Refresh denormalized event stats (fire-and-forget)
      refreshEventStats(ctx.eventId);

      // Parity with REST — one batched notification per bulk call (not per-row,
      // to avoid swamping the admins' inbox on a 100-row import).
      notifyEventAdmins(ctx.eventId, {
        type: "REGISTRATION",
        title: "Speakers Added (Bulk)",
        message: `${created.length} speaker${created.length === 1 ? "" : "s"} added via MCP bulk import${errors.length ? ` (${errors.length} failed)` : ""}`,
        link: `/events/${ctx.eventId}/speakers`,
      }).catch((err) => apiLogger.error({ err }, "agent:create_speakers_bulk notify-admins-failed"));
    }

    return {
      success: true,
      createdCount: created.length,
      failedCount: errors.length,
      created,
      errors,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_speakers_bulk failed");
    return { error: err instanceof Error ? err.message : "Failed to bulk-create speakers" };
  }
};

export const SPEAKER_TOOL_DEFINITIONS: Tool[] = [
  {
    name: "list_speakers",
    description:
      "List speakers for this event. Optionally filter by status: INVITED, CONFIRMED, DECLINED, or CANCELLED.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["INVITED", "CONFIRMED", "DECLINED", "CANCELLED"],
          description: "Filter by speaker status",
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
    name: "create_speaker",
    description:
      "Add a new speaker to the event. Email, firstName, and lastName are required. Notifies org admins and syncs to the org-wide Contact store.",
    input_schema: {
      type: "object" as const,
      properties: {
        email: { type: "string", description: "Speaker email address" },
        firstName: { type: "string" },
        lastName: { type: "string" },
        title: {
          type: "string",
          enum: ["DR", "MR", "MRS", "MS", "PROF"],
          description: "Honorific title",
        },
        role: {
          type: "string",
          enum: ["ACADEMIA", "ALLIED_HEALTH", "MEDICAL_DEVICES", "PHARMA", "PHYSICIAN", "RESIDENT", "SPEAKER", "STUDENT", "OTHERS"],
          description: "Speaker demographic/professional role. Same enum as Attendee/Contact.",
        },
        additionalEmail: {
          type: "string",
          description: "Secondary email (cc on notifications). Optional.",
        },
        bio: { type: "string" },
        organization: { type: "string" },
        jobTitle: { type: "string" },
        phone: { type: "string" },
        city: { type: "string" },
        state: { type: "string" },
        zipCode: { type: "string" },
        country: { type: "string" },
        photo: { type: "string", description: "Photo URL or relative path (e.g. /uploads/photos/...)" },
        specialty: { type: "string" },
        customSpecialty: {
          type: "string",
          description: "Free-text specialty when `specialty` is 'Others'.",
        },
        registrationType: { type: "string" },
        status: {
          type: "string",
          enum: ["INVITED", "CONFIRMED", "DECLINED", "CANCELLED"],
          description: "Default is INVITED",
        },
      },
      required: ["email", "firstName", "lastName"],
    },
  },
];

export const SPEAKER_EXECUTORS: Record<string, ToolExecutor> = {
  list_speakers: listSpeakers,
  create_speaker: createSpeakerTool,
  update_speaker: updateSpeaker,
  create_speakers_bulk: createSpeakersBulk,
  list_speaker_agreements: listSpeakerAgreements,
  get_speaker_agreement_template: getSpeakerAgreementTemplate,
  upload_speaker_agreement_template: uploadSpeakerAgreementTemplate,
};
