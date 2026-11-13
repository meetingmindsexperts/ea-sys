import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Step 2 of docs/ORG_FIELDS_PLAN.md (Nov 13, 2026). Whether Title, Role and
 * Specialty are asked and demanded is the ORGANISATION's choice, and one rule
 * answers it (src/lib/person-field-check.ts). Before this, "Role is required"
 * and "Specialty is required" were written into eight route schemas and nine
 * forms, with "Others needs the typed specialty" beside them in about fifteen
 * places: an organisation that switched a field off would have been refused
 * by whichever door nobody remembered.
 *
 * Two guards:
 *  1. every door that takes a person's details asks the rule;
 *  2. no file demands these fields by itself again.
 */

const ROOT = process.cwd();
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

/** The server doors, and the call each makes to the organisation's rules. */
const DOORS: Record<string, RegExp> = {
  "src/app/api/public/events/[slug]/register/route.ts": /personFieldRefusal\(event\.organizationId/,
  "src/app/api/public/events/[slug]/complete-registration/route.ts": /personFieldRefusal\(registration\.event\.organizationId/,
  "src/app/api/public/events/[slug]/group-register/route.ts": /personFieldProblems\(member\.attendee, fieldRules\)/,
  "src/app/api/public/events/[slug]/submitter/route.ts": /personFieldRefusal\(orgId/,
  "src/app/api/public/events/[slug]/abstract-start/route.ts": /personFieldRefusal\(event\.organizationId/,
  "src/app/api/events/[eventId]/registrations/walk-in/route.ts": /personFieldRefusal\(orgGuard\.orgId, parsed\.data, \{ demandTitle: true \}\)/,
  "src/app/api/auth/signup/route.ts": /missingRequiredDetails\(details, await loadPersonFieldRules\(/,
  "src/app/api/registrant/account-details/route.ts": /missingRequiredDetails\(after, await loadPersonFieldRules\(/,
  // The "profile complete" gate on submitting an abstract or a proposal.
  "src/app/api/events/[eventId]/abstracts/route.ts": /missingProfileFields\(speaker, await loadPersonFieldRules\(event\.organizationId\)\)/,
  "src/app/api/events/[eventId]/abstracts/[abstractId]/route.ts": /missingProfileFields\(existingAbstract\.speaker, await loadPersonFieldRules\(event\.organizationId\)\)/,
  "src/app/api/events/[eventId]/session-proposals/route.ts": /missingProfileFields\(speaker, await loadPersonFieldRules\(event\.organizationId\)\)/,
  "src/app/api/events/[eventId]/session-proposals/[proposalId]/route.ts": /missingProfileFields\(existing\.speaker, await loadPersonFieldRules\(event\.organizationId\)\)/,
};

/** The forms people fill in: each reads the same rules in the browser. */
const FORMS = [
  "src/app/e/[slug]/register/[category]/page.tsx",
  "src/app/e/[slug]/complete-registration/page.tsx",
  "src/app/e/[slug]/group/register/group-register-content.tsx",
  "src/app/e/[slug]/my-registration/page.tsx",
  "src/components/auth/signup-form.tsx",
  "src/components/public/submitter-register.tsx",
  "src/app/(dashboard)/my-account/details/page.tsx",
  "src/app/(dashboard)/events/[eventId]/my-details/page.tsx",
  "src/app/(dashboard)/events/[eventId]/check-in/desk-panel.tsx",
];

describe("every door asks the organisation's rule", () => {
  it.each(Object.entries(DOORS))("%s", (file, call) => {
    expect(read(file)).toMatch(call);
  });

  it.each(FORMS)("the form %s reads the rules", (file) => {
    const source = read(file);
    expect(source).toMatch(/usePersonFieldRules\(\)/);
    expect(source).toMatch(/fieldRules\.(title|role|specialty)\.shown/);
  });
});

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** A demand written by hand. Each of these shapes existed in several files before step 2. */
const OWN_DEMANDS: Array<[string, RegExp]> = [
  ["a schema that demands Specialty", /specialty:\s*z\.string\(\)(?:\.trim\(\))?\.min\(1/],
  ["a schema that demands Role", /\brole:\s*(?:attendeeRoleEnum\s*,|z\.string\(\)\.min\(1)/],
  ["its own Others rule", /specialty\s*!==\s*"Others"\s*\|\|/],
  ["its own message", /["'`]Specialty is required["'`]|["'`]Role is required["'`]/],
];

/** Where the one rule is written. */
const THE_RULE = new Set(["src/lib/person-field-check.ts"]);

describe("no file demands Title, Role or Specialty by itself", () => {
  const files = ["src", "worker"].flatMap((root) => sourceFiles(join(ROOT, root))).map((full) => relative(ROOT, full));

  it("scans the source (the list is not silently empty)", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it.each(OWN_DEMANDS)("%s is found nowhere but the rule itself", (_what, pattern) => {
    const found = files.filter((file) => !THE_RULE.has(file) && pattern.test(read(file)));
    // If this fails, a schema or a form is demanding the field by itself. Take
    // the field leniently (optionalAttendeeRole, optionalSpecialty) and ask
    // personFieldRefusal / withPersonFieldRules with the organisation's rules:
    // otherwise an organisation that switched the field off is refused here.
    expect(found).toEqual([]);
  });
});
