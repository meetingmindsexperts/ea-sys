/**
 * CME / CPD hours: what may be entered and how it is printed (Nov 12, 2026).
 *
 * Owner, Nov 12: "cme should handle 2 digits 3.75 or 5.25". Until then the
 * three columns that hold hours (Event.cmeHours, CertificateTemplate.cmeHours,
 * IssuedCertificate.cmeHoursSnapshot) were DECIMAL(4,1), so 3.75 was stored as
 * 3.8 without a word, and the certificate printed one decimal whatever was
 * stored. They are DECIMAL(5,2) now (migration 20261112130000).
 *
 * THE one rule, asked by the CME settings and template routes, the agent's
 * three tools, their MCP schemas and the Certificates page's inputs. Each had
 * its own copy (0 to 999 here, 0 to 999.9 there), which is how the limit and
 * the database drifted apart. A value with a third decimal is REFUSED, not
 * rounded: the database would round it silently, and a certificate must print
 * what the accreditor awarded.
 *
 * Pure and client-safe.
 */
import { z } from "zod";

export const CME_HOURS_MAX = 999.99;

export const CME_HOURS_MESSAGE =
  "CME hours must be a number from 0 to 999.99 with at most two decimal places, for example 3.75";

/** A number of hours we can store exactly: finite, 0 to 999.99, at most two decimals. */
export function isValidCmeHours(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (value < 0 || value > CME_HOURS_MAX) return false;
  // 3.75 * 100 is 375 exactly, but 1.15 * 100 is 114.99999999999999: compare with a tolerance.
  const hundredths = value * 100;
  return Math.abs(hundredths - Math.round(hundredths)) < 1e-6;
}

/**
 * The zod field for hours in a request body. Compose with .nullable() /
 * .optional() at the use. The range is stated as min and max as well as in the
 * check, so a schema generated from it (the agent's tool list) still shows it.
 */
export const cmeHoursField = z
  .number()
  .min(0, CME_HOURS_MESSAGE)
  .max(CME_HOURS_MAX, CME_HOURS_MESSAGE)
  .refine(isValidCmeHours, { message: CME_HOURS_MESSAGE })
  .describe("Hours from 0 to 999.99, at most two decimal places (for example 3.75)");

/**
 * Hours as printed on a certificate ({{cmeHours}}): up to two decimals, no
 * trailing zeros. 18 → "18", 5.5 → "5.5", 3.75 → "3.75". Empty for none.
 */
export function formatCmeHours(hours: number | null | undefined): string {
  if (hours == null) return "";
  return String(Math.round(hours * 100) / 100);
}
