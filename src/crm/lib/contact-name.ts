/**
 * Clean a contact's first + last name as they arrive from a Freshsales export.
 *
 * Freshsales auto-creates contacts from synced email, and builds the name by
 * splitting the sender's display name on a space. An Outlook display name such
 * as `Al Qaidhi, Khuwailid` therefore lands as first `Al Qaidhi,` and last
 * `Khuwailid`. The first import (Aug to Oct 2026, 3,334 rows) stored 117 such
 * "Last, First" names verbatim, about 90 carrying corporate tags like
 * `[JNJAE NON-J&J]`, `(AKI)` or `/IN/EXT`, and 377 whose name was an email.
 *
 * Only the DETERMINISTIC repairs happen here. Casing and titles ("Dr.") are left
 * alone on purpose (owner, Oct 27 2026): Title Case breaks `McDonald`, `bin` and
 * short codes. Rows that cannot be repaired are TAGGED, never guessed at:
 *   - `needs-name`   the name is an email address (an auto-created sender)
 *   - `not-a-person` the name looks like a company, event or system sender.
 *     Such a row is left exactly as it came (only de-quoted): the "Last, First"
 *     flip turns `Stephanie Butler, Fierce Pharma` into nonsense.
 *
 * Pure: no I/O, safe on client and server.
 */

export const NEEDS_NAME_TAG = "needs-name";
export const NOT_A_PERSON_TAG = "not-a-person";

export interface CleanedContactName {
  firstName: string;
  lastName: string;
  /** Quality tags to ADD to the contact. Never replaces the row's own tags. */
  qualityTags: string[];
}

// Straight and curly double quotes. Apostrophes stay (O'Brien, D'Souza).
const QUOTES_RE = /["“”„]/g;
// `[JNJAE NON-J&J]`, `(AKI)`, `(C)` anywhere. A bracket holding non-Latin script
// is the person's own name (`Zhang (张伟)`) and stays.
const BRACKET_TAG_RE = /\s*(\[[^\]]*\]|\([^)]*\))/g;
const NON_LATIN_RE = /[^\u0000-\u024F]/;
// Outlook's `/IN/EXT`, `/AE`, `/EXT` only as a separate token after a space, so
// an all-caps slashed name (`AL/SALEH`) is not cut.
const OUTLOOK_TAG_RE = /(^|\s)\/(?:[A-Z]{2}|EXT)(?:\/EXT)?(?=\s|$)/g;
// Everything after a SPACED dash: `Mejri, Yazid - SSRH`, `Mohammed Faisal - SLS`.
// A hyphenated surname (`El-sayed`) has no spaces, so it never matches.
const DASH_TAIL_RE = /\s+[-–](\s.*)?$/;
// Trailing credentials, stacked or dotted: `Ali, MD, PhD`, `Ali, M.D.`. They
// are not "Last, First". Case-sensitive so `Rahman, Md` (a common given-name
// abbreviation) is not eaten.
const CREDENTIAL_RE = /,\s*(MD|M\.D|PhD|Ph\.D|MBBS|MBChB|FRCP|FRCS|FACC|FACP|MPH|MSc|MBA|PharmD|DDS|DMD)\.?$/;
// A generational suffix after a comma is not a first name: `Smith, Jr.`.
const SUFFIX_RE = /^(jr|sr|ii|iii|iv|v)\.?$/i;
// "Acme, Inc" is a company with a comma, not "Last, First".
const COMPANY_SUFFIX_RE = /^(inc|llc|ltd|limited|fze|fzc|fzco|fz-llc|plc|gmbh|co|corp|sa|ag|bv)\.?$/i;

const NOT_A_PERSON_WORDS = new Set([
  "team", "department", "dept", "accountancy", "accounting", "awards", "week", "expo",
  "consulting", "travel", "tourism", "group", "services", "solutions", "support",
  // NOT "sales", "batch", "mailer": real surnames (Norman Mailer). A wrong tag
  // marks a real person, so a word that is also a surname stays off the list.
  "marketing", "newsletter", "noreply", "no-reply",
  "hospital", "clinic", "pharma", "llc", "ltd", "fze", "inc", "office",
  "events", "event", "finance", "society", "news", "center", "centre", "approval",
  "hours", "verification", "labs", "network", "association", "organization",
  "organisation", "systems", "sector", "congress", "summit", "conference", "media",
  "foundation", "institute", "university", "academy", "council", "ministry",
  "authority", "exhibitors", "training", "doctors",
]);

// Backslashes too: some exports escape the brackets (`RBS \\(IIS\\)`).
const tidy = (s: string) => s.replace(QUOTES_RE, "").replace(/\\/g, "").replace(/\s+/g, " ").trim();
function stripCredentials(s: string): string {
  let out = s;
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(CREDENTIAL_RE, "").trim();
  }
  return out;
}
const stripTags = (s: string) =>
  stripCredentials(
    tidy(
      tidy(s)
        .replace(BRACKET_TAG_RE, (m) => (NON_LATIN_RE.test(m) ? m : ""))
        .replace(OUTLOOK_TAG_RE, "$1")
        .replace(DASH_TAIL_RE, ""),
    ),
  );

/**
 * `original` is the de-quoted name, `stripped` the same with tags and dash tails
 * removed. The word list reads `stripped`, so a person's affiliation tail
 * (`Salman Shalwani - Network`, `Doaa Radwan (Tasc Labour Services)`) does not
 * make them a company, while `Society of Engineers - UAE` still is one.
 */
function looksLikeNotAPerson(original: string, stripped: string): boolean {
  if (/[\d_]/.test(original)) return true; // "VITASHOW 2026", "MSG_1266956107", "WHO_EPI-WIN"
  if (/\b[a-z0-9-]+\.(com|net|org|io|co|ae|us|uk|biz|info)\b/i.test(original)) return true; // "Teamwork.com"
  return stripped
    .toLowerCase()
    .split(/[\s&,/]+/)
    .some((w) => NOT_A_PERSON_WORDS.has(w));
}

/** Split `full` at the original boundary when it survived, else at the last space. */
function resplit(full: string, preferredFirst: string): [string, string] | null {
  if (preferredFirst && full.startsWith(`${preferredFirst} `)) {
    return [preferredFirst, full.slice(preferredFirst.length + 1)];
  }
  const i = full.lastIndexOf(" ");
  if (i <= 0) return null;
  return [full.slice(0, i), full.slice(i + 1)];
}

/** "Al Qaidhi, Khuwailid" → ["Khuwailid", "Al Qaidhi"]; null when not that shape. */
function flipLastCommaFirst(full: string): [string, string] | null {
  const m = /^([^,]+),\s*([^,]+)$/.exec(full);
  if (!m) return null;
  const last = m[1]!.trim();
  const first = m[2]!.trim();
  // A one-letter "surname" (`W, Muscat Oman WD`) is not this shape either.
  if (last.length < 2 || !first || COMPANY_SUFFIX_RE.test(first) || SUFFIX_RE.test(first)) return null;
  return [first, last];
}

export function cleanContactName(rawFirst: string, rawLast: string): CleanedContactName {
  const first = tidy(rawFirst);
  const last = tidy(rawLast);

  // An auto-created sender: nothing to repair, a person has to name them.
  if (first.includes("@") || last.includes("@")) {
    return { firstName: first, lastName: last, qualityTags: [NEEDS_NAME_TAG] };
  }

  const full = stripTags(`${first} ${last}`);
  // Not a person: tag it and leave it alone (see the header).
  if (looksLikeNotAPerson(`${first} ${last}`, full)) {
    return { firstName: first, lastName: last, qualityTags: [NOT_A_PERSON_TAG] };
  }

  // Nothing usable survived the repairs (e.g. one bare word): keep the
  // de-quoted originals rather than inventing a split.
  const [firstName, lastName] = flipLastCommaFirst(full) ?? resplit(full, stripTags(first)) ?? [first, last];
  return { firstName, lastName, qualityTags: [] };
}
