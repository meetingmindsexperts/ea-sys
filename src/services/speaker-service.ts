/**
 * Speaker service — domain logic for creating and updating an event speaker.
 *
 *   createSpeaker()        — single-create. REST POST + MCP `create_speaker`.
 *   updateSpeaker()        — single-update. REST PUT + MCP `update_speaker`.
 *   cascadeSpeakerDecline()— the companion-registration side of a decline.
 *
 * Shared by the REST admin routes and the MCP agent tools. Phase 0 previously
 * patched drift in the MCP tools in-place (audit log, contact sync, admin
 * notification); these extractions consolidate both callers onto one function
 * per operation so they can't drift again — which they demonstrably do when
 * left duplicated (contacts review H4: the update path was NOT extracted with
 * the create, and its MCP copy quietly stopped syncing the speaker's profile
 * to the org Contact store).
 *
 * Scope is single create/update only. Bulk paths (`MCP create_speakers_bulk`,
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
import { ensureSpeakerCompanionRegistration } from "@/lib/speaker-companion";
import { runOptimisticUpdate } from "@/lib/optimistic-lock";
import { syncSpeakerTagsToRegistrations, computeTagDelta } from "@/lib/person-tag-sync";
import { cancelRegistration } from "./payment-service";

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

  // Ensure the companion registration (the "attendee facet") so this speaker
  // receives badge / entry barcode / DTCM / check-in / survey via the normal
  // registration machinery. Failure-isolated — a hiccup must NOT fail the
  // speaker create; the backfill script recovers any that fail.
  try {
    await ensureSpeakerCompanionRegistration({
      id: speaker.id,
      eventId,
      email: normalizedEmail,
      firstName,
      lastName,
      title: normTitle,
      additionalEmail: normAdditionalEmail,
      organization: normOrg,
      jobTitle: normJobTitle,
      phone: normPhone,
      photo: normPhoto,
      city: normCity,
      state: normState,
      zipCode: normZipCode,
      country: normCountry,
      specialty: normSpecialty,
      registrationType: normRegType,
      role: normRole as SpeakerAttendeeRole | null,
      sourceRegistrationId: null,
    });
  } catch (err) {
    apiLogger.error({ err, speakerId: speaker.id, eventId }, "speaker-service:companion-failed");
  }

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

// ── Speaker-status → companion-registration cascade ──────────────────────────
//
// A speaker set to DECLINED/CANCELLED used to keep a CONFIRMED companion
// registration — i.e. a valid entry barcode, a printable badge, and check-in
// eligibility — forever, unless someone remembered to cancel it by hand
// (July 11 door-day fix; roadmap "Speaker ↔ companion lifecycle" MED).
//
// Owner decisions (July 11, 2026):
//  - The cascade applies ONLY to the auto-minted SPEAKER_COMPANION registration
//    (comp Faculty row, no money). A REAL linked registration is the person's
//    own — declining to speak ≠ not attending — so the caller/UI surfaces a
//    "review their registration" reminder instead of touching it.
//  - The cascade is opt-in per call (`cancelCompanion`); the UI asks the
//    operator ("Also cancel their registration?" vs "Keep it"), and the MCP
//    tool exposes the flag with a keep-by-default.
//
// ONE implementation for both status-write callers (REST speaker PUT + MCP
// update_speaker) per the no-cross-caller-duplication rule; the cancel itself
// delegates to payment-service.cancelRegistration (the single cancel domain op
// — claim + seat/promo transition + audit + checkout-session cleanup).

/** Statuses that mean "this speaker is out". */
export const SPEAKER_OUT_STATUSES = new Set<string>(["DECLINED", "CANCELLED"]);

/** True when this status write is a transition INTO declined/cancelled. */
export function isSpeakerDeclineTransition(prevStatus: string, nextStatus: string | undefined): boolean {
  return (
    !!nextStatus &&
    SPEAKER_OUT_STATUSES.has(nextStatus) &&
    !SPEAKER_OUT_STATUSES.has(prevStatus)
  );
}

export type SpeakerDeclineCompanionOutcome =
  /** Speaker has no linked registration at all. */
  | "none"
  /** Linked registration is a REAL one (not the auto companion) — untouched;
   *  the operator should review it separately. */
  | "real-registration"
  /** Companion exists and was deliberately kept (operator chose, or MCP default). */
  | "kept"
  /** Companion was already cancelled — nothing to do. */
  | "already-cancelled"
  /** Companion was cancelled by this call (badge + entry barcode revoked). */
  | "cancelled"
  /** Cancel was requested but failed — companion still active; logged. */
  | "cancel-failed";

export interface SpeakerDeclineCascadeResult {
  companion: SpeakerDeclineCompanionOutcome;
  registrationId?: string;
}

/**
 * Handle the companion-registration side of a speaker moving to
 * DECLINED/CANCELLED. Never throws — a cascade hiccup must not fail the
 * speaker-status write that already committed (the caller reports the
 * outcome instead).
 */
export async function cascadeSpeakerDecline(input: {
  eventId: string;
  organizationId: string;
  speakerId: string;
  sourceRegistrationId: string | null;
  /** Operator's choice: cancel the companion registration too? */
  cancelCompanion: boolean;
  source: "rest" | "mcp";
  actorUserId?: string | null;
}): Promise<SpeakerDeclineCascadeResult> {
  const { eventId, organizationId, speakerId, sourceRegistrationId, cancelCompanion, source, actorUserId } = input;
  try {
    if (!sourceRegistrationId) return { companion: "none" };

    const reg = await db.registration.findFirst({
      where: { id: sourceRegistrationId, eventId },
      select: { id: true, status: true, createdSource: true },
    });
    if (!reg) return { companion: "none" };

    // A real (email-linked / self-registered, possibly paid) registration is
    // never cascade-cancelled from a speaker-status change.
    if (reg.createdSource !== "SPEAKER_COMPANION") {
      return { companion: "real-registration", registrationId: reg.id };
    }
    if (reg.status === "CANCELLED") {
      return { companion: "already-cancelled", registrationId: reg.id };
    }

    if (!cancelCompanion) {
      // Deliberate keep — the person still attends (e.g. committee member who
      // declined a speaking slot). Leave a trace for the door-day audit trail.
      apiLogger.info({
        msg: "speaker-decline:companion-kept",
        eventId, speakerId, registrationId: reg.id, source, actorUserId: actorUserId ?? null,
      });
      return { companion: "kept", registrationId: reg.id };
    }

    const res = await cancelRegistration({
      registrationId: reg.id,
      eventId,
      organizationId,
      refund: false, // companion is comp — no money to move
      source,
      issuedByUserId: actorUserId ?? null,
    });
    if (!res.ok && res.code !== "ALREADY_CANCELLED") {
      apiLogger.error({
        msg: "speaker-decline:companion-cancel-failed",
        eventId, speakerId, registrationId: reg.id, code: res.code, source,
      });
      return { companion: "cancel-failed", registrationId: reg.id };
    }

    apiLogger.info({
      msg: "speaker-decline:companion-cancelled",
      eventId, speakerId, registrationId: reg.id, source, actorUserId: actorUserId ?? null,
    }, "Companion registration cancelled with speaker decline — badge + entry barcode revoked");

    // Extra audit row tying the cancellation to the speaker decline (the
    // cancel itself already wrote REGISTRATION_CANCELLED).
    db.auditLog
      .create({
        data: {
          eventId,
          userId: actorUserId ?? null,
          action: "SPEAKER_COMPANION_CANCELLED",
          entityType: "Registration",
          entityId: reg.id,
          changes: { source, speakerId, reason: "speaker-declined" },
        },
      })
      .catch((err) => apiLogger.warn({ err, msg: "speaker-decline:audit-write-failed", speakerId }));

    return { companion: "cancelled", registrationId: reg.id };
  } catch (err) {
    apiLogger.error({ err, msg: "speaker-decline:cascade-unknown-failure", eventId, speakerId });
    return { companion: "cancel-failed", registrationId: sourceRegistrationId ?? undefined };
  }
}

// ── updateSpeaker (cross-caller #6) ──────────────────────────────────────────
//
// The single-update path, shared by the REST speaker PUT and MCP
// `update_speaker`. Extracted July 14, 2026 for contacts review H4: the two
// callers were mirrored ~full implementations and had DRIFTED — the MCP one
// synced only `{ email, firstName, lastName }` to the org Contact store while
// REST synced ~13 fields. Because `syncToContact` is enrich-only, a name+email
// payload against an existing contact is a NO-OP: the call succeeded, logged
// nothing, and changed nothing, so every agent/n8n speaker edit (phone,
// affiliation, job title…) silently never reached the CRM — and, since the
// central mirror enriches its scalars from Contact, never reached the EU
// mirror either.
//
// This is the same class the team fixed for registrations on July 13
// (`registration-service.updateRegistration`), and it recurred here for exactly
// the reason the house rule predicts: only `createSpeaker` had been extracted,
// so the UPDATE stayed duplicated and the copies drifted.
//
// Boundaries kept OUT of the service (they belong to the caller):
//   REST — session auth, denyReviewer, the EMAIL_IMMUTABLE guard, Zod parsing,
//          the org-scoped event lookup, HTTP status mapping, response shape.
//   MCP  — loose-input coercion/validation (String(...), title/status enums),
//          the org-scoped speaker lookup, JSON-RPC response shape.
// The service owns everything below that: the optimistic-locked write, the tag
// mirror onto the registration facet, the decline cascade, the FULL contact
// sync, the audit row, and the stats refresh.

/** Fields an update may set. `undefined` = "leave alone"; `null` = "clear". */
export interface UpdateSpeakerFields {
  title?: SpeakerTitle | null;
  role?: SpeakerAttendeeRole | null;
  firstName?: string;
  lastName?: string;
  additionalEmail?: string | null;
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
  status?: SpeakerStatus;
}

export interface UpdateSpeakerInput {
  speakerId: string;
  eventId: string;
  organizationId: string;
  /** Already-parsed + validated by the caller (Zod on REST, coercion on MCP). */
  fields: UpdateSpeakerFields;
  /** ISO string; when present the write is conditional on it (optimistic lock). */
  expectedUpdatedAt?: string | null;
  /** Decline cascade: revoke the companion registration's badge + barcode too? */
  cancelCompanionRegistration?: boolean;
  source: "rest" | "mcp" | "api";
  actorUserId?: string | null;
  requestIp?: string;
}

export type UpdateSpeakerErrorCode =
  | "SPEAKER_NOT_FOUND"
  | "NO_FIELDS"
  | "STALE_WRITE"
  | "UNKNOWN";

export type UpdateSpeakerResult =
  | {
      ok: true;
      speaker: SpeakerWithCounts;
      /** Present only when this write was a transition into DECLINED/CANCELLED. */
      companionCascade: SpeakerDeclineCascadeResult | null;
    }
  | {
      ok: false;
      code: UpdateSpeakerErrorCode;
      message: string;
      meta?: Record<string, unknown>;
    };

export async function updateSpeaker(
  input: UpdateSpeakerInput,
): Promise<UpdateSpeakerResult> {
  const {
    speakerId,
    eventId,
    organizationId,
    fields,
    expectedUpdatedAt,
    cancelCompanionRegistration = false,
    source,
    actorUserId = null,
    requestIp,
  } = input;

  try {
    // Bind the row to BOTH the speaker id and the event — a mis-scoped caller
    // can't reach a sibling event's speaker (the same bind registration-service
    // added for its M1).
    const existing = await db.speaker.findFirst({
      where: { id: speakerId, eventId },
    });
    if (!existing) {
      return {
        ok: false,
        code: "SPEAKER_NOT_FOUND",
        message: `Speaker ${speakerId} not found or access denied`,
      };
    }

    // Build the change set. `undefined` is skipped; empty string collapses to
    // null (clear) — trimmed first so trailing whitespace can't slip a phantom
    // value past the clear path.
    const data: Prisma.SpeakerUncheckedUpdateInput = {
      ...(fields.title !== undefined && { title: fields.title || null }),
      ...(fields.role !== undefined && { role: fields.role || null }),
      ...(fields.firstName && { firstName: fields.firstName }),
      ...(fields.lastName && { lastName: fields.lastName }),
      ...(fields.additionalEmail !== undefined && {
        additionalEmail: fields.additionalEmail?.trim() || null,
      }),
      ...(fields.bio !== undefined && { bio: fields.bio || null }),
      ...(fields.organization !== undefined && { organization: fields.organization || null }),
      ...(fields.jobTitle !== undefined && { jobTitle: fields.jobTitle || null }),
      ...(fields.phone !== undefined && { phone: fields.phone || null }),
      ...(fields.website !== undefined && { website: fields.website || null }),
      ...(fields.photo !== undefined && { photo: fields.photo || null }),
      ...(fields.city !== undefined && { city: fields.city || null }),
      ...(fields.country !== undefined && { country: fields.country || null }),
      ...(fields.specialty !== undefined && { specialty: fields.specialty || null }),
      ...(fields.registrationType !== undefined && {
        registrationType: fields.registrationType || null,
      }),
      ...(fields.tags !== undefined && { tags: fields.tags }),
      ...(fields.socialLinks && { socialLinks: fields.socialLinks }),
      ...(fields.status && { status: fields.status }),
    };

    if (Object.keys(data).length === 0) {
      return { ok: false, code: "NO_FIELDS", message: "No fields provided to update" };
    }

    const lock = await runOptimisticUpdate({
      model: db.speaker,
      where: { id: speakerId, eventId },
      // Explicit bump so the version token moves even when no column changes.
      data: { ...data, updatedAt: new Date() },
      expectedUpdatedAt,
      resourceLabel: "speaker",
      resourceId: speakerId,
    });

    if (!lock.ok && lock.reason === "NOT_FOUND") {
      return {
        ok: false,
        code: "SPEAKER_NOT_FOUND",
        message: `Speaker ${speakerId} not found or access denied`,
      };
    }
    if (!lock.ok && lock.reason === "STALE_WRITE") {
      apiLogger.info({ msg: "speaker:stale-write-rejected", speakerId, eventId, source });
      return {
        ok: false,
        code: "STALE_WRITE",
        message:
          "This speaker was modified by someone else after you opened it. Reload the latest version and try again.",
      };
    }

    // Mirror any tag change onto the person's Registration facet (best-effort;
    // the helper logs and never throws). Agent-tagged committee speakers must
    // reach `attendee.tags` or cert auto-issue / tag filters silently miss them.
    if (fields.tags !== undefined) {
      await syncSpeakerTagsToRegistrations(eventId, [
        {
          speakerId,
          email: existing.email,
          sourceRegistrationId: existing.sourceRegistrationId,
          delta: computeTagDelta(existing.tags, fields.tags),
        },
      ]);
    }

    // Speaker moved INTO declined/cancelled: a DECLINED speaker must not keep a
    // valid entry barcode + printable badge. Companion-only by owner decision.
    let companionCascade: SpeakerDeclineCascadeResult | null = null;
    if (isSpeakerDeclineTransition(existing.status, fields.status)) {
      companionCascade = await cascadeSpeakerDecline({
        eventId,
        organizationId,
        speakerId,
        sourceRegistrationId: existing.sourceRegistrationId,
        cancelCompanion: cancelCompanionRegistration,
        source: source === "api" ? "rest" : source,
        actorUserId,
      });
    }

    const speaker = await db.speaker.findUniqueOrThrow({
      where: { id: speakerId },
      include: { _count: { select: { sessions: true, abstracts: true } } },
    });

    // FULL contact sync — this is the H4 fix. Read straight off the freshly
    // updated row so it already reflects the empty-to-null collapse above.
    // Awaited; `syncToContact` catches its own errors and never throws.
    await syncToContact({
      organizationId,
      eventId,
      email: speaker.email,
      additionalEmail: speaker.additionalEmail,
      firstName: speaker.firstName,
      lastName: speaker.lastName,
      title: speaker.title,
      role: speaker.role,
      organization: speaker.organization,
      jobTitle: speaker.jobTitle,
      phone: speaker.phone,
      photo: speaker.photo,
      city: speaker.city,
      country: speaker.country,
      bio: speaker.bio,
      specialty: speaker.specialty,
      registrationType: speaker.registrationType,
    });

    refreshEventStats(eventId);

    // Fire-and-forget with a logged catch: an audit-write blip must not fail a
    // speaker update that already committed (M13 class).
    db.auditLog
      .create({
        data: {
          eventId,
          userId: actorUserId,
          action: "UPDATE",
          entityType: "Speaker",
          entityId: speaker.id,
          changes: {
            source,
            before: existing,
            after: speaker,
            fieldsChanged: Object.keys(data),
            ...(companionCascade && { companionCascade: companionCascade.companion }),
            ...(requestIp && { ip: requestIp }),
          } as unknown as Prisma.InputJsonValue,
        },
      })
      .catch((err) =>
        apiLogger.error({ err, msg: "speaker-update:audit-write-failed", speakerId, source }),
      );

    return { ok: true, speaker, companionCascade };
  } catch (err) {
    apiLogger.error({ err, msg: "speaker-update:unknown-failure", speakerId, eventId, source });
    return {
      ok: false,
      code: "UNKNOWN",
      message: err instanceof Error ? err.message : "Failed to update speaker",
    };
  }
}
