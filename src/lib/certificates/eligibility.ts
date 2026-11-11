/**
 * Eligibility queries: who a manual Issue run sends a template to.
 *
 * Assignment-driven since Nov 11, 2026 (./assignments.ts is the rule). The
 * organiser decides who receives a certificate by ASSIGNING it; there is still
 * no "auto eligibility" from check-in status, payment, session role or poster
 * status (organiser decision 2026-06-02, when the selector was a tag).
 *
 * Rules:
 *
 *   ATTENDANCE    Registrations assigned the template, not CANCELLED, with no
 *                 IssuedCertificate from this template yet.
 *
 *   APPRECIATION  Speakers assigned the template, with no IssuedCertificate
 *                 from this template yet.
 *
 * Dedup is per TEMPLATE: one person can hold several role-specific
 * certificates, each from its own template (the per-template unique index).
 */

import { db } from "@/lib/db";
import type { CertificateType } from "@prisma/client";
import { assignedRegistrationWhere, assignedSpeakerWhere, countAssignmentsByTemplate } from "./assignments";

/**
 * Identifies a recipient via XOR of registrationId / speakerId.
 * Snapshots the name + email at eligibility time: the same values land in
 * CertificateIssueRunItem so the UI list is stable even if the
 * underlying record is later deleted/renamed.
 */
export interface EligibleRecipient {
  kind: "registration" | "speaker";
  registrationId: string | null;
  speakerId: string | null;
  recipientName: string;
  recipientEmail: string | null;
}

export interface EligibilityResult {
  type: CertificateType;
  /** Assigned, and not yet holding this template's certificate. */
  eligible: EligibleRecipient[];
}

/** Helper: formats "Dr. Sample Attendee" / "Mr. John Smith" etc. */
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

// ── ATTENDANCE: registration pool ────────────────────────────────────────────

export async function eligibleForAttendance(eventId: string, templateId: string): Promise<EligibilityResult> {
  const pool = await db.registration.findMany({
    where: {
      eventId,
      ...assignedRegistrationWhere(templateId),
      issuedCertificates: { none: { certificateTemplateId: templateId } },
    },
    select: {
      id: true,
      attendee: { select: { title: true, firstName: true, lastName: true, email: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return {
    type: "ATTENDANCE",
    eligible: pool.map((r) => ({
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
  };
}

// ── APPRECIATION: speaker pool ───────────────────────────────────────────────

export async function eligibleForAppreciation(eventId: string, templateId: string): Promise<EligibilityResult> {
  const pool = await db.speaker.findMany({
    where: {
      eventId,
      ...assignedSpeakerWhere(templateId),
      issuedCertificates: { none: { certificateTemplateId: templateId } },
    },
    select: { id: true, title: true, firstName: true, lastName: true, email: true },
    orderBy: { lastName: "asc" },
  });

  return {
    type: "APPRECIATION",
    eligible: pool.map((s) => ({
      kind: "speaker" as const,
      registrationId: null,
      speakerId: s.id,
      recipientName: formatName({ title: s.title, firstName: s.firstName, lastName: s.lastName }),
      recipientEmail: s.email,
    })),
  };
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

export async function eligibleForType(
  type: CertificateType,
  eventId: string,
  templateId: string,
): Promise<EligibilityResult> {
  switch (type) {
    case "ATTENDANCE":
      return eligibleForAttendance(eventId, templateId);
    case "APPRECIATION":
      return eligibleForAppreciation(eventId, templateId);
  }
}

// ── Multi-template, person-merged eligibility (bundle model) ─────────────────

export interface EligibleTemplateMeta {
  id: string;
  name: string;
  category: CertificateType;
}

/** One PERSON in a multi-template issue: both facets set when the person's
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
    /** People this run would issue the template to. */
    count: number;
    /** Everyone assigned the template (cancelled registrations left out),
     *  including those who already hold it. `assigned - count` already do. */
    assigned: number;
  }>;
}

function attendanceFirst(a: string, b: string): number {
  if (a === b) return 0;
  return a === "ATTENDANCE" ? -1 : 1;
}

/**
 * Eligibility for a multi-template issue: each template's pool is the people
 * ASSIGNED it (minus already-issued-for-that-template), then entries are
 * merged per PERSON so one run item, and later ONE email, covers all the
 * certs a person earns.
 *
 * Cross-facet linking (registration to speaker) uses the same policy as
 * `resolveLinkedSpeaker` (companion `sourceRegistrationId` pointer first,
 * else email match), applied IN MEMORY over the eligible pools so a
 * 500-person event doesn't fan out per-person link queries. A speaker only
 * merges into a registration entry when that registration is itself in the
 * merged set (and not already claimed by another speaker); otherwise they
 * stay a separate single-facet person, which is always safe.
 */
export async function eligibleForTemplates(
  eventId: string,
  templates: EligibleTemplateMeta[],
): Promise<MultiEligibilityResult> {
  // Speaker to companion registration pointers for the in-memory linking.
  const [speakerLinks, assignedCounts] = await Promise.all([
    db.speaker.findMany({
      where: { eventId },
      select: { id: true, email: true, sourceRegistrationId: true },
    }),
    countAssignmentsByTemplate(db, templates.map((t) => t.id)),
  ]);
  const linkBySpeakerId = new Map(speakerLinks.map((s) => [s.id, s]));

  const perTemplate: MultiEligibilityResult["perTemplate"] = [];
  const people = new Map<string, EligiblePerson>();
  // registrationId to person key, so APPRECIATION entries can merge into
  // an ATTENDANCE person; email to registration person key as fallback.
  const personKeyByRegistrationId = new Map<string, string>();
  const personKeyByRegistrationEmail = new Map<string, string>();

  // Registration pools must be seeded BEFORE speaker entries try to link
  // into them: otherwise selection order (APPRECIATION template listed
  // first) would split one person into two items/emails.
  const ordered = [...templates].sort((a, b) => attendanceFirst(a.category, b.category));

  for (const t of ordered) {
    const { eligible } = await eligibleForType(t.category, eventId, t.id);
    perTemplate.push({
      templateId: t.id,
      templateName: t.name,
      category: t.category,
      count: eligible.length,
      assigned: assignedCounts.get(t.id) ?? 0,
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

      // Speaker entry: merge into the linked registration's person when
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

  // The spk: alias trick above means merged persons appear under two keys:
  // dedupe by object identity.
  const distinct = Array.from(new Set(people.values()));
  return { people: distinct, perTemplate };
}
