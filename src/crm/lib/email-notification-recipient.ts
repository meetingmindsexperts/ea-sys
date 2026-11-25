/**
 * WHO hears about an email that arrives in the CRM inbox (owner, Nov 25, 2026).
 *
 * Until that day only the owner of the conversation's DEAL was told, and on
 * production 98 of the first 113 emails received sat on conversations linked to a
 * contact with no deal: nobody was told about them. The rule is now one chain,
 * first owner found wins:
 *
 *   1. the deal's owner (the conversation is about that deal);
 *   2. the contact's owner (the rep who looks after that person);
 *   3. the owner of the contact's account.
 *
 * Each owner is told only if they may see the inbox (`inboxNoticeRefusal`, in
 * src/crm/services/crm-inbox-notice-eligibility.ts); otherwise the next is tried.
 * Nobody at all is a real answer (an unowned contact on an unowned account): the
 * shared inbox and its unread badge still show the email. Both inbound doors (a
 * reply to an email we sent, and an email captured from the partnerships
 * mailbox) ask this one function, so the two can never disagree.
 *
 * Pure: no database, no logging. The caller selects `EMAIL_NOTIFY_THREAD_SELECT`,
 * checks each candidate and logs the outcome.
 */

/** The relations this rule reads. Spread into a thread `select`. */
export const EMAIL_NOTIFY_THREAD_SELECT = {
  deal: { select: { id: true, name: true, ownerId: true } },
  crmContact: {
    select: {
      firstName: true,
      lastName: true,
      ownerId: true,
      company: { select: { name: true, ownerId: true } },
    },
  },
} as const;

export interface EmailNotifyThread {
  deal: { name: string; ownerId: string | null } | null;
  crmContact: {
    firstName: string;
    lastName: string;
    ownerId: string | null;
    company: { name: string; ownerId: string | null } | null;
  } | null;
}

export type EmailNotifyVia = "deal" | "contact" | "account";

export interface EmailNotifyCandidate {
  userId: string;
  /** Which owner this is, for the log. */
  via: EmailNotifyVia;
}

export interface EmailNotifyCandidates {
  /** The owners to try, in order, without repeats. Empty when nobody owns anything here. */
  candidates: EmailNotifyCandidate[];
  /** What the notification says the email is about: the deal, else the account, else the person. */
  about: string;
}

function contactName(contact: NonNullable<EmailNotifyThread["crmContact"]>): string {
  return `${contact.firstName} ${contact.lastName}`.trim();
}

/** What the email is about, in the words a rep recognises. */
function aboutLabel(thread: EmailNotifyThread): string {
  if (thread.deal) return thread.deal.name;
  const contact = thread.crmContact;
  if (!contact) return "a conversation";
  if (contact.company) return contact.company.name;
  return contactName(contact) || "a conversation";
}

/**
 * The owner chain, in order. The caller tries each in turn and tells the first one
 * who may see the inbox (`inboxNoticeRefusal`): owning a record is not that.
 * `skipAccount` drops the account step, for a contact made just now from a sender
 * we could not verify: their domain alone put them on that account, so the
 * account's owner would be handed a stranger's words as if the account sent them.
 */
export function emailNotificationCandidates(
  thread: EmailNotifyThread,
  options: { skipAccount?: boolean } = {},
): EmailNotifyCandidates {
  const steps: Array<[EmailNotifyVia, string | null | undefined]> = [
    ["deal", thread.deal?.ownerId],
    ["contact", thread.crmContact?.ownerId],
  ];
  if (!options.skipAccount) steps.push(["account", thread.crmContact?.company?.ownerId]);

  const candidates: EmailNotifyCandidate[] = [];
  const seen = new Set<string>();
  for (const [via, userId] of steps) {
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    candidates.push({ userId, via });
  }
  return { candidates, about: aboutLabel(thread) };
}
