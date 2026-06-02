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
export function defaultTemplateForType(type: CertificateType): CertificateTemplate {
  switch (type) {
    case "ATTENDANCE":
      return {
        titleText: "Certificate of Attendance",
        titleColor: "#1a2e5a",
        bodyTemplate: defaultBodyAttendance(),
        signatures: [],
        footerLogos: [],
      };
    case "PRESENTER":
      return {
        titleText: "Certificate of Appreciation",
        titleColor: "#1a2e5a",
        bodyTemplate: defaultBodyPresenter(),
        signatures: [],
        footerLogos: [],
      };
    case "POSTER":
      return {
        titleText: "Certificate of Appreciation",
        titleColor: "#1a2e5a",
        bodyTemplate: defaultBodyPoster(),
        signatures: [],
        footerLogos: [],
      };
    case "CME":
      return {
        titleText: "Certificate of CME",
        titleColor: "#1a2e5a",
        bodyTemplate: defaultBodyCme(),
        signatures: [],
        footerLogos: [],
      };
  }
  // Unreachable for current CertificateType enum; throws on enum drift
  // so the renderer never returns undefined silently.
  throw new Error(`Unhandled certificate type: ${String(type)}`);
}

// Default body HTML per type. Bodies are HTML now (Tiptap editor output)
// to support inline formatting (bold event name, italic subtitles).
// Tokens like `{{recipientName}}` survive HTML wrapping — the renderer's
// merge pass runs on the text inside each run, not the HTML structure.
//
// Heading levels drive the renderer's size hierarchy:
//   <h2> = largest emphasis (recipient name)
//   <h3> = medium emphasis (event name)
//   <p>  = body text
// Organizers override these via Tiptap toolbar (B / I / H1 / H2 / H3).

function defaultBodyAttendance(): string {
  return [
    "<p>We hereby confirm</p>",
    "<h2>{{recipientName}}</h2>",
    "<p>has attended</p>",
    "<h3><strong>{{eventName}}</strong></h3>",
    "<p>held on {{eventDateRange}}</p>",
    "<p>{{venueLine}}</p>",
  ].join("");
}

function defaultBodyPresenter(): string {
  return [
    "<p>is hereby presented to</p>",
    "<h2>{{recipientName}}</h2>",
    "<p>for outstanding contribution as faculty to</p>",
    "<h3><strong>{{eventName}}</strong></h3>",
    "<p>held on {{eventDateRange}}</p>",
    "<p>{{venueLine}}</p>",
  ].join("");
}

function defaultBodyPoster(): string {
  return [
    "<p>is hereby presented to</p>",
    "<h2>{{recipientName}}</h2>",
    "<p>for the poster presentation at</p>",
    "<h3><strong>{{eventName}}</strong></h3>",
    "<p>held on {{eventDateRange}}</p>",
    "<p>{{venueLine}}</p>",
  ].join("");
}

function defaultBodyCme(): string {
  return [
    "<p>We hereby confirm</p>",
    "<h2>{{recipientName}}</h2>",
    "<p>has attended</p>",
    "<h3><strong>{{eventName}}</strong></h3>",
    "<p>held on {{eventDateRange}}</p>",
    "<p>{{venueLine}}</p>",
    "<p>Accredited by {{accreditationBody}}</p>",
    "<p>Accreditation #: {{accreditationReference}}</p>",
    "<p><strong>Total Hour/s Awarded: {{cmeHours}}</strong></p>",
  ].join("");
}

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
  const { recipient, event } = data;
  const venueLine = composeVenueLine(event);
  const accreditationBody =
    event.accreditations?.[0]?.body
      ? friendlyAccreditorName(event.accreditations[0].body)
      : "";
  const accreditationReference = event.accreditations?.[0]?.reference ?? "";
  const cmeHoursStr = formatHoursForToken(event.cmeHours);

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
 * Merge the org-defined template over the cert-type default — every
 * field the organizer set takes precedence; unset fields fall back to
 * the type default. Keeps the renderer free of "did the organizer set
 * this?" branching since `effective.titleText` is always populated.
 */
export function effectiveTemplate(
  type: CertificateType,
  template: Partial<CertificateTemplate> | undefined,
): CertificateTemplate {
  const def = defaultTemplateForType(type);
  if (!template) return def;
  return {
    headerImage: template.headerImage ?? def.headerImage ?? null,
    titleText: template.titleText || def.titleText,
    titleColor: template.titleColor || def.titleColor,
    bodyTemplate: template.bodyTemplate || def.bodyTemplate,
    signatures: template.signatures ?? def.signatures ?? [],
    footerLogos: template.footerLogos ?? def.footerLogos ?? [],
    footerText: template.footerText ?? def.footerText,
    designApprovedBy: template.designApprovedBy,
    designApprovedAt: template.designApprovedAt,
  };
}
