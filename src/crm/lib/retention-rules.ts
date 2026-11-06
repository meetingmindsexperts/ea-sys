/**
 * CRM data retention, per organisation (Nov 6, 2026; CRM product review P1-9).
 * Pure, client-safe.
 *
 * OFF BY DEFAULT, and off means nothing is ever deleted: no organisation has a
 * period until an admin sets one, because how long sponsorship correspondence
 * and negotiation notes must be kept is the organisation's own decision
 * (contracts, tax and audit duties differ). Stored in
 * `Organization.settings.crmRetention`; the crm-retention worker applies it.
 *
 * Two periods, each optional: email threads by their LAST message, notes by
 * when they were written. Deals, accounts, contacts and quotes are never aged
 * out: they are the commercial record, and a person's own data is removed by
 * erasure (crm-privacy-service.ts), not by age.
 */
import { z } from "zod";

/** At least a year and at most ten: a shorter period is almost always a typo, and so is a longer one. */
export const RETENTION_MIN_MONTHS = 12;
export const RETENTION_MAX_MONTHS = 120;

const months = z.number().int().min(RETENTION_MIN_MONTHS).max(RETENTION_MAX_MONTHS).nullable();

export const crmRetentionSchema = z.object({ emailMonths: months, notesMonths: months });
export type CrmRetention = z.infer<typeof crmRetentionSchema>;

export const RETENTION_OFF: CrmRetention = { emailMonths: null, notesMonths: null };

/** The stored periods; OFF when absent or corrupt (a corrupt block must never delete anything). */
export function readCrmRetention(settings: unknown): CrmRetention {
  const parsed = crmRetentionSchema.safeParse((settings as { crmRetention?: unknown } | null)?.crmRetention);
  return parsed.success ? parsed.data : RETENTION_OFF;
}

export function retentionIsOn(r: CrmRetention): boolean {
  return r.emailMonths !== null || r.notesMonths !== null;
}

/** The moment before which data of that kind is older than its period. */
export function retentionCutoff(monthsKept: number, now: Date): Date {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - monthsKept);
  return d;
}
