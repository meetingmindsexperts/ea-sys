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

// ── Multi-certificate (bundle) defaults ──────────────────────────────────────
// Used whenever ONE email carries 2+ certificates (Issue tab multi-select,
// bulk-email certificate sends, survey auto-issue bundles). The singular
// per-template cover email still applies when exactly one template is in play.
//
// Since 2026-07-10 the bundle cover email is a first-class, per-event
// EDITABLE EmailTemplate (`certificate-bundle-delivery` under Communications
// → Email Templates, seeded with content identical to the constants below).
// Senders resolve the event's template first (loadBundleCoverEmailTemplate
// in bundle.ts) and fall back to these constants only when the lookup fails.

/** Slug of the editable per-event bundle cover-email template. Client-safe —
 *  the certificates page uses it to pre-fill the Issue dialog. */
export const CERT_BUNDLE_COVER_TEMPLATE_SLUG = "certificate-bundle-delivery";

export const SYSTEM_DEFAULT_SUBJECT_MULTI = "Your certificates — {{eventName}}";

export const SYSTEM_DEFAULT_BODY_MULTI = `<p>Dear {{recipientName}},</p>
<p>Thank you for being part of {{eventName}} ({{eventDateRange}}). Please find your certificates attached:</p>
{{certificateList}}
<p>Best regards,<br/>{{organizationName}}</p>`;

/** Pick the default cover email for a send covering `templateCount`
 *  templates — the per-category single default for one, the bundle
 *  defaults for several. */
export function defaultCoverEmailFor(
  templateCount: number,
  primaryCategory: CertificateType,
): { subject: string; body: string } {
  if (templateCount > 1) {
    return { subject: SYSTEM_DEFAULT_SUBJECT_MULTI, body: SYSTEM_DEFAULT_BODY_MULTI };
  }
  return { subject: SYSTEM_DEFAULT_SUBJECT, body: defaultBodyForCategory(primaryCategory) };
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
  { token: "{{certificateSerial}}", description: "The cert's unique serial number (comma-joined when one email carries several certs)", categories: ["ATTENDANCE", "APPRECIATION"] },
  { token: "{{certificateList}}", description: "One line per attached certificate: type + serial (body only)", categories: ["ATTENDANCE", "APPRECIATION"] },
  { token: "{{abstractTitle}}", description: "Abstract / paper title (the speaker's accepted abstract, poster preferred)", categories: ["APPRECIATION"] },
];
