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
  templateId: string,
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
      // Per-template dedup (was per-type) — a recipient can hold several
      // role-specific certs, so we only exclude those already issued THIS
      // template. Matches the per-template unique index.
      issuedCertificates: { none: { certificateTemplateId: templateId } },
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
  templateId: string,
): Promise<EligibilityResult> {
  // Pool = all speakers in the event that DON'T already hold an
  // APPRECIATION cert. No session-role / poster-accepted gate; tag
  // is the only filter.
  const pool = await db.speaker.findMany({
    where: {
      eventId,
      // Per-template dedup (was per-type) — see eligibleForAttendance.
      issuedCertificates: { none: { certificateTemplateId: templateId } },
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
  templateId: string,
): Promise<EligibilityResult> {
  switch (type) {
    case "ATTENDANCE":
      return eligibleForAttendance(eventId, tag, templateId);
    case "APPRECIATION":
      return eligibleForAppreciation(eventId, tag, templateId);
  }
}

// ── Multi-template, person-merged eligibility (bundle model) ─────────────────

export interface EligibleTemplateMeta {
  id: string;
  name: string;
  category: CertificateType;
  /** The template's stored tag — the single source of truth for who
   *  receives it (no per-action tag override in the bundle model). */
  autoIssueTag: string | null;
}

/** One PERSON in a multi-template issue — both facets set when the person's
 *  registration AND linked speaker each earn a cert in this run. */
export interface EligiblePerson {
  registrationId: string | null;
  speakerId: string | null;
  recipientName: string;
  recipientEmail: string | null;
  /** The subset of the run's templates this person qualifies for. */
  templateIds: string[];
}

export interface MultiEligibilityResult {
  people: EligiblePerson[];
  perTemplate: Array<{
    templateId: string;
    templateName: string;
    category: CertificateType;
    tag: string | null;
    count: number;
  }>;
}

/**
 * Eligibility for a multi-template issue: each template's pool is its STORED
 * tag's pool (minus already-issued-for-that-template), then entries are
 * merged per PERSON so one run item — and later ONE email — covers all the
 * certs a person earns.
 *
 * Cross-facet linking (registration ↔ speaker) uses the same policy as
 * `resolveLinkedSpeaker` (companion `sourceRegistrationId` pointer first,
 * else email match), applied IN MEMORY over the eligible pools so a
 * 500-person event doesn't fan out per-person link queries. A speaker only
 * merges into a registration entry when that registration is itself in the
 * merged set (and not already claimed by another speaker) — otherwise they
 * stay a separate single-facet person, which is always safe.
 */
export async function eligibleForTemplates(
  eventId: string,
  templates: EligibleTemplateMeta[],
): Promise<MultiEligibilityResult> {
  // Speaker → companion registration pointers for the in-memory linking.
  const speakerLinks = await db.speaker.findMany({
    where: { eventId },
    select: { id: true, email: true, sourceRegistrationId: true },
  });
  const linkBySpeakerId = new Map(speakerLinks.map((s) => [s.id, s]));

  const perTemplate: MultiEligibilityResult["perTemplate"] = [];
  const people = new Map<string, EligiblePerson>();
  // registrationId → person key, so APPRECIATION entries can merge into
  // an ATTENDANCE person; email → registration person key as fallback.
  const personKeyByRegistrationId = new Map<string, string>();
  const personKeyByRegistrationEmail = new Map<string, string>();

  // Registration pools must be seeded BEFORE speaker entries try to link
  // into them — otherwise selection order (APPRECIATION template listed
  // first) would split one person into two items/emails.
  const ordered = [...templates].sort((a, b) =>
    a.category === b.category ? 0 : a.category === "ATTENDANCE" ? -1 : 1,
  );

  for (const t of ordered) {
    const tag = t.autoIssueTag?.trim() || null;
    // A tagless template matches nobody (universal rule) — surfaced by the
    // route as TEMPLATE_MISSING_TAG before this runs; kept safe here too.
    const elig = tag ? await eligibleForType(t.category, eventId, tag, t.id) : null;
    const eligible = elig?.eligible ?? [];
    perTemplate.push({
      templateId: t.id,
      templateName: t.name,
      category: t.category,
      tag,
      count: eligible.length,
    });

    for (const r of eligible) {
      if (r.kind === "registration" && r.registrationId) {
        const key = `reg:${r.registrationId}`;
        const existing = people.get(key);
        if (existing) {
          existing.templateIds.push(t.id);
        } else {
          people.set(key, {
            registrationId: r.registrationId,
            speakerId: null,
            recipientName: r.recipientName,
            recipientEmail: r.recipientEmail,
            templateIds: [t.id],
          });
          personKeyByRegistrationId.set(r.registrationId, key);
          if (r.recipientEmail) {
            personKeyByRegistrationEmail.set(r.recipientEmail.toLowerCase(), key);
          }
        }
        continue;
      }
      if (!r.speakerId) continue;

      // Speaker entry — merge into the linked registration's person when
      // that registration is in the set and hasn't been claimed by another
      // speaker; else keep (or extend) a speaker-keyed person.
      const spkKey = `spk:${r.speakerId}`;
      const existingSpk = people.get(spkKey);
      if (existingSpk) {
        existingSpk.templateIds.push(t.id);
        continue;
      }
      const link = linkBySpeakerId.get(r.speakerId);
      const regKey =
        (link?.sourceRegistrationId && personKeyByRegistrationId.get(link.sourceRegistrationId)) ||
        (link?.email && personKeyByRegistrationEmail.get(link.email.toLowerCase())) ||
        null;
      const regPerson = regKey ? people.get(regKey) : null;
      if (regPerson && regPerson.speakerId === null) {
        regPerson.speakerId = r.speakerId;
        regPerson.templateIds.push(t.id);
        // Alias the speaker key to the merged person so a SECOND
        // appreciation template for the same speaker extends it.
        people.set(spkKey, regPerson);
        continue;
      }
      people.set(spkKey, {
        registrationId: null,
        speakerId: r.speakerId,
        recipientName: r.recipientName,
        recipientEmail: r.recipientEmail,
        templateIds: [t.id],
      });
    }
  }

  // The spk: alias trick above means merged persons appear under two keys —
  // dedupe by object identity.
  const distinct = Array.from(new Set(people.values()));
  return { people: distinct, perTemplate };
}
