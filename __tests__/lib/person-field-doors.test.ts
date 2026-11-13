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
 * Three guards:
 *  1. every door that takes a person's details asks the rule;
 *  2. every route that takes these fields at all is either one of those doors
 *     or named below as one that never demanded them, with why: a NEW route
 *     fails here until somebody decides which it is;
 *  3. no file demands these fields by itself again.
 *
 * The review of f0899baf found the first version of this file promising more
 * than it checked: a new route was never noticed, three of the shapes a demand
 * had been written in were not matched, and the two browser gates that judge
 * "is this profile complete" were not listed (they asked no rules at all).
 */

const ROOT = process.cwd();
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

/**
 * The server doors, and the call each makes to the rules. A door that belongs
 * to an EVENT hands over the event (its organisation and its settings), so the
 * event's own choice is laid over the organisation's; only the two doors with
 * no event ask the organisation alone.
 */
const DOORS: Record<string, RegExp> = {
  "src/app/api/public/events/[slug]/register/route.ts": /checkEventPersonFields\(event, validated\.data\)/,
  "src/app/api/public/events/[slug]/complete-registration/route.ts": /personFieldRefusal\(registration\.event, validated\.data\)/,
  "src/app/api/public/events/[slug]/group-register/route.ts": /loadEventPersonFieldRules\(event\)[\s\S]*personFieldProblems\(member\.attendee, fieldRules\)/,
  "src/app/api/public/events/[slug]/submitter/route.ts": /checkEventPersonFields\(event, validated\.data\)/,
  "src/app/api/public/events/[slug]/abstract-start/route.ts": /checkEventPersonFields\(event, parsed\.data\.details\)/,
  "src/app/api/events/[eventId]/registrations/walk-in/route.ts": /checkEventPersonFields\(event, data, \{ demandTitle: true \}\)/,
  "src/app/api/auth/signup/route.ts": /missingRequiredDetails\(details, await loadOrganizationPersonFieldRules\(/,
  "src/app/api/registrant/account-details/route.ts": /missingRequiredDetails\(after, await loadOrganizationPersonFieldRules\(/,
  // The "profile complete" gate on submitting an abstract or a proposal.
  "src/app/api/events/[eventId]/abstracts/route.ts": /missingProfileFields\(speaker, await loadEventPersonFieldRules\(event\)\)/,
  "src/app/api/events/[eventId]/abstracts/[abstractId]/route.ts": /missingProfileFields\(existingAbstract\.speaker, await loadEventPersonFieldRules\(event\)\)/,
  "src/app/api/events/[eventId]/session-proposals/route.ts": /missingProfileFields\(speaker, await loadEventPersonFieldRules\(event\)\)/,
  "src/app/api/events/[eventId]/session-proposals/[proposalId]/route.ts": /missingProfileFields\(existing\.speaker, await loadEventPersonFieldRules\(event\)\)/,
};

/** The only doors with no event: account sign-up and My account. Every other door has one and must use its rules. */
const NO_EVENT_DOORS = ["src/app/api/auth/signup/route.ts", "src/app/api/registrant/account-details/route.ts"];

/** The doors that CREATE a person's record: a field the event does not ask is not stored, whoever sent it. */
const CREATE_DOORS = [
  "src/app/api/public/events/[slug]/register/route.ts",
  "src/app/api/public/events/[slug]/group-register/route.ts",
  "src/app/api/public/events/[slug]/submitter/route.ts",
  "src/app/api/public/events/[slug]/abstract-start/route.ts",
  "src/app/api/events/[eventId]/registrations/walk-in/route.ts",
];

/**
 * Routes that take Title, Role or Specialty in a schema and are NOT a door
 * that demands them, each with why. Staff doors show all three whatever the
 * organisation switched off (the Settings card says so), and a self-edit of a
 * record that exists changes what is there without demanding more.
 */
const NOT_A_DOOR: Record<string, string> = {
  "src/app/api/organization/person-fields/route.ts": "the settings themselves",
  "src/app/api/events/route.ts": "the event's own topic (Event.specialty), not a person",
  "src/app/api/events/[eventId]/route.ts": "the event's own topic (Event.specialty), not a person",
  "src/app/api/contacts/route.ts": "staff: the contact store never demanded them",
  "src/app/api/contacts/[contactId]/route.ts": "staff: the contact store never demanded them",
  "src/app/api/events/[eventId]/registrations/route.ts": "staff: Add Registration never demanded them",
  "src/app/api/events/[eventId]/registrations/[registrationId]/route.ts": "staff: editing a registration never demanded them",
  "src/app/api/events/[eventId]/speakers/route.ts": "staff: adding a speaker never demanded them",
  "src/app/api/events/[eventId]/speakers/[speakerId]/route.ts": "staff: editing a speaker never demanded them",
  "src/app/api/events/[eventId]/abstracts/my-profile/route.ts":
    "the submitter's own edit of a record that exists: the demand is the profile gate at submit, which is a door above; its GET sends the rules",
  "src/app/api/registrant/registrations/route.ts": "the registrant's own edit of a registration that exists: never demanded them",
  "src/app/api/registrant/my-group/[groupId]/members/route.ts":
    "a coordinator adding people to a group: this form has never asked Role or Specialty (docs/ROADMAP.md, person fields)",
};

/** A route's schema naming one of the three fields. */
const TAKES_THE_FIELDS =
  /\b(?:specialty|customSpecialty)\s*:\s*(?:z\.|optional\(|required\(|optionalSpecialty)|personalDetailsFields|presenterDetailsSchema|\brole\s*:\s*(?:optionalAttendeeRole|attendeeRoleEnum)/;

/**
 * The forms people fill in: each reads the organisation's rules, shows a field
 * only while it is asked, and checks with the one rule (never its own list).
 */
const FORMS = [
  "src/app/e/[slug]/register/[category]/page.tsx",
  "src/app/e/[slug]/complete-registration/page.tsx",
  "src/app/e/[slug]/group/register/group-register-content.tsx",
  "src/components/auth/signup-form.tsx",
  "src/components/public/submitter-register.tsx",
  "src/app/(dashboard)/my-account/details/page.tsx",
  "src/app/(dashboard)/events/[eventId]/my-details/page.tsx",
  "src/app/(dashboard)/events/[eventId]/check-in/desk-panel.tsx",
];

/** Forms that show these fields and demand none of them: they only have to hide what is off. */
const SHOWS_ONLY = [
  // The registrant's own edit of a registration that exists.
  "src/app/e/[slug]/my-registration/page.tsx",
  // A coordinator adding people: asks Title, and neither Role nor Specialty.
  "src/components/public/add-group-members-dialog.tsx",
];

/** The browser's "is this profile complete" judges: by the rules that came with the profile, never a guess. */
const PROFILE_GATES = ["src/hooks/use-submitter-profile-gate.ts", "src/components/abstracts/submitter-profile-nudge.tsx"];

/** Where the rules a form follows come from: the hook, or the profile read that carries the event's organisation's. */
const READS_RULES = /usePersonFieldRules\(\)|rulesSentWith\(/;
const SHOWN_BY_RULE = /fieldRules\.(title|role|specialty)\.shown/;

describe("every door asks the organisation's rule", () => {
  it.each(Object.entries(DOORS))("%s", (file, call) => {
    expect(read(file)).toMatch(call);
  });

  it.each(FORMS)("the form %s reads the rules and checks with the one rule", (file) => {
    const source = read(file);
    expect(source).toMatch(READS_RULES);
    expect(source).toMatch(SHOWN_BY_RULE);
    // Hiding a field is half of it: the check must be the shared one too, or
    // the form demands what its route does not (or the reverse).
    expect(source).toMatch(/withPersonFieldRules\(|personFieldProblems\(/);
  });

  it.each(SHOWS_ONLY)("the form %s hides a field that is off", (file) => {
    const source = read(file);
    expect(source).toMatch(READS_RULES);
    expect(source).toMatch(SHOWN_BY_RULE);
  });

  it.each(PROFILE_GATES)("the profile gate %s judges by the rules sent with the profile", (file) => {
    expect(read(file)).toMatch(/rulesSentWith\(/);
  });

  it("the rules a submitter's browser judges by are the EVENT's", () => {
    expect(read("src/app/api/events/[eventId]/abstracts/my-profile/route.ts")).toMatch(/loadEventPersonFieldRules\(event\)/);
  });

  it.each(CREATE_DOORS)("the create door %s keeps only what its event asks", (file) => {
    expect(read(file)).toMatch(/askedOnly\(/);
  });

  it("only the two doors with no event ask the organisation alone", () => {
    // If this fails, a door that belongs to an event is reading the
    // organisation's rules and ignoring its event's own choice. Hand the event
    // to loadEventPersonFieldRules / checkEventPersonFields instead.
    const users = ["src", "worker"]
      .flatMap((root) => sourceFiles(join(ROOT, root)))
      .map((full) => relative(ROOT, full))
      .filter((file) => file !== "src/lib/person-field-rules.ts" && /loadOrganizationPersonFieldRules\(/.test(read(file)));
    expect(users.sort()).toEqual([...NO_EVENT_DOORS].sort());
  });

  it("nobody can ask whether a profile is complete without saying by whose rules", () => {
    // A default here is how the two gates above came to judge every
    // organisation by today's rules.
    expect(read("src/lib/submitter-profile-completeness.ts")).not.toMatch(/rules(?:\?)?:\s*PersonFieldRules\s*=/);
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

/**
 * A demand written by hand. Each of these shapes existed in the source before
 * step 2, or was one the first version of this list failed to match.
 */
const OWN_DEMANDS: Array<[string, RegExp]> = [
  // z.string().min(1), .trim().max(255).min(1), .nonempty(), and a route's own `required(255)` helper.
  ["a schema that demands Specialty", /specialty:\s*(?:z\.string\(\)[^,\n]*\.(?:min\(1|nonempty\()|required\()/],
  ["a schema that demands Role", /\brole:\s*(?:attendeeRoleEnum\s*[,}]|z\.string\(\)[^,\n]*\.(?:min\(1|nonempty\()|required\()/],
  // Both ways round: `!== "Others" ||` in a schema's refine, `=== "Others" && !` in a form's own check.
  ["its own Others rule", /specialty\s*!==\s*(?:"Others"|OTHER_ANSWER)\s*\|\||specialty\s*===\s*(?:"Others"|OTHER_ANSWER)\s*&&\s*!/],
  ["its own list of required fields", /\[\s*["']specialty["']\s*,\s*["']Specialty["']|,\s*["']Specialty["']\s*\]|if\s*\(\s*!\s*(?:\w+\.)?specialty\s*\)/],
  ["its own message", /["'`]Specialty is required["'`]|["'`]Role is required["'`]|["'`]Please specify your specialty["'`]/],
];

/**
 * Title cannot be matched everywhere: an abstract, a session and a dozen other
 * things have a title of their own. In the doors and forms above, though, a
 * `title` in a schema is the person's, and it is taken leniently
 * (`optionalTitle`) with the demand left to the rule.
 */
const OWN_TITLE_DEMAND = /\btitle:\s*(?:z\.string\(\)[^,\n]*\.(?:min\(1|nonempty\()|titleEnum\s*[,}]|required\()/;

/** Where the one rule is written. */
const THE_RULE = new Set(["src/lib/person-field-check.ts"]);

describe("every route that takes these fields is a door, or named as not one", () => {
  const routes = sourceFiles(join(ROOT, "src/app/api"))
    .map((full) => relative(ROOT, full))
    .filter((file) => file.endsWith("route.ts") && TAKES_THE_FIELDS.test(read(file)));

  it("finds the routes (the scan is not silently empty)", () => {
    expect(routes.length).toBeGreaterThan(10);
  });

  it("a new route that takes Title, Role or Specialty must be classified", () => {
    // If this fails you added (or changed) a route whose schema takes one of
    // these fields. If people outside the staff fill it in, it is a door: ask
    // personFieldRefusal with the event's organisation and add it to DOORS. If
    // it never demands them, add it to NOT_A_DOOR and say why.
    expect(routes.filter((file) => !(file in DOORS) && !(file in NOT_A_DOOR))).toEqual([]);
  });

  it("no entry names a route that is gone, or one that no longer takes the fields", () => {
    const stale = [...Object.keys(DOORS), ...Object.keys(NOT_A_DOOR)].filter((file) => {
      // The four profile-gate doors read a stored record; they take no field in a schema.
      if (/missingProfileFields/.test(String(DOORS[file] ?? ""))) return false;
      return !routes.includes(file);
    });
    expect(stale).toEqual([]);
  });

  it("no route is listed both ways", () => {
    expect(Object.keys(DOORS).filter((file) => file in NOT_A_DOOR)).toEqual([]);
  });
});

describe("no file demands Title, Role or Specialty by itself", () => {
  const files = ["src", "worker"].flatMap((root) => sourceFiles(join(ROOT, root))).map((full) => relative(ROOT, full));

  // Not the four profile-gate doors: the `title` in their schemas is the
  // abstract's or the proposal's own, which is rightly demanded.
  const takesAPerson = Object.keys(DOORS).filter((file) => !/missingProfileFields/.test(String(DOORS[file])));

  it.each([...takesAPerson, ...FORMS])("%s takes the person's title leniently", (file) => {
    expect(read(file)).not.toMatch(OWN_TITLE_DEMAND);
  });

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
