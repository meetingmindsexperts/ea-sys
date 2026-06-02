/**
 * Eligibility queries — which recipients get which cert type for an event.
 *
 * Tag-driven manual selection (2026-06-02 evening). Per organizer feedback:
 * no "auto eligibility" based on check-in status / payment / session role /
 * poster status. The organizer tags people pre-event (existing
 * Registration.tags + Speaker.tags) and picks a tag at Issue time. The
 * tag is the only filter; the only sanity rail is category-bound pool
 * (ATTENDANCE → registrations, APPRECIATION → speakers) + the existing
 * one-cert-per-recipient-per-category dedup.
 *
 * Rules:
 *
 *   ATTENDANCE    — Registration in this event with tag present in its
 *                   `tags` String[] column AND status != CANCELLED AND
 *                   no existing IssuedCertificate of type ATTENDANCE.
 *
 *   APPRECIATION  — Speaker in this event with tag present in its
 *                   `tags` String[] column AND no existing
 *                   IssuedCertificate of type APPRECIATION.
 *
 * The Issue API REQUIRES a tag; without one the eligibility query
 * still works (returns the whole untagged pool — used by the tag
 * picker overview to surface available tags + their counts) but the
 * Issue route 400s if `tag` is missing from the request body.
 *
 * Return shape — array of EligibleRecipient + availableTags overview.
 */

import { db } from "@/lib/db";
import type { CertificateType } from "@prisma/client";

/**
 * Identifies a recipient via XOR of registrationId / speakerId.
 * Snapshots the name + email at eligibility time — same values land in
 * CertificateIssueRunItem so the UI list is stable even if the
 * underlying record is later deleted/renamed.
 */
export interface EligibleRecipient {
  kind: "registration" | "speaker";
  registrationId: string | null;
  speakerId: string | null;
  recipientName: string;
  recipientEmail: string | null;
  tags: string[];
}

export interface EligibilityResult {
  type: CertificateType;
  /** Filter applied to the recipient list. null = no filter (whole pool). */
  tag: string | null;
  eligible: EligibleRecipient[];
  /** Distinct tags present in the (un-filtered) eligible pool, with the
   *  count of recipients carrying each tag. Powers the tag picker. */
  availableTags: Array<{ tag: string; count: number }>;
  /** Recipients in the pool with NO tags — surfaced so the operator
   *  knows about them but they're excluded from any tag-based issue. */
  untaggedCount: number;
  /** Reasons some otherwise-qualifying recipients were excluded — for
   *  the operator UI banner. Empty array if no exclusions apply. */
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

/** Build the tag-count overview from a pool of recipients. */
function buildTagOverview(
  pool: Array<{ tags: string[] }>,
): { availableTags: Array<{ tag: string; count: number }>; untaggedCount: number } {
  const counts = new Map<string, number>();
  let untagged = 0;
  for (const row of pool) {
    if (!row.tags || row.tags.length === 0) {
      untagged++;
      continue;
    }
    for (const t of row.tags) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  const availableTags = Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return { availableTags, untaggedCount: untagged };
}

// ── ATTENDANCE — Registration pool ───────────────────────────────────────────

export async function eligibleForAttendance(
  eventId: string,
  tag: string | null,
): Promise<EligibilityResult> {
  // Pool = all non-cancelled registrations in the event that DON'T
  // already hold an ATTENDANCE cert. Tags live on the linked Attendee
  // (NOT Registration — confirmed against the Prisma schema: only
  // Attendee.tags, Speaker.tags, and Contact.tags are String[]
  // columns). For ATTENDANCE we read the attendee's tags through the
  // include + filter / count by them in memory.
  const pool = await db.registration.findMany({
    where: {
      eventId,
      status: { not: "CANCELLED" },
      issuedCertificates: { none: { type: "ATTENDANCE" } },
    },
    select: {
      id: true,
      attendee: {
        select: {
          title: true,
          firstName: true,
          lastName: true,
          email: true,
          tags: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  // Normalize the tags from the linked attendee for the overview helper.
  const tagOverview = buildTagOverview(
    pool.map((r) => ({ tags: r.attendee?.tags ?? [] })),
  );

  const filtered =
    tag === null ? [] : pool.filter((r) => r.attendee?.tags?.includes(tag));

  return {
    type: "ATTENDANCE",
    tag,
    eligible: filtered.map((r) => ({
      kind: "registration" as const,
      registrationId: r.id,
      speakerId: null,
      recipientName: formatName({
        title: r.attendee?.title ?? null,
        firstName: r.attendee?.firstName,
        lastName: r.attendee?.lastName,
      }),
      recipientEmail: r.attendee?.email ?? null,
      tags: r.attendee?.tags ?? [],
    })),
    availableTags: tagOverview.availableTags,
    untaggedCount: tagOverview.untaggedCount,
    exclusions: [],
  };
}

// ── APPRECIATION — Speaker pool ──────────────────────────────────────────────

export async function eligibleForAppreciation(
  eventId: string,
  tag: string | null,
): Promise<EligibilityResult> {
  // Pool = all speakers in the event that DON'T already hold an
  // APPRECIATION cert. No session-role / poster-accepted gate; tag
  // is the only filter.
  const pool = await db.speaker.findMany({
    where: {
      eventId,
      issuedCertificates: { none: { type: "APPRECIATION" } },
    },
    select: {
      id: true,
      title: true,
      firstName: true,
      lastName: true,
      email: true,
      tags: true,
    },
    orderBy: { lastName: "asc" },
  });

  const tagOverview = buildTagOverview(pool);

  const filtered = tag === null ? [] : pool.filter((s) => s.tags?.includes(tag));

  return {
    type: "APPRECIATION",
    tag,
    eligible: filtered.map((s) => ({
      kind: "speaker" as const,
      registrationId: null,
      speakerId: s.id,
      recipientName: formatName({
        title: s.title,
        firstName: s.firstName,
        lastName: s.lastName,
      }),
      recipientEmail: s.email,
      tags: s.tags ?? [],
    })),
    availableTags: tagOverview.availableTags,
    untaggedCount: tagOverview.untaggedCount,
    exclusions: [],
  };
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Returns the tag overview + (optionally) the filtered recipient list.
 * Pass `tag: null` to fetch JUST the overview (for the picker UI);
 * pass a tag string to fetch the filtered list (used by the Issue
 * route just before creating the run).
 */
export async function eligibleForType(
  type: CertificateType,
  eventId: string,
  tag: string | null,
): Promise<EligibilityResult> {
  switch (type) {
    case "ATTENDANCE":
      return eligibleForAttendance(eventId, tag);
    case "APPRECIATION":
      return eligibleForAppreciation(eventId, tag);
  }
}
