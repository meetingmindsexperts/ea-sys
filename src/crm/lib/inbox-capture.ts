/**
 * Partnerships mailbox capture: the pure rules (Oct 27, 2026).
 *
 * WHY: a sponsor who writes fresh to partnerships@ (or answers an email a rep
 * sent from Outlook) carries no CRM reply token, so the inbox never saw it. A
 * Microsoft 365 mail-flow rule now copies every message to or from the
 * partnerships mailbox to the CRM's receiving domain, and the inbound worker
 * files it (src/crm/services/inbox-capture-service.ts).
 *
 * Owner rulings (Oct 27, 2026): partnerships@ only, never reps' mailboxes;
 * nothing a sponsor sends is ignored: an unknown sender becomes a CRM contact,
 * mapped to an account where one can be found; every step lands in History.
 *
 * Pure: no I/O.
 */
import { cleanContactName, NEEDS_NAME_TAG } from "@/crm/lib/contact-name";

/** Tag on a contact the inbox created, so the team can find and tidy them. */
export const FROM_INBOX_TAG = "from-inbox";
/** Tag on a captured contact no account could be found for. */
export const NEEDS_ACCOUNT_TAG = "needs-account";

/**
 * Consumer mail domains: a sender there says nothing about which company they
 * work for, so they are never mapped to an account by domain.
 */
const FREEMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "mail.com",
  "yandex.com",
  "zoho.com",
]);

export function emailDomainOf(email: string): string {
  return (email.toLowerCase().split("@")[1] ?? "").trim();
}

export function isFreemailDomain(domain: string): boolean {
  return FREEMAIL_DOMAINS.has(domain.toLowerCase());
}

/** A header that may arrive as a string, a list, or a structured value, as lower-case text. */
type HeaderLookup = (name: string) => unknown;

function headerValue(get: HeaderLookup, name: string): string {
  const v = get(name);
  if (typeof v === "string") return v.toLowerCase();
  if (Array.isArray(v)) return v.join(" ").toLowerCase();
  if (v && typeof v === "object" && "value" in v) return String((v as { value: unknown }).value).toLowerCase();
  return "";
}

const AUTOMATED_LOCAL_RE = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?)([+.-]|$)/i;

/**
 * Machine-sent mail (auto-replies, out-of-office, bounces, mailing lists,
 * newsletters). It still lands in the inbox, but never becomes a contact: an
 * out-of-office is not a person, and a newsletter sender would fill the CRM
 * with "noreply" contacts.
 */
export function isAutomatedMail(get: HeaderLookup, fromEmail: string): boolean {
  const autoSubmitted = headerValue(get, "auto-submitted");
  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (headerValue(get, "list-id") || headerValue(get, "list-unsubscribe")) return true;
  if (/\b(bulk|list|junk|auto_reply)\b/.test(headerValue(get, "precedence"))) return true;
  if (headerValue(get, "x-autoreply") || headerValue(get, "x-autorespond")) return true;
  return AUTOMATED_LOCAL_RE.test(fromEmail.split("@")[0] ?? "");
}

/** "Re: Fwd: RE: Sponsorship" -> "sponsorship", for matching a conversation by subject. */
export function normalizeSubject(subject: string | null | undefined): string {
  let s = (subject ?? "").trim();
  for (;;) {
    const next = s.replace(/^(re|fw|fwd|aw|sv|antw)\s*(\[\d+\])?\s*:\s*/i, "");
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, " ").toLowerCase();
}

function titleCase(word: string): string {
  return word ? word[0]!.toUpperCase() + word.slice(1) : word;
}

/**
 * A new contact's name from the sender's display name. Reuses the import's
 * cleaner (Outlook's "Last, First", bracket tags, quotes). With no usable
 * name, the email's local part stands in and the contact is tagged
 * needs-name; a missing surname becomes "Unknown", also tagged, because a CRM
 * contact needs both names and a guess would read as fact.
 */
export function contactNameFromSender(displayName: string | null, email: string): {
  firstName: string;
  lastName: string;
  tags: string[];
} {
  const raw = (displayName ?? "").trim();
  const usable = raw && !raw.includes("@") ? raw : "";
  const [first = "", ...rest] = usable.split(/\s+/);
  const cleaned = cleanContactName(first, rest.join(" "));
  const tags = new Set(cleaned.qualityTags);

  let firstName = cleaned.firstName.trim();
  let lastName = cleaned.lastName.trim();
  if (!firstName) {
    const local = email.split("@")[0] ?? "";
    const parts = local.split(/[._-]+/).filter(Boolean);
    firstName = titleCase(parts[0] ?? local);
    lastName = parts.length > 1 ? titleCase(parts.slice(1).join(" ")) : "";
    tags.add(NEEDS_NAME_TAG);
  }
  if (!lastName) {
    lastName = "Unknown";
    tags.add(NEEDS_NAME_TAG);
  }
  return { firstName, lastName, tags: [...tags] };
}

/**
 * Which way a captured message went, and who the sponsor-side person is.
 *
 *   inbound   someone wrote TO the mailbox: the counterparty is the sender
 *   outbound  the mailbox wrote out (a rep in Outlook): the counterparty is the
 *             first outside recipient
 *   skip      it names neither, it is internal-only (colleagues, the CRM's own
 *             forward copies), or it is the CRM's receiving domain itself
 */
export function captureDirection(args: {
  mailbox: string;
  fromEmail: string;
  recipients: string[];
  isInternal: (email: string) => boolean;
  replyDomain: string | null;
}):
  | { kind: "inbound"; counterparty: string }
  | { kind: "outbound"; counterparty: string }
  | { kind: "skip"; reason: string } {
  const mailbox = args.mailbox.toLowerCase();
  const from = args.fromEmail.toLowerCase();
  const recipients = args.recipients.map((r) => r.toLowerCase());
  const outside = (e: string) =>
    !args.isInternal(e) && e !== mailbox && (!args.replyDomain || emailDomainOf(e) !== args.replyDomain.toLowerCase());

  if (from === mailbox) {
    const counterparty = recipients.find(outside);
    return counterparty ? { kind: "outbound", counterparty } : { kind: "skip", reason: "internal-only" };
  }
  if (!recipients.includes(mailbox)) return { kind: "skip", reason: "mailbox-not-addressed" };
  if (!outside(from)) return { kind: "skip", reason: "internal-sender" };
  return { kind: "inbound", counterparty: from };
}
