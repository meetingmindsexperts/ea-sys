/**
 * Plan the contact → account links from a Freshsales `Account_contacts.csv`
 * (columns: Id, Sales Account id, Contact id, Is Primary).
 *
 * Freshsales keeps the contact↔account relation in its OWN file: the Contacts
 * export carries no account column, so the first import (Aug to Oct 2026) left
 * 3,331 of 3,336 contacts with no account. A contact may hold several accounts
 * there; a CrmContact holds one (`companyId`), so the PRIMARY row wins and a
 * contact with no primary row is reported, never guessed.
 *
 * Pure: the caller resolves Freshsales ids to EA rows and applies the plan.
 * Owner ruling (Oct 27, 2026): the file wins, so an existing different link is
 * moved and reported as a change.
 */

export interface AccountContactRow {
  accountExternalId: string;
  contactExternalId: string;
  isPrimary: boolean;
}

export interface LinkPlan {
  /** contact id → account id, only rows that need a write. */
  writes: Array<{ contactId: string; companyId: string; previousCompanyId: string | null }>;
  alreadyLinked: number;
  /** Freshsales contact ids with rows but no primary one. */
  noPrimary: string[];
  missingContact: string[];
  missingAccount: string[];
}

/** Parse rows as the CSV parser returns them. Header names are matched loosely. */
export function readAccountContactRows(headers: string[], rows: string[][]): AccountContactRow[] | { error: string } {
  const key = (h: string) => h.toLowerCase().replace(/[^a-z]/g, "");
  const idx = (name: string) => headers.findIndex((h) => key(h) === name);
  const acc = idx("salesaccountid");
  const con = idx("contactid");
  const pri = idx("isprimary");
  if (acc < 0 || con < 0 || pri < 0) {
    return { error: "Expected columns: Sales Account id, Contact id, Is Primary" };
  }
  return rows
    .map((r) => ({
      accountExternalId: (r[acc] ?? "").trim(),
      contactExternalId: (r[con] ?? "").trim(),
      isPrimary: (r[pri] ?? "").trim().toLowerCase() === "true",
    }))
    .filter((r) => r.accountExternalId && r.contactExternalId);
}

export function planAccountLinks(
  rows: AccountContactRow[],
  contacts: Map<string, { id: string; companyId: string | null }>,
  accounts: Map<string, { id: string }>,
): LinkPlan {
  const plan: LinkPlan = { writes: [], alreadyLinked: 0, noPrimary: [], missingContact: [], missingAccount: [] };

  const primaryByContact = new Map<string, string>();
  const seen = new Set<string>();
  for (const r of rows) {
    seen.add(r.contactExternalId);
    if (r.isPrimary) primaryByContact.set(r.contactExternalId, r.accountExternalId);
  }
  for (const c of seen) if (!primaryByContact.has(c)) plan.noPrimary.push(c);

  for (const [contactExt, accountExt] of primaryByContact) {
    const contact = contacts.get(contactExt);
    if (!contact) {
      plan.missingContact.push(contactExt);
      continue;
    }
    const account = accounts.get(accountExt);
    if (!account) {
      plan.missingAccount.push(accountExt);
      continue;
    }
    if (contact.companyId === account.id) {
      plan.alreadyLinked++;
      continue;
    }
    plan.writes.push({ contactId: contact.id, companyId: account.id, previousCompanyId: contact.companyId });
  }
  return plan;
}
