/**
 * Partnerships mailbox capture: the database half (Oct 27, 2026). SERVER ONLY.
 *
 * The inbound worker hands over a parsed email that reached the CRM through
 * the Microsoft 365 mail-flow rule rather than a reply token (rules and owner
 * decisions in src/crm/lib/inbox-capture.ts). This file finds or creates the
 * contact, maps a new contact to an account, finds the conversation the email
 * belongs to (or starts one), and records it, with a History row on every
 * record it touches.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { recordCrmActivity } from "@/crm/lib/crm-activity";
import { contactEmailKey, findOrCreateCrmContact, setCrmContactArchived } from "@/crm/services/crm-contact-service";
import {
  FROM_INBOX_TAG,
  NEEDS_ACCOUNT_TAG,
  contactNameFromSender,
  domainMatchesWebsite,
  emailDomainOf,
  isFreemailDomain,
  normalizeSubject,
} from "@/crm/lib/inbox-capture";

/** Recent threads with the same person checked for a subject match. */
const SUBJECT_MATCH_WINDOW = 20;
/** A subject match only joins a conversation active within this many days. */
const SUBJECT_MATCH_MAX_AGE_DAYS = 180;

export interface CaptureAccount {
  id: string;
  matchedBy: "website" | "colleague";
}

/**
 * The account a new contact from this email domain belongs to, when it is
 * unambiguous: exactly one account whose website names the domain, else
 * exactly one account that colleagues on the same domain already belong to.
 * A consumer domain (gmail.com) is never mapped.
 */
export async function findAccountForDomain(organizationId: string, domain: string): Promise<CaptureAccount | null> {
  if (!domain || isFreemailDomain(domain)) return null;

  // `contains` only narrows the candidates; the website's own domain must
  // equal the email domain (or be its parent), so "abbott.co" never maps to
  // the account whose site is abbott.com (review MED, Oct 27, 2026).
  const candidates = await db.crmCompany.findMany({
    where: { organizationId, archivedAt: null, website: { contains: domain, mode: "insensitive" } },
    select: { id: true, website: true },
    take: 20,
  });
  const byWebsite = candidates.filter((c) => domainMatchesWebsite(domain, c.website));
  if (byWebsite.length === 1) return { id: byWebsite[0]!.id, matchedBy: "website" };
  if (byWebsite.length > 1) return null;

  const colleagues = await db.crmContact.findMany({
    where: { organizationId, archivedAt: null, companyId: { not: null }, emailKey: { endsWith: `@${domain}` } },
    select: { companyId: true },
    distinct: ["companyId"],
    take: 2,
  });
  if (colleagues.length === 1) return { id: colleagues[0]!.companyId!, matchedBy: "colleague" };
  return null;
}

export interface CaptureContact {
  id: string;
  companyId: string | null;
  created: boolean;
}

/**
 * An archived contact emailed the mailbox: they are active again, so the
 * contact is restored with the reason in its History, never used silently
 * while archived (Oct 28, 2026). If the restore fails the email is still
 * filed, with no contact.
 */
async function restoreCaptureContact(
  organizationId: string,
  existing: { id: string; companyId: string | null },
): Promise<CaptureContact | null> {
  const res = await setCrmContactArchived({
    crmContactId: existing.id,
    organizationId,
    userId: null,
    source: "inbox",
    archived: false,
    reason: "Emailed the partnerships mailbox",
  });
  if (!res.ok) {
    apiLogger.error({ msg: "crm-capture:contact-restore-failed", organizationId, crmContactId: existing.id, code: res.code });
    return null;
  }
  apiLogger.info({ msg: "crm-capture:contact-restored", organizationId, crmContactId: existing.id });
  return { id: existing.id, companyId: existing.companyId, created: false };
}

/**
 * The contact a captured email is with. An existing contact (matched by email)
 * is used as is. An unknown PERSON becomes a new contact, tagged from-inbox,
 * mapped to an account by domain where one is unambiguous (needs-account
 * otherwise). Machine-sent mail never creates a contact: null.
 */
export async function resolveCaptureContact(args: {
  organizationId: string;
  email: string;
  displayName: string | null;
  automated: boolean;
}): Promise<CaptureContact | null> {
  const existing = await db.crmContact.findFirst({
    where: { organizationId: args.organizationId, emailKey: contactEmailKey(args.email) },
    select: { id: true, companyId: true, archivedAt: true },
  });
  if (existing?.archivedAt) return await restoreCaptureContact(args.organizationId, existing);
  if (existing) return { id: existing.id, companyId: existing.companyId, created: false };
  if (args.automated) return null;

  const account = await findAccountForDomain(args.organizationId, emailDomainOf(args.email));
  const name = contactNameFromSender(args.displayName, args.email);
  const tags = [FROM_INBOX_TAG, ...name.tags, ...(account ? [] : [NEEDS_ACCOUNT_TAG])];

  const res = await findOrCreateCrmContact({
    organizationId: args.organizationId,
    userId: null,
    source: "inbox",
    firstName: name.firstName,
    lastName: name.lastName,
    email: args.email,
    companyId: account?.id ?? null,
    tags,
    notes: "Created from an email to the partnerships mailbox.",
  });
  if (!res.ok) {
    apiLogger.error({ msg: "crm-capture:contact-create-failed", organizationId: args.organizationId, code: res.code });
    return null;
  }

  if (res.created && account) {
    void recordCrmActivity({
      organizationId: args.organizationId,
      entityType: "COMPANY",
      entityId: account.id,
      action: "CONTACT_ADDED",
      actorId: null,
      changes: {
        source: "inbox",
        contact: `${res.crmContact.firstName} ${res.crmContact.lastName}`.trim(),
        email: res.crmContact.emailKey,
        matchedBy: account.matchedBy === "website" ? "the account's website" : "colleagues on the same email domain",
      },
    });
  }
  apiLogger.info({
    msg: "crm-capture:contact-resolved",
    organizationId: args.organizationId,
    crmContactId: res.crmContact.id,
    created: res.created,
    accountMatchedBy: account?.matchedBy ?? null,
  });
  return { id: res.crmContact.id, companyId: res.crmContact.companyId, created: res.created === true };
}

/**
 * The conversation a captured email belongs to: the thread holding a message
 * it replies to (In-Reply-To / References), else the newest live thread with
 * the same person on the same subject. Null starts a new one.
 *
 * A References hit joins only a thread whose person shares the email's
 * counterparty domain: a Message-ID can leak through a forward, and must not
 * let anyone drop a message into another sponsor's conversation (review HIGH,
 * Oct 27, 2026).
 */
export async function findCaptureThread(args: {
  organizationId: string;
  references: string[];
  counterpartyEmail: string;
  subject: string | null;
}): Promise<string | null> {
  if (args.references.length) {
    const hit = await db.crmEmailMessage.findFirst({
      where: { organizationId: args.organizationId, messageId: { in: args.references } },
      select: { threadId: true, thread: { select: { counterpartyEmail: true } } },
      orderBy: { createdAt: "desc" },
    });
    if (hit && emailDomainOf(hit.thread.counterpartyEmail) === emailDomainOf(args.counterpartyEmail)) {
      return hit.threadId;
    }
    if (hit) apiLogger.warn({ msg: "crm-capture:reference-domain-mismatch", threadId: hit.threadId });
  }
  const subject = normalizeSubject(args.subject);
  if (!subject) return null;
  const since = new Date(Date.now() - SUBJECT_MATCH_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
  const recent = await db.crmEmailThread.findMany({
    where: {
      organizationId: args.organizationId,
      counterpartyEmail: args.counterpartyEmail.toLowerCase(),
      revokedAt: null,
      lastMessageAt: { gte: since },
    },
    select: { id: true, subject: true },
    orderBy: { lastMessageAt: "desc" },
    take: SUBJECT_MATCH_WINDOW,
  });
  return recent.find((t) => normalizeSubject(t.subject) === subject)?.id ?? null;
}

/** The contact's one live deal (open or won), or null when there are none or several. */
export async function soleDealForContact(organizationId: string, crmContactId: string): Promise<string | null> {
  const links = await db.crmDealContact.findMany({
    where: { crmContactId, deal: { organizationId, archivedAt: null, status: { not: "LOST" } } },
    select: { dealId: true },
    take: 2,
  });
  return links.length === 1 ? links[0]!.dealId : null;
}

/** True when this email is already filed (the capture copy and the reply-token copy of one message). */
export async function alreadyCaptured(organizationId: string, messageId: string | null): Promise<boolean> {
  if (!messageId) return false;
  const hit = await db.crmEmailMessage.findFirst({
    where: { organizationId, messageId },
    select: { id: true },
  });
  return !!hit;
}

/** History on every record a captured email touches: the contact, its account, the thread's deal. */
export function recordCaptureActivity(args: {
  organizationId: string;
  direction: "INBOUND" | "OUTBOUND";
  subject: string | null;
  counterpartyEmail: string;
  contact: { id: string; companyId: string | null } | null;
  dealId: string | null;
  threadId: string;
  unverified: boolean;
}): void {
  const action = args.direction === "INBOUND" ? "EMAIL_RECEIVED" : "EMAIL_SENT";
  const changes = {
    via: "partnerships mailbox",
    subject: args.subject ?? "(no subject)",
    [args.direction === "INBOUND" ? "from" : "to"]: args.counterpartyEmail,
    threadId: args.threadId,
    ...(args.unverified ? { unverified: true } : {}),
  };
  const targets: Array<{ entityType: "CONTACT" | "COMPANY" | "DEAL"; entityId: string }> = [];
  if (args.contact) targets.push({ entityType: "CONTACT", entityId: args.contact.id });
  if (args.contact?.companyId) targets.push({ entityType: "COMPANY", entityId: args.contact.companyId });
  if (args.dealId) targets.push({ entityType: "DEAL", entityId: args.dealId });
  for (const t of targets) {
    void recordCrmActivity({ organizationId: args.organizationId, ...t, action, actorId: null, changes });
  }
}
