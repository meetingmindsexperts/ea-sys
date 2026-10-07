/**
 * Phase 6 review LOW (Oct 7, 2026): a shared registration view could publish
 * sponsor attribution (finance data) for someone without finance.view.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { viewDisclosesSponsors } from "@/lib/registration-share-http";

describe("viewDisclosesSponsors", () => {
  it("is true for the Sponsor column or any sponsor filter, and only then", () => {
    expect(viewDisclosesSponsors({ fields: ["sponsor"], sponsorIds: [] })).toBe(true);
    expect(viewDisclosesSponsors({ fields: [], sponsorIds: ["s1"] })).toBe(true);
    expect(viewDisclosesSponsors({ fields: ["organization", "promoCode"], sponsorIds: [] })).toBe(false);
  });

  it("is refused without finance.view on both the create and the edit route", () => {
    for (const f of ["src/app/api/events/[eventId]/registration-shares/route.ts", "src/app/api/events/[eventId]/registration-shares/[viewId]/route.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toContain('viewDisclosesSponsors(parsed.data) && !can(gate.principal, "finance.view")');
    }
  });
});
