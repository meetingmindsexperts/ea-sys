/**
 * Default certificate templates per cert type + token-merge helper.
 *
 * After the 2026-06-01 CEO/MD review of MASH IN FOCUS + EIGHC 2025 real
 * certs, the cert design moved from "fixed in-code visual" to
 * "organizer-controlled template + assets." This file owns:
 *   - The fallback template per CertificateType (used when an event hasn't
 *     uploaded its own banner / signature / footer assets yet).
 *   - The token-merge function that substitutes `{{recipientName}}` etc.
 *     in the body template at render time.
 *
 * Tokens supported in `bodyTemplate`:
 *   {{recipientName}}             "Dr. Sample Attendee"
 *   {{eventName}}                 "Emirates International Gastroenterology…"
 *   {{eventSubtitle}}             "" (currently no subtitle field on Event)
 *   {{eventDateRange}}            "5th - 7th December 2025"
 *   {{venueLine}}                 "at Conrad Dubai, United Arab Emirates"
 *   {{accreditationBody}}         "Dubai Health Authority (DHA)"
 *   {{accreditationReference}}    "DHA/MTS/ACC/25-2971/A"
 *   {{cmeHours}}                  "10.5"
 *
 * Unknown tokens render as empty string + emit a structured warn log so
 * a typo doesn't print `{{cmeHourz}}` literally on a real cert.
 */

import { apiLogger } from "@/lib/logger";
import type {
  CertificateType,
  CertificateTemplate,
  CertificateData,
} from "./types";

/**
 * Default template per cert type. Used when an event hasn't configured a
 * template yet — gives the preview something usable to show. Real events
 * override these via `Event.settings.certificateTemplate`.
 *
 * The MASH IN FOCUS and EIGHC references both used:
 *   - Single "We hereby confirm / [name] / has attended / [event] / ..." body
 *   - Title in italic script ("Certificate of Attendance")
 *   - Navy or pink title color
 *
 * Defaults mirror that structure exactly so the out-of-box cert reads
 * like the references.
 */
/**
 * v3 default — empty template. Organizers must upload a background PDF
 * and configure text boxes; we don't compose anything ourselves. The
 * placeholder PDF returned by renderCertificate() when backgroundPdfUrl
 * is null is what the operator sees until they configure the slot.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function defaultTemplateForType(_type: CertificateType): CertificateTemplate {
  // v3 default is empty for every cert type — organizers must upload
  // their own background PDF. The signature still takes `type` so the
  // call sites + tests stay stable; a future per-type default (e.g. a
  // canned CME layout) can read the argument then.
  return {
    backgroundPdfUrl: null,
    textBoxes: [],
  };
}

// (v2 default bodies removed in 2026-06-02 hard cut-over to PDF-overlay
// model — organizers upload their own PDFs now. Token list unchanged
// below; mergeBody still operates on text-box content strings.)

// ── Token merge ───────────────────────────────────────────────────────────────

/**
 * Resolve `{{token}}` placeholders in a body template. Returns the merged
 * text with every recognized token replaced + every unknown token replaced
 * with an empty string (and a warn log so we catch typos in /logs rather
 * than on a printed cert).
 *
 * Why we don't throw on unknown tokens: a typo in the template should
 * degrade gracefully (empty string in place) rather than fail the cert
 * issue path. The audit log on every issued cert + the renderer warn
 * give us the trail to fix the typo.
 */
export function mergeBody(template: string, data: CertificateData): string {
  const tokens = resolveTokens(data);
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (key in tokens) return tokens[key];
    apiLogger.warn({
      msg: "cert-template:unknown-token",
      token: key,
      certType: data.type,
      eventName: data.event.name,
      hint: "Token typo in body template — renders as empty. Allowed tokens: " +
        Object.keys(tokens).join(", "),
    });
    return "";
  });
}

function resolveTokens(data: CertificateData): Record<string, string> {
  const { recipient, event, template } = data;
  const venueLine = composeVenueLine(event);
  const accreditationBody =
    event.accreditations?.[0]?.body
      ? friendlyAccreditorName(event.accreditations[0].body)
      : "";
  const accreditationReference = event.accreditations?.[0]?.reference ?? "";
  // Per-template CME hours (organizer-entered) override the event-level value.
  const cmeHoursStr = formatHoursForToken(template?.cmeHours ?? event.cmeHours);

  return {
    recipientName: recipient.fullName,
    eventName: event.name,
    // No `Event.subtitle` column yet — leave empty unless the user wants
    // it as a future schema addition.
    eventSubtitle: "",
    eventDateRange: formatDateRange(event.startDate, event.endDate),
    venueLine,
    accreditationBody,
    accreditationReference,
    cmeHours: cmeHoursStr,
    // Role/designation for this cert (e.g. "Speaker", "Moderator"). Empty when
    // the template has no role set.
    role: template?.role ?? "",
  };
}

function composeVenueLine(e: CertificateData["event"]): string {
  const parts: string[] = [];
  if (e.venue) parts.push(e.venue);
  if (e.city) parts.push(e.city);
  if (e.country) parts.push(e.country);
  return parts.length > 0 ? `at ${parts.join(", ")}` : "";
}

function friendlyAccreditorName(
  body: "DHA" | "DOH" | "SCFHS" | "EACCME" | "ACCME" | "OTHER",
): string {
  switch (body) {
    case "DHA":
      return "Dubai Health Authority (DHA)";
    case "DOH":
      return "Department of Health Abu Dhabi (DOH)";
    case "SCFHS":
      return "Saudi Commission for Health Specialties (SCFHS)";
    case "EACCME":
      return "EACCME";
    case "ACCME":
      return "ACCME";
    case "OTHER":
      return "The Accrediting Body";
  }
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function formatDate(d: Date): string {
  return `${ordinal(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function ordinal(n: number): string {
  if (n >= 11 && n <= 13) return `${n}th`;
  const last = n % 10;
  if (last === 1) return `${n}st`;
  if (last === 2) return `${n}nd`;
  if (last === 3) return `${n}rd`;
  return `${n}th`;
}

function formatDateRange(start: Date, end: Date): string {
  if (start.toDateString() === end.toDateString()) return formatDate(start);
  const sameMonth =
    start.getUTCFullYear() === end.getUTCFullYear() &&
    start.getUTCMonth() === end.getUTCMonth();
  if (sameMonth) {
    return `${ordinal(start.getUTCDate())} - ${ordinal(end.getUTCDate())} ${MONTHS[end.getUTCMonth()]} ${end.getUTCFullYear()}`;
  }
  return `${formatDate(start)} - ${formatDate(end)}`;
}

function formatHoursForToken(h: number | null | undefined): string {
  if (h == null) return "";
  const rounded = Math.round(h * 10) / 10;
  return rounded % 1 === 0 ? String(Math.round(rounded)) : rounded.toFixed(1);
}

/**
 * Merge the org-defined template over the cert-type default. v3 has
 * only two organizer-controlled fields (backgroundPdfUrl + textBoxes),
 * so the merge is trivial — only the two v3 paths plus the approval
 * timestamps. Legacy v2 fields are intentionally ignored here per the
 * 2026-06-02 hard cut-over (organizers re-upload as PDF, old data is
 * inert until they reconfigure).
 */
export function effectiveTemplate(
  type: CertificateType,
  template: Partial<CertificateTemplate> | undefined,
): CertificateTemplate {
  const def = defaultTemplateForType(type);
  if (!template) return def;
  return {
    backgroundPdfUrl: template.backgroundPdfUrl ?? def.backgroundPdfUrl ?? null,
    textBoxes: template.textBoxes ?? def.textBoxes ?? [],
    designApprovedBy: template.designApprovedBy,
    designApprovedAt: template.designApprovedAt,
  };
}
