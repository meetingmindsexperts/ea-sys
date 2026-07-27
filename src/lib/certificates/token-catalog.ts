/**
 * The catalog of `{{tokens}}` a certificate TEXT BOX may contain.
 *
 * WHY A CATALOG EXISTS
 * --------------------
 * The token list lived in two hand-maintained places that had already
 * drifted: `resolveTokens()` in template.ts (the 9 tokens that actually
 * resolve) and `AVAILABLE_TOKENS` in the canvas editor (7 tokens shown to
 * the organizer). `{{role}}` shipped in June 2026 and never reached the
 * editor's list — so the one token an appreciation certificate most wants
 * was undiscoverable, and `{{eventSubtitle}}` was resolvable but unlisted.
 *
 * Drift here is not cosmetic. A token that resolves but isn't listed is a
 * capability nobody can find; a token that's listed but doesn't resolve
 * prints nothing on a real certificate and logs a warn per render. So this
 * file is the single list, and `certificate-tokens.test.ts` asserts that
 * `Object.keys(resolveTokens(...))` equals these keys exactly — a new token
 * added to one side fails the suite instead of shipping half-wired.
 *
 * CLIENT-SAFE BY CONTRACT: imported by the canvas editor, which is a
 * `"use client"` component. Nothing here may import `@/lib/logger` (pino,
 * Node-only), `@/lib/db`, or anything that reaches them — Next.js bundles a
 * Node module into the client as `undefined` silently, so the failure mode is
 * a dead editor with no error. Keep this file to plain data.
 */

export interface CertificateTokenSpec {
  /** Bare key — no braces. */
  key: string;
  /** Shown in the editor's token list. */
  description: string;
  /** Illustrative rendered value, shown in the editor so the organizer can
   *  judge line length before they position the box. */
  sample: string;
}

/**
 * Every token the renderer resolves, in the order the editor lists them
 * (roughly the order they appear down a certificate).
 */
export const CERTIFICATE_TOKENS: readonly CertificateTokenSpec[] = [
  {
    key: "recipientName",
    description: "Full attendee/speaker name, with title prefix",
    sample: "Dr. Sample Attendee",
  },
  {
    key: "organizationName",
    description: "The issuing organisation's name",
    sample: "Meeting Minds Experts",
  },
  {
    key: "eventName",
    description: "Event name",
    sample: "OSH Monthly Meeting 2026",
  },
  {
    key: "eventSubtitle",
    description: "Event subtitle — always empty today (no subtitle field on an event yet)",
    sample: "",
  },
  {
    key: "eventDateRange",
    description: "Event date range",
    sample: "17th June 2026",
  },
  {
    key: "venueLine",
    description: "Venue + city + country, prefixed with 'at'. Empty when the event has no venue.",
    sample: "at Conrad Dubai, United Arab Emirates",
  },
  {
    key: "role",
    description:
      "This template's role/designation. Set it on the template (Speaker, Moderator, Organiser…) — duplicating a template and changing the role re-words every box that uses this token.",
    sample: "Speaker",
  },
  {
    key: "abstractTitle",
    description: "Recipient's accepted abstract/presentation title (Appreciation certificates only)",
    sample: "Optimizing HDMTX Outcomes: DME & Toxicity Management",
  },
  {
    key: "sessionTitles",
    description: "Sessions the recipient presented in, comma-separated (Appreciation only)",
    sample: "Advances in Skull Base Surgery",
  },
  {
    key: "accreditationName",
    description:
      "Accreditor's name. Uses the free-text name from CME settings when set, otherwise the accrediting body's standard name.",
    sample: "Oman Medical Specialty Board (OMSB)",
  },
  {
    key: "accreditationBody",
    description: "Accrediting body's standard name, from the picked body (DHA, EACCME…)",
    sample: "Dubai Health Authority (DHA)",
  },
  {
    key: "accreditationReference",
    description: "Accreditor's reference number",
    sample: "OMSB/CPD/C1/6529/2026",
  },
  {
    key: "cmeHours",
    description: "CME/CPD hours — the template's own hours when set, else the event's",
    sample: "1.5",
  },
  {
    key: "certificateSerial",
    description: "This certificate's unique serial. Previews show a PREVIEW-DRAFT placeholder.",
    sample: "OSHMM-ATT-0042",
  },
  {
    key: "issuedDate",
    description: "Date the certificate was issued",
    sample: "17th June 2026",
  },
] as const;

/** Bare keys, for validation + the drift test. */
export const CERTIFICATE_TOKEN_KEYS: readonly string[] = CERTIFICATE_TOKENS.map((t) => t.key);

const TOKEN_KEY_SET = new Set(CERTIFICATE_TOKEN_KEYS);

/** True when `key` (bare, no braces) is a token the renderer resolves. */
export function isCertificateToken(key: string): boolean {
  return TOKEN_KEY_SET.has(key);
}

/**
 * Extract the bare token keys referenced by a text-box content string.
 * Mirrors the renderer's `\{\{(\w+)\}\}` pattern so callers can't disagree
 * with it about what counts as a token.
 */
export function tokensReferencedIn(content: string): string[] {
  return Array.from(content.matchAll(/\{\{(\w+)\}\}/g), (m) => m[1]);
}

/**
 * Any token in `content` that the renderer will NOT resolve. A non-empty
 * result means the box would render that token as an empty string and log a
 * warn on every certificate — used to keep the built-in starter templates
 * honest (see starter-template.ts + its test).
 */
export function unknownTokensIn(content: string): string[] {
  return tokensReferencedIn(content).filter((k) => !TOKEN_KEY_SET.has(k));
}
