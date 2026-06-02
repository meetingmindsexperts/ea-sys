/**
 * Eligibility queries — which recipients get which cert type for an event.
 *
 * Rules (collapsed-to-2-types on 2026-06-02):
 *
 *   ATTENDANCE    — Registration with checkedInAt IS NOT NULL AND
 *                   paymentStatus IN (PAID, COMPLIMENTARY, INCLUSIVE) AND
 *                   status != CANCELLED.
 *
 *   APPRECIATION  — Speaker on the event with EITHER at least one
 *                   SessionSpeaker row in a session whose endTime < now
 *                   (the old PRESENTER bucket — role-agnostic across
 *                   SPEAKER / MODERATOR / CHAIRPERSON / PANELIST) OR at
 *                   least one Abstract with presentationType = POSTER
 *                   AND status = ACCEPTED (the old POSTER bucket). The
 *                   union is a single Prisma query with OR clauses —
 *                   speakers who qualify on both paths show up once
 *                   automatically (one row per Speaker.id).
 *
 * CME hours + accrediting bodies are NOT a separate cert type any more —
 * they're event-level attributes consumed via `{{cmeHours}}`,
 * `{{accreditationBody}}`, and `{{accreditationReference}}` tokens
 * inside whichever template (ATTENDANCE or APPRECIATION) references
 * them. The CME / CPD tab on the certificates page still configures
 * those values.
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
   *  operator UI banner. Empty array if no exclusion reasons apply. */
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

// ── ATTENDANCE (checked-in registrations with non-cancelled paid-equivalent status)

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

// ── APPRECIATION — speakers with a finished session role OR an accepted poster

export async function eligibleForAppreciation(eventId: string): Promise<EligibilityResult> {
  const now = new Date();

  // Single Prisma query unions the two old buckets (PRESENTER + POSTER)
  // via an OR. A speaker qualifying on both paths returns one row —
  // dedup is implicit because we're selecting from `Speaker`, not
  // joining a multi-row right side. We post-filter "issued" on Speaker
  // to skip anyone who already has an APPRECIATION cert this event.
  const rows = await db.speaker.findMany({
    where: {
      eventId,
      OR: [
        // Faculty / moderator / chair / panelist who actually took the
        // stage in a session that has already ended.
        { sessions: { some: { session: { endTime: { lt: now } } } } },
        // Poster presenter whose abstract was accepted (presentation
        // happens in the poster hall; we don't gate on a session
        // endTime because posters often don't have one tied to them).
        { abstracts: { some: { presentationType: "POSTER", status: "ACCEPTED" } } },
      ],
      issuedCertificates: { none: { type: "APPRECIATION" } },
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
    type: "APPRECIATION",
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
    case "APPRECIATION":
      return eligibleForAppreciation(eventId);
  }
}
