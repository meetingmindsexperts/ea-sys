/**
 * Do-not-import screen for inbound contact data.
 *
 * Written after the `contacts_centralv1` import carried two spam rows into the
 * contact store: one whose `firstName` was literally
 * `Dont click me: https://racetrack.top/go/…` on a `chitthi.in` disposable
 * mailbox, and one advertising an adult site. Both were faithfully copied,
 * because the importer only checked that a name was non-empty.
 *
 * Why a name matters more than it looks: `firstName` is merged into email
 * greetings and printed onto badges. A spam URL sitting in that field means a
 * bulk send would carry an attacker's link inside a legitimate MMG email, with
 * our sender reputation behind it. The name field is an output surface, not
 * just a label, so it needs the same suspicion as any other untrusted input.
 *
 * Deliberately conservative. It blocks rows whose NAME is broken, not rows
 * whose EMAIL happens to be a shared inbox: `info@some-clinic.com` with a real
 * person's name on it is a legitimate contact reachable at a shared mailbox,
 * and dropping those would lose real people. `postmaster@bayer.com` recorded
 * with the surname `postmaster@bayer.com` is not a person by any reading.
 *
 * Pure and dependency-free so the public registration form can adopt the same
 * screen later — that door is where this spam originally walked in.
 */

/** Reasons a row is refused. Stable strings: they are reported and counted. */
export type BlockReason =
  | "BLOCKED_EMAIL"
  | "DISPOSABLE_DOMAIN"
  | "URL_IN_TEXT"
  | "NAME_IS_EMAIL";

export interface ScreenInput {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  organization?: string | null;
  jobTitle?: string | null;
}

export type ScreenResult = { blocked: false } | { blocked: true; reason: BlockReason; detail: string };

/**
 * Addresses refused outright. Add here when a specific row is identified as
 * spam, so a re-import cannot resurrect it. Lowercase only — the screen
 * lowercases before comparing.
 */
export const BLOCKED_EMAILS: ReadonlySet<string> = new Set([
  // Spam carried in by the 2026-08-18 contacts_centralv1 import.
  "yhfee@chitthi.in", // firstName was a racetrack.top redirector URL
  "s0910367764@gmail.com", // adult-site link in the name, org "Swingers web club"
]);

/**
 * Disposable / throwaway mailbox providers. Nobody registers for a medical
 * conference from one of these and expects to hear back, so a hit is spam or a
 * throwaway test, never a delegate we want to email.
 */
export const DISPOSABLE_EMAIL_DOMAINS: readonly string[] = [
  "chitthi.in",
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.info",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "yopmail.com",
  "sharklasers.com",
  "trashmail.com",
  "dispostable.com",
  "getnada.com",
  "maildrop.cc",
  "throwawaymail.com",
  "fakeinbox.com",
];

/**
 * URL detection, split by field because the two field families have opposite
 * failure modes. Both rules below are calibrated against the real contact book,
 * not guessed.
 *
 * NAME fields (firstName / lastName) — strict. A person's name never contains a
 * domain, so anything domain-shaped is advertising. But it must be matched by a
 * KNOWN TLD, not by a generic `word.word`: 78 real contacts carry a dot-joined
 * token, and they are overwhelmingly this audience's ordinary name forms —
 * `Dr.Omar`, `Prof.DR Abdelraouf`, `Mr.Yasser` (title typed with no space),
 * `Al.Rayes` / `Al.jehani` / `Al.Thobaiti` (Arabic prefix), `Ma.Theresa` /
 * `Ma.Victoria` (Filipino Maria), `Most.Gulshan Ara` (Bangladeshi honorific).
 * A generic rule deletes all 78. The TLD list is a treadmill, and it is still
 * the right trade here: a missed spam row is noise, a deleted physician is not.
 *
 * ORGANIZATION / JOB TITLE — lenient. Requires a scheme or `www.`. A company
 * name that ends in its own domain is ordinary CRM data, and the earlier
 * bare-TLD rule deleted two real people for it (a lab worker at "Al borg
 * medical laboratories.com" and a pharmacist at "blue coast medical.com"), and
 * would equally have deleted anyone employed at "Roche.com" or "Sanofi.com".
 * These fields are also not merged into email greetings, so they do not carry
 * the risk that justifies the strict rule above.
 */
const ABUSE_TLDS = [
  // generic
  "com", "net", "org", "info", "biz",
  // abuse-heavy / cheap registration
  "top", "xyz", "click", "link", "shop", "site", "online", "club", "live",
  "win", "store", "app", "pro", "vip", "cc", "ru", "tk", "ml", "ga", "cf", "gq",
].join("|");

/** A domain-shaped token in a NAME, e.g. `racetrack.top`, `spam.club`. */
const NAME_DOMAIN_RE = new RegExp(String.raw`\b[a-z0-9-]{2,}\.(?:${ABUSE_TLDS})\b`, "i");

/**
 * Link shorteners, matched as whole hosts. Their TLDs (`ly`, `me`, `gl`, `gd`,
 * `gy`) are country domains that would collide with real words if listed above.
 */
const SHORTENER_RE =
  /\b(?:bit\.ly|t\.me|wa\.me|tinyurl\.(?:com|co)|goo\.gl|ow\.ly|buff\.ly|is\.gd|cutt\.ly|rb\.gy|shorturl\.at|lnkd\.in|t\.co)\b/i;

const SCHEME_OR_WWW_RE = /(?:https?:\/\/|\bwww\.)/i;

/** A URL in a field that should hold a person's NAME. */
const nameHasUrl = (v: string) =>
  SCHEME_OR_WWW_RE.test(v) || SHORTENER_RE.test(v) || NAME_DOMAIN_RE.test(v);

/** A URL in an employer or job title. Deliberately weaker — see above. */
const textHasUrl = (v: string) => SCHEME_OR_WWW_RE.test(v) || SHORTENER_RE.test(v);

/** An address anywhere in a field that should hold a person's name. */
const CONTAINS_AT_RE = /@/;

const norm = (v: string | null | undefined) => (v ?? "").trim();

export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).trim().toLowerCase();
}

/**
 * Decide whether an inbound contact row may be imported.
 *
 * Order matters only for which reason gets reported; a row failing several
 * checks is refused once, with the most specific reason first.
 */
export function screenContact(input: ScreenInput): ScreenResult {
  const email = norm(input.email).toLowerCase();

  if (BLOCKED_EMAILS.has(email)) {
    return { blocked: true, reason: "BLOCKED_EMAIL", detail: email };
  }

  const domain = emailDomain(email);
  // Suffix match, dot-anchored, so `notchitthi.in` and `chitthi.in.evil.com`
  // do not count as hits — the same trap as any allow/deny list built on
  // `includes()`.
  const disposable = DISPOSABLE_EMAIL_DOMAINS.find(
    (d) => domain === d || domain.endsWith(`.${d}`),
  );
  if (disposable) {
    return { blocked: true, reason: "DISPOSABLE_DOMAIN", detail: disposable };
  }

  // A name that is an email address is not a name. These arrive from harvested
  // bounce and role mailboxes (`postmaster@…`, `payables@…`) recorded with
  // firstName "NA", and they are not people.
  for (const [field, value] of [
    ["firstName", norm(input.firstName)],
    ["lastName", norm(input.lastName)],
  ] as const) {
    if (value && CONTAINS_AT_RE.test(value)) {
      return { blocked: true, reason: "NAME_IS_EMAIL", detail: `${field}=${value.slice(0, 80)}` };
    }
  }

  // A URL in a NAME is advertising, not identity. Strict rule.
  for (const [field, value] of [
    ["firstName", norm(input.firstName)],
    ["lastName", norm(input.lastName)],
  ] as const) {
    if (value && nameHasUrl(value)) {
      return { blocked: true, reason: "URL_IN_TEXT", detail: `${field}=${value.slice(0, 80)}` };
    }
  }

  // Employer / job title: only an explicit link counts. A company name ending
  // in its own domain is ordinary data, not spam.
  for (const [field, value] of [
    ["organization", norm(input.organization)],
    ["jobTitle", norm(input.jobTitle)],
  ] as const) {
    if (value && textHasUrl(value)) {
      return { blocked: true, reason: "URL_IN_TEXT", detail: `${field}=${value.slice(0, 80)}` };
    }
  }

  return { blocked: false };
}
