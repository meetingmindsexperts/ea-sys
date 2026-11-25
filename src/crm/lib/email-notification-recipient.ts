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
 * Nobody at all is a real answer (an unowned contact on an unowned account): the
 * shared inbox and its unread badge still show the email. Both inbound doors (a
 * reply to an email we sent, and an email captured from the partnerships
 * mailbox) ask this one function, so the two can never disagree.
 *
 * Pure: no database, no logging. The caller selects `EMAIL_NOTIFY_THREAD_SELECT`
 * and logs the outcome.
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

export interface EmailNotifyTarget {
  /** Who to tell, or null when nobody owns anything on this conversation. */
  recipientId: string | null;
  /** Which owner it is, for the log. */
  via: EmailNotifyVia | null;
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

export function emailNotificationTarget(thread: EmailNotifyThread): EmailNotifyTarget {
  const about = aboutLabel(thread);
  const dealOwner = thread.deal?.ownerId ?? null;
  if (dealOwner) return { recipientId: dealOwner, via: "deal", about };
  const contactOwner = thread.crmContact?.ownerId ?? null;
  if (contactOwner) return { recipientId: contactOwner, via: "contact", about };
  const accountOwner = thread.crmContact?.company?.ownerId ?? null;
  if (accountOwner) return { recipientId: accountOwner, via: "account", about };
  return { recipientId: null, via: null, about };
}
