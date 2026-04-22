/**
 * Speaker service — domain logic for creating an event speaker.
 *
 * Shared by the REST admin POST route and the MCP agent tool. Phase 0
 * previously patched drift in the MCP tool in-place (audit log, contact
 * sync, admin notification); this extraction consolidates both callers
 * onto one function so they can't drift again.
 *
 * Scope is single-create only. Bulk paths (`MCP create_speakers_bulk`,
 * import-from-registrations) use different mechanics (`createMany` with
 * `skipDuplicates`, per-row error capture loops) and aren't a fit for a
 * shared service yet — each has its own drift-tolerance profile.
 *
 * See src/services/README.md for the conventions.
 */

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { syncToContact } from "@/lib/contact-sync";
import { refreshEventStats } from "@/lib/event-stats";
import { notifyEventAdmins } from "@/lib/notifications";

// ── Input / Result types ─────────────────────────────────────────────────────

export type SpeakerStatus = "INVITED" | "CONFIRMED" | "DECLINED" | "CANCELLED";
export type SpeakerTitle = "DR" | "MR" | "MRS" | "MS" | "PROF";

export interface CreateSpeakerInput {
  eventId: string;
  organizationId: string;
  userId: string;

  // Required attendee fields
  email: string;
  firstName: string;
  lastName: string;

  // Optional attendee fields
  title?: SpeakerTitle | null;
  bio?: string | null;
  organization?: string | null;
  jobTitle?: string | null;
  phone?: string | null;
  website?: string | null;
  photo?: string | null;
  city?: string | null;
  country?: string | null;
  specialty?: string | null;
  registrationType?: string | null;
  tags?: string[];
  socialLinks?: { twitter?: string; linkedin?: string; github?: string };

  // Defaults to "INVITED" when omitted. Matches both REST and MCP behavior.
  status?: SpeakerStatus;

  source: "rest" | "mcp" | "api";
  requestIp?: string;
}

export type CreateSpeakerErrorCode =
  | "EVENT_NOT_FOUND"
  | "SPEAKER_ALREADY_EXISTS"
  | "UNKNOWN";

type SpeakerWithCounts = Prisma.SpeakerGetPayload<{
  include: { _count: { select: { sessions: true; abstracts: true } } };
}>;

export type CreateSpeakerResult =
  | {
      ok: true;
      speaker: SpeakerWithCounts;
    }
  | {
      ok: false;
      code: CreateSpeakerErrorCode;
      message: string;
      meta?: Record<string, unknown>;
    };

// ── Service ──────────────────────────────────────────────────────────────────

export async function createSpeaker(
  input: CreateSpeakerInput,
): Promise<CreateSpeakerResult> {
  const {
    eventId,
    organizationId,
    userId,
    email,
    firstName,
    lastName,
    title,
    bio,
    organization,
    jobTitle,
    phone,
    website,
    photo,
    city,
    country,
    specialty,
    registrationType,
    tags,
    socialLinks,
    status,
    source,
    requestIp,
  } = input;

  const normalizedEmail = email.trim().toLowerCase();

  // Normalize empty-string optional fields to null so direct-to-service
  // callers (future external APIs, tests) get the same semantics the REST
  // and MCP callers apply at their validation boundary. `?? null` alone
  // keeps `""`, which would bypass the Prisma title enum and fail at the DB.
  const normTitle = title ? title : null;
  const normBio = bio ? bio : null;
  const normOrg = organization ? organization : null;
  const normJobTitle = jobTitle ? jobTitle : null;
  const normPhone = phone ? phone : null;
  const normWebsite = website ? website : null;
  const normPhoto = photo ? photo : null;
  const normCity = city ? city : null;
  const normCountry = country ? country : null;
  const normSpecialty = specialty ? specialty : null;
  const normRegType = registrationType ? registrationType : null;

  // Parallelize event scope check + duplicate check.
  const [event, existingSpeaker] = await Promise.all([
    db.event.findFirst({
      where: { id: eventId, organizationId },
      select: { id: true },
    }),
    db.speaker.findFirst({
      where: { eventId, email: normalizedEmail },
      select: { id: true },
    }),
  ]);

  if (!event) {
    return { ok: false, code: "EVENT_NOT_FOUND", message: "Event not found" };
  }
  if (existingSpeaker) {
    return {
      ok: false,
      code: "SPEAKER_ALREADY_EXISTS",
      message: `A speaker with email ${normalizedEmail} already exists for this event`,
      meta: { existingSpeakerId: existingSpeaker.id },
    };
  }

  let speaker: SpeakerWithCounts;
  try {
    speaker = await db.speaker.create({
      data: {
        eventId,
        email: normalizedEmail,
        firstName,
        lastName,
        title: normTitle as SpeakerTitle | null,
        bio: normBio,
        organization: normOrg,
        jobTitle: normJobTitle,
        phone: normPhone,
        website: normWebsite,
        photo: normPhoto,
        city: normCity,
        country: normCountry,
        specialty: normSpecialty,
        registrationType: normRegType,
        tags: tags ?? [],
        socialLinks: socialLinks ?? {},
        status: status ?? "INVITED",
      },
      include: {
        _count: { select: { sessions: true, abstracts: true } },
      },
    });
  } catch (err) {
    // Safety net for P2002 unique-constraint race between the pre-check
    // above and the insert (concurrent admin/agent calls).
    if (err instanceof Error && err.message.includes("Unique constraint") && err.message.includes("email")) {
      return {
        ok: false,
        code: "SPEAKER_ALREADY_EXISTS",
        message: `A speaker with email ${normalizedEmail} already exists for this event`,
      };
    }
    apiLogger.error({ err }, "speaker-service:create-failed");
    return {
      ok: false,
      code: "UNKNOWN",
      message: err instanceof Error ? err.message : "Failed to create speaker",
    };
  }

  // Sync the full contact payload to the org-wide Contact store (awaited;
  // errors are caught inside syncToContact, never thrown here).
  await syncToContact({
    organizationId,
    eventId,
    email: normalizedEmail,
    firstName,
    lastName,
    title: normTitle,
    organization: normOrg,
    jobTitle: normJobTitle,
    phone: normPhone,
    photo: normPhoto,
    city: normCity,
    country: normCountry,
    bio: normBio,
    specialty: normSpecialty,
    registrationType: normRegType,
  });

  // Fire-and-forget audit log. `changes.source` identifies the caller;
  // REST attaches `ip`, MCP omits it.
  db.auditLog
    .create({
      data: {
        eventId,
        userId,
        action: "CREATE",
        entityType: "Speaker",
        entityId: speaker.id,
        changes: {
          source,
          email: normalizedEmail,
          ...(requestIp ? { ip: requestIp } : {}),
        },
      },
    })
    .catch((err) => apiLogger.error({ err }, "speaker-service:audit-log-failed"));

  // Refresh denormalized event stats (fire-and-forget).
  refreshEventStats(eventId);

  // Notify org admins of the new speaker (fire-and-forget).
  notifyEventAdmins(eventId, {
    type: "REGISTRATION",
    title: "Speaker Added",
    message:
      source === "mcp"
        ? `${firstName} ${lastName} added as speaker (via MCP)`
        : `${firstName} ${lastName} added as speaker`,
    link: `/events/${eventId}/speakers`,
  }).catch((err) => apiLogger.error({ err }, "speaker-service:notify-admins-failed"));

  return { ok: true, speaker };
}
