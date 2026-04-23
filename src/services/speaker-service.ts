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

/**
 * Speaker's demographic / professional role. Mirrors the Prisma
 * `AttendeeRole` enum (same enum used by Attendee + Contact); listed
 * inline to keep this module Prisma-namespace-free at the input
 * boundary.
 */
export type SpeakerAttendeeRole =
  | "ACADEMIA"
  | "ALLIED_HEALTH"
  | "MEDICAL_DEVICES"
  | "PHARMA"
  | "PHYSICIAN"
  | "RESIDENT"
  | "SPEAKER"
  | "STUDENT"
  | "OTHERS";

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
  /** Demographic / professional classification (PHYSICIAN, STUDENT, ...). */
  role?: SpeakerAttendeeRole | null;
  /** Secondary email — cc on notifications. */
  additionalEmail?: string | null;
  bio?: string | null;
  organization?: string | null;
  jobTitle?: string | null;
  phone?: string | null;
  website?: string | null;
  photo?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  country?: string | null;
  specialty?: string | null;
  /** Free-text when `specialty === "Others"`. */
  customSpecialty?: string | null;
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
    role,
    additionalEmail,
    bio,
    organization,
    jobTitle,
    phone,
    website,
    photo,
    city,
    state,
    zipCode,
    country,
    specialty,
    customSpecialty,
    registrationType,
    tags,
    socialLinks,
    status,
    source,
    requestIp,
  } = input;

  const normalizedEmail = email.trim().toLowerCase();
  // `additionalEmail` is optional — coerce empty string to null AND trim +
  // lowercase when present, matching the registrant path's convention so
  // the DB column stays normalized regardless of which caller wrote it.
  const normAdditionalEmail = additionalEmail
    ? additionalEmail.trim().toLowerCase()
    : null;

  // Normalize empty-string optional fields to null so direct-to-service
  // callers (future external APIs, tests) get the same semantics the REST
  // and MCP callers apply at their validation boundary. `?? null` alone
  // keeps `""`, which would bypass the Prisma title enum and fail at the DB.
  const normTitle = title ? title : null;
  const normRole = role ? role : null;
  const normBio = bio ? bio : null;
  const normOrg = organization ? organization : null;
  const normJobTitle = jobTitle ? jobTitle : null;
  const normPhone = phone ? phone : null;
  const normWebsite = website ? website : null;
  const normPhoto = photo ? photo : null;
  const normCity = city ? city : null;
  const normState = state ? state : null;
  const normZipCode = zipCode ? zipCode : null;
  const normCountry = country ? country : null;
  const normSpecialty = specialty ? specialty : null;
  const normCustomSpecialty = customSpecialty ? customSpecialty : null;
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
        additionalEmail: normAdditionalEmail,
        firstName,
        lastName,
        title: normTitle as SpeakerTitle | null,
        role: normRole as SpeakerAttendeeRole | null,
        bio: normBio,
        organization: normOrg,
        jobTitle: normJobTitle,
        phone: normPhone,
        website: normWebsite,
        photo: normPhoto,
        city: normCity,
        state: normState,
        zipCode: normZipCode,
        country: normCountry,
        specialty: normSpecialty,
        customSpecialty: normCustomSpecialty,
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
  // errors are caught inside syncToContact, never thrown here). Contact
  // model mirrors Speaker 1:1 on the shared attendee fields so the new
  // role / additionalEmail / state / zipCode / customSpecialty all land.
  await syncToContact({
    organizationId,
    eventId,
    email: normalizedEmail,
    additionalEmail: normAdditionalEmail,
    firstName,
    lastName,
    title: normTitle,
    role: normRole,
    organization: normOrg,
    jobTitle: normJobTitle,
    phone: normPhone,
    photo: normPhoto,
    city: normCity,
    state: normState,
    zipCode: normZipCode,
    country: normCountry,
    bio: normBio,
    specialty: normSpecialty,
    customSpecialty: normCustomSpecialty,
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
