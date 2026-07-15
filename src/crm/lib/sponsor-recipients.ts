/**
 * Pure recipient resolution for the "email sponsors of an event" send.
 *
 * No `db` import — the service queries the deals and hands the rows here, so this
 * file is trivially unit-testable and can't drift from the send path (the audience
 * is computed in ONE place). The correctness that matters is the M7 lesson baked
 * into the CRM: a filter must NARROW the audience, never widen it. `narrowToSelected`
 * is an intersection, so a stray contactId a caller invents can never add a
 * recipient who isn't already a genuine sponsor of the event.
 *
 * "Sponsors of an event" = every business contact reached through that event's
 * NON-lost, non-archived deals (prospects being pitched + confirmed). A person on
 * two of the event's deals is emailed ONCE (deduped on the contact's canonical
 * emailKey), with `dealCount` recording the overlap for the preview.
 */
import type { SponsorRecipient } from "@/crm/lib/crm-types";

/** The minimal deal shape the resolver selects and feeds in here. */
export interface RawDealForRecipients {
  company: { name: string } | null;
  contacts: Array<{
    crmContact: {
      id: string;
      firstName: string;
      lastName: string;
      email: string;
      emailKey: string;
      archivedAt: Date | null;
      company: { name: string } | null;
    };
  }>;
}

export interface CollectedRecipients {
  recipients: SponsorRecipient[];
  /** Counts for the preview — why some deal contacts aren't in the list. */
  skipped: { noEmail: number; archivedContacts: number };
}

/**
 * Flatten an event's deals into a deduped recipient list.
 *
 * Skips: archived contacts (they left the company / were merged away) and contacts
 * with no usable email — both counted (by unique contact id, so a person on three
 * deals is one skip, not three) so the preview can explain the gap rather than
 * silently dropping people.
 */
export function collectSponsorRecipients(deals: RawDealForRecipients[]): CollectedRecipients {
  const byEmail = new Map<string, SponsorRecipient>();
  const archivedIds = new Set<string>();
  const noEmailIds = new Set<string>();

  for (const deal of deals) {
    const dealCompany = deal.company?.name ?? null;
    for (const { crmContact: c } of deal.contacts) {
      if (c.archivedAt) {
        archivedIds.add(c.id);
        continue;
      }
      const email = c.email?.trim();
      const key = c.emailKey?.trim().toLowerCase();
      if (!email || !key) {
        noEmailIds.add(c.id);
        continue;
      }
      const existing = byEmail.get(key);
      if (existing) {
        existing.dealCount += 1;
        continue;
      }
      byEmail.set(key, {
        crmContactId: c.id,
        firstName: c.firstName,
        lastName: c.lastName,
        email,
        // The contact's own company, falling back to the deal's — a rep sometimes
        // has no company set but the deal does.
        companyName: c.company?.name ?? dealCompany,
        dealCount: 1,
      });
    }
  }

  const recipients = [...byEmail.values()].sort(
    (a, b) =>
      (a.companyName ?? "").localeCompare(b.companyName ?? "") ||
      a.lastName.localeCompare(b.lastName) ||
      a.firstName.localeCompare(b.firstName),
  );

  return { recipients, skipped: { noEmail: noEmailIds.size, archivedContacts: archivedIds.size } };
}

/**
 * Intersect the resolved recipients with a caller-supplied selection.
 *
 * `undefined` → send to everyone resolved. A provided list → ONLY those recipients
 * that are BOTH resolved AND selected. This is the narrow-never-widen guard: the
 * set of people who can receive the email is fixed by the event's deals; the
 * selection can only remove from it, never add. An id in `contactIds` that isn't a
 * genuine sponsor is silently ignored (the caller can't email a stranger by
 * inventing an id).
 */
export function narrowToSelected(
  recipients: SponsorRecipient[],
  contactIds?: string[] | null,
): SponsorRecipient[] {
  if (!contactIds) return recipients;
  const selected = new Set(contactIds);
  return recipients.filter((r) => selected.has(r.crmContactId));
}
