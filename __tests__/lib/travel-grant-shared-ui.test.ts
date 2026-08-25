/**
 * The console page and the speaker-profile card render the same verdicts, the
 * same statuses and the same public link. They were written twice and had
 * ALREADY DRIFTED before either shipped: the console said "UAE — not eligible"
 * and the card said "UAE, not eligible" for one state.
 *
 * This is a source-level guard, like the setup-hub coverage test: it asserts
 * neither surface re-declares what the shared module owns. A rendering test
 * would need both pages stubbed and would then be testing the stubs.
 *
 * MUTATION TO VERIFY AGAINST: paste a literal "Awaiting reply" or a hand-built
 * `/e/${slug}/travel-grant/${token}` back into either file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RESIDENCY_LABEL,
  GRANT_STATUS_LABEL,
  canManageTravelGrants,
  publicTravelGrantUrl,
} from "@/lib/travel-grant/constants";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const CONSOLE_PAGE = read("src/app/(dashboard)/events/[eventId]/travel-grants/page.tsx");
const CARD = read("src/components/speakers/speaker-travel-grant-card.tsx");
const SURFACES: [string, string][] = [
  ["console page", CONSOLE_PAGE],
  ["speaker card", CARD],
];

describe("the shared vocabulary", () => {
  it("covers every residency class and every status", () => {
    expect(Object.keys(RESIDENCY_LABEL).sort()).toEqual(["overseas", "uae", "unknown"]);
    expect(Object.keys(GRANT_STATUS_LABEL).sort()).toEqual(["CONSENTED", "DECLINED", "PENDING"]);
  });

  it("builds the public link one way", () => {
    expect(publicTravelGrantUrl("https://x", "medcon", "tok")).toBe(
      "https://x/e/medcon/travel-grant/tok",
    );
  });

  it("admits only the three roles the server's denyReviewer gate admits", () => {
    for (const r of ["SUPER_ADMIN", "ADMIN", "ORGANIZER"]) {
      expect(canManageTravelGrants(r)).toBe(true);
    }
    // MEMBER is internal read-only staff and is excluded ON PURPOSE: this is a
    // list of who asked to have their travel paid for.
    for (const r of ["MEMBER", "ONSITE", "WEBINARS", "CRM_USER", "REVIEWER", "SUBMITTER", "REGISTRANT"]) {
      expect(canManageTravelGrants(r)).toBe(false);
    }
    expect(canManageTravelGrants(null)).toBe(false);
    expect(canManageTravelGrants(undefined)).toBe(false);
  });
});

describe("neither surface re-declares what the shared module owns", () => {
  const labels = [...Object.values(RESIDENCY_LABEL), ...Object.values(GRANT_STATUS_LABEL)];

  it.each(SURFACES)("%s contains no hardcoded verdict or status label", (_name, src) => {
    // Strip comments first: the card's docblock legitimately QUOTES a label
    // while explaining why it must not be duplicated, and a guard that cannot
    // tell prose from code fails on its own documentation.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const found = labels.filter((l) => code.includes(`"${l}"`) || code.includes(`>${l}<`));
    expect(found).toEqual([]);
  });

  it.each(SURFACES)("%s builds no travel-grant URL by hand", (_name, src) => {
    expect(src).not.toMatch(/\/travel-grant\/\$\{/);
  });

  it.each(SURFACES)("%s does not hardcode the role list", (_name, src) => {
    expect(src).not.toMatch(/"SUPER_ADMIN"\s*,\s*"ADMIN"/);
  });
});
