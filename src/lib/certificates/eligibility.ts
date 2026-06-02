/**
 * Eligibility queries — which recipients get which cert type for an event.
 *
 * Rules (Phase A decisions):
 *
 *   ATTENDANCE  — Registration with checkedInAt IS NOT NULL AND
 *                 paymentStatus IN (PAID, COMPLIMENTARY, INCLUSIVE) AND
 *                 status != CANCELLED.
 *
 *   PRESENTER   — Speaker with at least one SessionSpeaker row in the
 *                 event AND at least one of those sessions has ended
 *                 (endTime < now). Role-agnostic — anyone who actually
 *                 had a presentation role (SPEAKER / MODERATOR /
 *                 CHAIRPERSON / PANELIST) earns the faculty cert.
 *
 *   POSTER      — Speaker with at least one Abstract on this event
 *                 having presentationType = POSTER AND status = ACCEPTED.
 *
 *   CME         — Same as ATTENDANCE, PLUS event.cmeHours IS NOT NULL
 *                 AND event.settings.cme.accreditations[] non-empty.
 *                 The hours / accreditation token resolution depends on
 *                 these being set; we gate eligibility on them so the
 *                 cert doesn't render with empty {{cmeHours}}.
 *
 * Return shape — array of EligibleRecipient. Caller (the issue-run
 * creator) maps each to a CertificateIssueRunItem with the recipient
 * id field populated and snapshots the name/email at run-creation time.
 *
 * Exclusion of already-issued — the deduper relies on
 * IssuedCertificate's @@unique([eventId, type, registrationId|speakerId])
 * constraint to catch concurrent dupes from any path (cron retry, MCP,
 * dashboard). We DO filter known-issued recipients out of the eligible
 * list pre-emptively so the operator sees an accurate "N eligible"
 * count + the run doesn't churn on already-issued items.
 */

import { db } from "@/lib/db";
import type { CertificateType } from "@prisma/client";

/**
 * Identifies a recipient via XOR of registrationId / speakerId.
 * Snapshots the name + email at eligibility time — same values land in
 * CertificateIssueRunItem so the UI can display the list without joining
 * + the run survives the underlying record being deleted/renamed.
 */
export interface EligibleRecipient {
  kind: "registration" | "speaker";
  registrationId: string | null;
  speakerId: string | null;
  recipientName: string;       // formatPersonName output (with title prefix)
  recipientEmail: string | null;
}

export interface EligibilityResult {
  type: CertificateType;
  eligible: EligibleRecipient[];
  /** Why some otherwise-qualifying recipients were excluded — for the
   *  operator UI banner. e.g. "cmeHours not set" / "no accreditation
   *  configured" for CME. Empty array if no exclusion reasons apply. */
  exclusions: Array<{ reason: string; count?: number }>;
}

/** Helper — formats "Dr. Sample Attendee" / "Mr. John Smith" etc. */
function formatName(opts: { title?: string | null; firstName?: string; lastName?: string }): string {
  const titleMap: Record<string, string> = {
    DR: "Dr.",
    MR: "Mr.",
    MRS: "Mrs.",
    MS: "Ms.",
    PROF: "Prof.",
  };
  const tprefix = opts.title ? `${titleMap[opts.title] ?? ""} ` : "";
  const full = `${tprefix}${opts.firstName ?? ""} ${opts.lastName ?? ""}`.trim();
  return full || "(unnamed)";
}

// ── ATTENDANCE / CME (both based on registrations) ───────────────────────────

export async function eligibleForAttendance(eventId: string): Promise<EligibilityResult> {
  const rows = await db.registration.findMany({
    where: {
      eventId,
      checkedInAt: { not: null },
      paymentStatus: { in: ["PAID", "COMPLIMENTARY", "INCLUSIVE"] },
      status: { not: "CANCELLED" },
      // Exclude registrations that already have an issued ATTENDANCE cert.
      issuedCertificates: { none: { type: "ATTENDANCE" } },
    },
    select: {
      id: true,
      attendee: {
        select: { title: true, firstName: true, lastName: true, email: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return {
    type: "ATTENDANCE",
    eligible: rows.map((r) => ({
      kind: "registration" as const,
      registrationId: r.id,
      speakerId: null,
      recipientName: formatName({
        title: r.attendee?.title ?? null,
        firstName: r.attendee?.firstName,
        lastName: r.attendee?.lastName,
      }),
      recipientEmail: r.attendee?.email ?? null,
    })),
    exclusions: [],
  };
}

export async function eligibleForCme(eventId: string): Promise<EligibilityResult> {
  // CME has two preconditions on the EVENT itself (hours + accreditation
  // configured); without these the cert tokens render as empty strings.
  // Fail early with a clear exclusion reason so the operator UI can
  // explain why the eligible count is zero.
  const event = await db.event.findUnique({
    where: { id: eventId },
    select: { id: true, cmeHours: true, settings: true },
  });
  if (!event) {
    return { type: "CME", eligible: [], exclusions: [{ reason: "Event not found" }] };
  }
  const exclusions: EligibilityResult["exclusions"] = [];
  if (event.cmeHours == null) {
    exclusions.push({ reason: "CME hours not set on event (CME tab → Total CME / CPD hours awarded)" });
  }
  const cmeSettings =
    event.settings && typeof event.settings === "object" && !Array.isArray(event.settings)
      ? (event.settings as Record<string, unknown>).cme
      : null;
  const accreditations =
    cmeSettings && typeof cmeSettings === "object" && !Array.isArray(cmeSettings)
      ? ((cmeSettings as Record<string, unknown>).accreditations as unknown[]) ?? []
      : [];
  if (accreditations.length === 0) {
    exclusions.push({ reason: "No accrediting body configured (CME tab → Accreditations)" });
  }
  if (exclusions.length > 0) {
    return { type: "CME", eligible: [], exclusions };
  }

  // Same registration filter as ATTENDANCE — same not-yet-issued check
  // against the CME type slot.
  const rows = await db.registration.findMany({
    where: {
      eventId,
      checkedInAt: { not: null },
      paymentStatus: { in: ["PAID", "COMPLIMENTARY", "INCLUSIVE"] },
      status: { not: "CANCELLED" },
      issuedCertificates: { none: { type: "CME" } },
    },
    select: {
      id: true,
      attendee: { select: { title: true, firstName: true, lastName: true, email: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return {
    type: "CME",
    eligible: rows.map((r) => ({
      kind: "registration" as const,
      registrationId: r.id,
      speakerId: null,
      recipientName: formatName({
        title: r.attendee?.title ?? null,
        firstName: r.attendee?.firstName,
        lastName: r.attendee?.lastName,
      }),
      recipientEmail: r.attendee?.email ?? null,
    })),
    exclusions: [],
  };
}

// ── PRESENTER (speakers who had a role in any ended session) ─────────────────

export async function eligibleForPresenter(eventId: string): Promise<EligibilityResult> {
  const now = new Date();
  // Pull speakers who have at least one SessionSpeaker tied to a session
  // whose endTime < now. Role-agnostic (SPEAKER/MODERATOR/CHAIRPERSON/
  // PANELIST all count — anyone who took the stage).
  const rows = await db.speaker.findMany({
    where: {
      eventId,
      sessions: {
        some: {
          session: { endTime: { lt: now } },
        },
      },
      issuedCertificates: { none: { type: "PRESENTER" } },
    },
    select: {
      id: true,
      title: true,
      firstName: true,
      lastName: true,
      email: true,
    },
    orderBy: { lastName: "asc" },
  });

  return {
    type: "PRESENTER",
    eligible: rows.map((s) => ({
      kind: "speaker" as const,
      registrationId: null,
      speakerId: s.id,
      recipientName: formatName({
        title: s.title,
        firstName: s.firstName,
        lastName: s.lastName,
      }),
      recipientEmail: s.email,
    })),
    exclusions: [],
  };
}

// ── POSTER (speakers with an accepted POSTER abstract) ───────────────────────

export async function eligibleForPoster(eventId: string): Promise<EligibilityResult> {
  const rows = await db.speaker.findMany({
    where: {
      eventId,
      abstracts: {
        some: {
          presentationType: "POSTER",
          status: "ACCEPTED",
        },
      },
      issuedCertificates: { none: { type: "POSTER" } },
    },
    select: {
      id: true,
      title: true,
      firstName: true,
      lastName: true,
      email: true,
    },
    orderBy: { lastName: "asc" },
  });

  return {
    type: "POSTER",
    eligible: rows.map((s) => ({
      kind: "speaker" as const,
      registrationId: null,
      speakerId: s.id,
      recipientName: formatName({
        title: s.title,
        firstName: s.firstName,
        lastName: s.lastName,
      }),
      recipientEmail: s.email,
    })),
    exclusions: [],
  };
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

export async function eligibleForType(
  type: CertificateType,
  eventId: string,
): Promise<EligibilityResult> {
  switch (type) {
    case "ATTENDANCE":
      return eligibleForAttendance(eventId);
    case "PRESENTER":
      return eligibleForPresenter(eventId);
    case "POSTER":
      return eligibleForPoster(eventId);
    case "CME":
      return eligibleForCme(eventId);
  }
  throw new Error(`Unhandled certificate type: ${String(type)}`);
}
