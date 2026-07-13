/**
 * The shared "which sends exclude CANCELLED by default" rule
 * (src/lib/bulk-email-audience.ts).
 *
 * This rule is consumed in three places that run in two different processes:
 * the server's Prisma `where` clause, and the two client-side recipient-count
 * predicates (Communications page, registrations list). It used to be written
 * out longhand in all three. That is a drift trap: the count the organizer
 * reads before hitting Send and the audience the server actually mails are
 * computed by different code, so any divergence shows up as a send that
 * silently reached more or fewer people than the button promised.
 *
 * These tests pin the rule itself. The per-send-type wiring is covered by
 * bulk-email-certificate-audience.test.ts (the `where` clause) — this file
 * covers the predicate every caller shares.
 */
import { describe, it, expect } from "vitest";
import {
  CANCELLED_EXCLUDED_EMAIL_TYPES,
  excludesCancelledByDefault,
} from "@/lib/bulk-email-audience";

describe("excludesCancelledByDefault", () => {
  it("excludes CANCELLED for the send types that must never reach one", () => {
    // payment-reminder: a cancelled registration owes nothing.
    expect(excludesCancelledByDefault("payment-reminder", undefined)).toBe(true);
    // certificate: a cancelled registration can never be issued a cert.
    expect(excludesCancelledByDefault("certificate", undefined)).toBe(true);
    // survey-invitation: completing the survey is what triggers cert
    // auto-issue, so inviting a cancelled registrant dangles a certificate the
    // sweep will (correctly) refuse to mint.
    expect(excludesCancelledByDefault("survey-invitation", undefined)).toBe(true);
  });

  it("leaves every other send type's audience alone", () => {
    // Notably `custom` — the Cancelled Re-engagement tile deliberately mails
    // cancelled registrants, and must keep working.
    for (const t of ["custom", "confirmation", "reminder", "template", "invitation", "agreement"]) {
      expect(excludesCancelledByDefault(t, undefined)).toBe(false);
    }
  });

  it("never overrides an explicit status filter", () => {
    // An explicit status already scopes the send. The guard exists to make the
    // DEFAULT safe, not to veto a deliberate choice — an organizer who filters
    // to CANCELLED and picks a certificate send is stopped by the dedicated
    // INVALID_FILTER guard in precheckBulkEmailViability, not by silently
    // mailing an empty audience here.
    expect(excludesCancelledByDefault("certificate", "CONFIRMED")).toBe(false);
    expect(excludesCancelledByDefault("survey-invitation", "CHECKED_IN")).toBe(false);
    expect(excludesCancelledByDefault("payment-reminder", "CANCELLED")).toBe(false);
  });

  it('treats the dashboard\'s "all" sentinel as "no filter"', () => {
    // The client says "all"; the server says undefined. One predicate has to
    // read both, or the count and the send disagree on what "unfiltered" means.
    expect(excludesCancelledByDefault("survey-invitation", "all")).toBe(true);
    expect(excludesCancelledByDefault("certificate", "all")).toBe(true);
  });

  it("is inert when no email type is supplied", () => {
    expect(excludesCancelledByDefault(undefined, undefined)).toBe(false);
    expect(excludesCancelledByDefault("", "all")).toBe(false);
  });

  it("holds exactly the three send types (a 4th must be a deliberate change)", () => {
    // Guards against a well-meaning "this one shouldn't reach cancelled people
    // either" being bolted on without the reasoning being written down.
    expect([...CANCELLED_EXCLUDED_EMAIL_TYPES].sort()).toEqual([
      "certificate",
      "payment-reminder",
      "survey-invitation",
    ]);
  });
});
