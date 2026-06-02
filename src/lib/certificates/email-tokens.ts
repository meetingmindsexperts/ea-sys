/**
 * Cover-email token spec + system defaults for cert delivery (2026-06-02
 * evening). Client-safe — no DB / logger imports — so the certificates
 * dashboard page can import the constants without dragging the server-
 * only logger into the client bundle.
 *
 * The actual token resolver (per-recipient substitution + abstract-title
 * DB lookup + warn-log-on-unknown) lives in `email-tokens-resolver.ts`,
 * which the issue worker imports server-side.
 *
 * Tokens supported in the cover email body:
 *   {{recipientName}}      "Dr. Sample Attendee"
 *   {{eventName}}          event.name
 *   {{eventDateRange}}     "5th - 7th December 2025"
 *   {{venueLine}}          "at Conrad Dubai, UAE"
 *   {{organizationName}}   org.name
 *   {{certificateType}}    "Certificate of Attendance" / "Certificate of Appreciation"
 *   {{certificateSerial}}  e.g. EIGHC-2026-CERT-A-042
 *   {{abstractTitle}}      speaker's accepted abstract title (APPRECIATION only)
 */

import type { CertificateType } from "@prisma/client";

// ── System default subject + body ────────────────────────────────────────────

export const SYSTEM_DEFAULT_SUBJECT = "Your {{certificateType}} — {{eventName}}";

export const SYSTEM_DEFAULT_BODY_ATTENDANCE = `<p>Dear {{recipientName}},</p>
<p>We are pleased to share your {{certificateType}} for {{eventName}} ({{eventDateRange}}), attached as a PDF.</p>
<p>Certificate serial: {{certificateSerial}}</p>
<p>Thank you for attending.</p>
<p>Best regards,<br/>{{organizationName}}</p>`;

export const SYSTEM_DEFAULT_BODY_APPRECIATION = `<p>Dear {{recipientName}},</p>
<p>Thank you for your contribution to {{eventName}} ({{eventDateRange}}). Please find your {{certificateType}} attached.</p>
<p>{{abstractTitle}}</p>
<p>Certificate serial: {{certificateSerial}}</p>
<p>Best regards,<br/>{{organizationName}}</p>`;

export function defaultBodyForCategory(category: CertificateType): string {
  return category === "APPRECIATION"
    ? SYSTEM_DEFAULT_BODY_APPRECIATION
    : SYSTEM_DEFAULT_BODY_ATTENDANCE;
}

/** Token reference for the UI dropdown. Category filter hides
 *  {{abstractTitle}} on ATTENDANCE templates so operators don't insert
 *  a token that always resolves empty. */
export interface EmailTokenSpec {
  token: string;
  description: string;
  categories: CertificateType[];
}

export const COVER_EMAIL_TOKENS: EmailTokenSpec[] = [
  { token: "{{recipientName}}", description: "Full attendee/speaker name (with title prefix)", categories: ["ATTENDANCE", "APPRECIATION"] },
  { token: "{{eventName}}", description: "Event name", categories: ["ATTENDANCE", "APPRECIATION"] },
  { token: "{{eventDateRange}}", description: "Event date range (e.g. 5th - 7th December 2025)", categories: ["ATTENDANCE", "APPRECIATION"] },
  { token: "{{venueLine}}", description: "Venue + city + country, prefixed with 'at'", categories: ["ATTENDANCE", "APPRECIATION"] },
  { token: "{{organizationName}}", description: "Your organization name", categories: ["ATTENDANCE", "APPRECIATION"] },
  { token: "{{certificateType}}", description: "'Certificate of Attendance' or 'Certificate of Appreciation'", categories: ["ATTENDANCE", "APPRECIATION"] },
  { token: "{{certificateSerial}}", description: "The cert's unique serial number", categories: ["ATTENDANCE", "APPRECIATION"] },
  { token: "{{abstractTitle}}", description: "Abstract / paper title (the speaker's accepted abstract, poster preferred)", categories: ["APPRECIATION"] },
];
