/**
 * Sponsor attribution: the redaction boundary, the export cell, and the
 * three-arm union that answers "everyone this sponsor brought".
 *
 * See docs/SPONSOR_ATTRIBUTION_PLAN.md. The tests worth reading are the ones
 * pinning things that fail SILENTLY:
 *
 *  - a missing group arm returns zero rows for a sponsor's twenty-person
 *    delegation and looks like "that sponsor brought nobody";
 *  - an unredacted sponsorId is a Mecomed-sensitive disclosure with no visible
 *    symptom at all;
 *  - a filter left open on a redacted field hands the same fact back by
 *    elimination, which is the shape a reviewer reads past.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { canViewFinance, redactFinancialFields } from "@/lib/finance-visibility";
import {
  buildRegistrationExportRow,
  REGISTRATION_EXPORT_HEADERS,
  REGISTRATION_SALES_COLUMNS,
} from "@/lib/registration-export";

const ROUTE = path.join(
  process.cwd(),
  "src/app/api/events/[eventId]/registrations/route.ts",
);

describe("sponsor attribution sits in FINANCIAL_KEYS, beside the payer", () => {
  const row = { id: "r1", sponsorId: "spn_abbott", status: "CONFIRMED" };

  it("strips sponsorId for a role that cannot see finance", () => {
    expect(canViewFinance("REVIEWER")).toBe(false);
    expect(redactFinancialFields(row)).toEqual({ id: "r1", status: "CONFIRMED" });
  });

  /**
   * ⚠ MEMBER SEES THIS, AND THAT IS THE CURRENT DESIGN.
   *
   * Pinned as its own test because the comment sitting directly above the payer
   * keys in finance-visibility.ts says "A MEMBER inferring 'Dr. X is funded by
   * pharma Y' is exactly the Mecomed-sensitive disclosure MEMBER must not see",
   * and that sentence is STALE: MEMBER joined FINANCE_ROLES with the June 17
   * 2026 "desk staff record payments" decision, so `canViewFinance("MEMBER")`
   * has been true ever since and none of those keys is redacted for it.
   *
   * The stale comment cost real time on Sep 2 2026: an adversarial review of
   * the sponsor plan read it, concluded sponsorId was inconsistent with the
   * payer fields, and raised a HIGH that did not exist. The two are treated
   * IDENTICALLY, before and after this change.
   *
   * So: putting sponsorId here buys consistency with the payer keys and nothing
   * more. **If the intent is that MEMBER must not learn who funds a doctor,
   * FINANCIAL_KEYS is the wrong lever** and it needs its own narrower predicate,
   * the way the CRM's canViewDealValues is deliberately narrower than
   * canViewFinance. That is an owner decision, not a patch.
   */
  it("does NOT hide it from MEMBER, ONSITE or WEBINARS, which are finance-capable", () => {
    // The redactor itself always strips; the ROLE is the caller's gate. So the
    // property that matters is the predicate, and every route applies it as
    // `canViewFinance(role) ? payload : redactFinancialFields(payload)`.
    for (const role of ["ADMIN", "ORGANIZER", "SUPER_ADMIN", "MEMBER", "ONSITE", "WEBINARS"]) {
      expect(canViewFinance(role), role).toBe(true);
    }
    const asMember = canViewFinance("MEMBER") ? row : redactFinancialFields(row);
    expect(asMember.sponsorId).toBe("spn_abbott");
  });

  it("redacts it wherever it appears, including nested and in arrays", () => {
    const payload = { registrations: [{ id: "r1", sponsorId: "s1" }], promoCode: { sponsorId: "s1" } };
    const out = redactFinancialFields(payload) as typeof payload;
    expect(out.registrations[0]).not.toHaveProperty("sponsorId");
    expect(out.promoCode).not.toHaveProperty("sponsorId");
  });

  it("does NOT redact the sponsor LIST, which is public", () => {
    // Logos on the public session page and the registration page. The redactor
    // strips by key NAME recursively, so a bare "sponsors" would blank that
    // everywhere. Pinned because the fix for one leak is a plausible cause of
    // the other.
    const publicPayload = { sponsors: [{ id: "s1", name: "Abbott", tier: "gold" }] };
    expect(redactFinancialFields(publicPayload)).toEqual(publicPayload);
  });
});

describe("the sponsor filter", () => {
  const src = readFileSync(ROUTE, "utf8");

  it("unions all THREE attribution routes", () => {
    // The group arm is the one that was missing from the first draft. A group
    // puts the promo code on RegistrationGroup.promoCodeId and leaves every
    // member's own promoCodeId null, so without it a sponsor's delegation
    // returns nothing and the screen reads as "they brought nobody".
    expect(src).toContain("{ sponsorId: sponsorFilterId }");
    expect(src).toContain("{ promoCode: { sponsorId: sponsorFilterId } }");
    expect(src).toContain("{ group: { promoCode: { sponsorId: sponsorFilterId } } }");
  });

  it("is gated on the same predicate as the redaction", () => {
    // A redacted field must not stay filterable: filter to Abbott, read the
    // names off the rows, and the redaction has bought nothing.
    expect(src).toMatch(/sponsorFilterId && !canViewFinance\(/);
    expect(src).toContain("SPONSOR_FILTER_FORBIDDEN");
  });

  it("logs the refusal", () => {
    expect(src).toContain("events/registrations:sponsor-filter-refused");
  });
});

describe("the Sponsor export column", () => {
  const ctx = {
    taxRate: null,
    taxLabel: null,
    sponsorNameById: new Map([["spn_abbott", "Abbott"]]),
  };
  const base = {
    id: "r1",
    status: "CONFIRMED",
    paymentStatus: "INCLUSIVE",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    attendee: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.test" },
  };
  const cell = (r: Record<string, unknown>) =>
    buildRegistrationExportRow({ ...base, ...r } as never, ctx)[
      (REGISTRATION_EXPORT_HEADERS as readonly string[]).indexOf("Sponsor")
    ];

  it("exists in both exports", () => {
    expect(REGISTRATION_EXPORT_HEADERS).toContain("Sponsor");
    expect(REGISTRATION_SALES_COLUMNS).toContain("Sponsor");
  });

  it("prints the NAME, not the id", () => {
    expect(cell({ sponsorId: "spn_abbott" })).toBe("Abbott");
  });

  it("is blank when there is no sponsor", () => {
    expect(cell({ sponsorId: null })).toBe("");
  });

  it("falls back to the id when the caller passed no map", () => {
    // Diagnosable beats blank: a blank cell reads as "no sponsor", which is a
    // wrong answer rather than a missing one.
    const out = buildRegistrationExportRow(
      { ...base, sponsorId: "spn_abbott" } as never,
      { taxRate: null, taxLabel: null },
    );
    expect(out[(REGISTRATION_EXPORT_HEADERS as readonly string[]).indexOf("Sponsor")]).toBe(
      "spn_abbott",
    );
  });

  it("is blank when redaction removed the field", () => {
    expect(cell({})).toBe("");
  });
});
