import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { normalizeTag } from "@/lib/utils";
import { syncToContact } from "@/lib/contact-sync";
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

const createSpeaker: ToolExecutor = async (input, ctx) => {
  try {
    const email = String(input.email ?? "").trim().toLowerCase();
    const firstName = String(input.firstName ?? "").trim();
    const lastName = String(input.lastName ?? "").trim();
    if (!email || !firstName || !lastName) {
      return { error: "email, firstName, and lastName are required" };
    }
    if (!EMAIL_RE.test(email)) return { error: "Invalid email format" };

    // Explicit pre-check so we can return the existing speaker's id. This lets
    // callers (like Claude) auto-pivot to update_speaker instead of needing a
    // second list_speakers call to find the existing row. The P2002 catch below
    // remains as a safety net for race conditions between this check and create.
    const existing = await db.speaker.findFirst({
      where: { eventId: ctx.eventId, email },
      select: { id: true },
    });
    if (existing) {
      return {
        error: `A speaker with email ${email} already exists for this event`,
        existingId: existing.id,
        suggestion: "Use update_speaker with speakerId to modify this speaker, or use a different email",
      };
    }

    const speaker = await db.speaker.create({
      data: {
        eventId: ctx.eventId,
        email,
        firstName,
        lastName,
        title: input.title as never ?? null,
        bio: input.bio ? String(input.bio) : null,
        organization: input.organization ? String(input.organization) : null,
        jobTitle: input.jobTitle ? String(input.jobTitle) : null,
        specialty: input.specialty ? String(input.specialty) : null,
        status: (input.status as never) ?? "INVITED",
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        status: true,
      },
    });
    return { success: true, speaker };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("Unique constraint") &&
      err.message.includes("email")
    ) {
      return {
        error: `A speaker with email ${input.email} already exists for this event`,
      };
    }
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

    const where: Prisma.SpeakerWhereInput = {
      eventId: ctx.eventId,
      status: { not: "CANCELLED" },
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

    const updated = await db.speaker.update({
      where: { id: speakerId },
      data: updates,
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

    return { success: true, speaker: updated };
  } catch (err) {
    apiLogger.error({ err }, "agent:update_speaker failed");
    return { error: err instanceof Error ? err.message : "Failed to update speaker" };
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
      "Add a new speaker to the event. Email, firstName, and lastName are required.",
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
        bio: { type: "string" },
        organization: { type: "string" },
        jobTitle: { type: "string" },
        specialty: { type: "string" },
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
  create_speaker: createSpeaker,
  update_speaker: updateSpeaker,
  create_speakers_bulk: createSpeakersBulk,
  list_speaker_agreements: listSpeakerAgreements,
  get_speaker_agreement_template: getSpeakerAgreementTemplate,
};
