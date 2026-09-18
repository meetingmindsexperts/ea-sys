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
 *   {{title}}              "Dr." (empty when none is recorded)
 *   {{firstName}} / {{lastName}}
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

// ── One-certificate emails: editable per event (2026-09-17) ──────────────────
// The single-certificate cover emails are per-event EmailTemplates under
// Communications → Email Templates, one per category, seeded with the
// constants above. Which wording an email uses, field by field:
//   1. the event's Email Template for that category,
//   2. the constants above (only when the template lookup fails).
// A per-run override typed on the Issue dialog wins above both. Until
// Sep 18, 2026 a certificate template could also carry its own cover
// (CertificateTemplate.emailSubject / emailBody); the owner removed that
// layer so one wording per category per event is the only place to edit.
// The columns stay in the schema, unread.

/** Slugs of the editable one-certificate cover emails. Client-safe: the
 *  certificates page and the bulk-email dialog pre-fill from them. */
export const CERT_COVER_TEMPLATE_SLUGS: Record<CertificateType, string> = {
  ATTENDANCE: "certificate-attendance-delivery",
  APPRECIATION: "certificate-appreciation-delivery",
};

/** Their names in the Email Templates list (DEFAULT_TEMPLATES reads these). */
export const CERT_COVER_TEMPLATE_NAMES: Record<CertificateType, string> = {
  ATTENDANCE: "Certificate Delivery (Attendance)",
  APPRECIATION: "Certificate Delivery (Appreciation)",
};

/**
 * The event's cover email for `slug`, read from the Email Templates list the
 * dashboard already fetched. Null when the row is missing or switched off,
 * which is what the server does too: it then uses the built-in text.
 */
export function eventCoverFromTemplateList(
  rows: ReadonlyArray<{ slug: string; isActive: boolean; subject: string; htmlContent: string }> | undefined,
  slug: string,
): { subject: string; body: string } | null {
  const row = rows?.find((t) => t.slug === slug && t.isActive);
  return row ? { subject: row.subject, body: row.htmlContent } : null;
}

/**
 * The cover email for an email carrying ONE certificate. Pure, so the send,
 * the previews and the dashboard pre-fills cannot disagree. `eventCover` is
 * the event's Email Template for the category (null when it could not be
 * loaded); a blank half falls through to the built-in text for that half.
 */
export function pickSingleCoverEmail(
  category: CertificateType,
  eventCover: { subject: string; body: string } | null,
): { subject: string; body: string } {
  return {
    subject: eventCover?.subject?.trim().length ? eventCover.subject : SYSTEM_DEFAULT_SUBJECT,
    body: eventCover?.body?.trim().length ? eventCover.body : defaultBodyForCategory(category),
  };
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
export const CERT_BUNDLE_COVER_TEMPLATE_NAME = "Certificate Delivery (Multiple Certificates)";

/**
 * Which cover email a certificate send will use when the operator leaves the
 * subject and message blank, in the words the Email Templates list uses: one
 * entry per selected certificate template, plus the bundle template when a
 * person can receive several. The bulk-email dialog shows it on the default
 * cover option, which used to say only "Certificate default".
 */
export function describeCertificateCoverSources(
  templates: ReadonlyArray<{ name: string; category: CertificateType }>,
): string {
  if (templates.length === 0) return "Select a certificate template to see which email it uses";
  const parts = templates.map((t) => `${t.name} → ${CERT_COVER_TEMPLATE_NAMES[t.category]}`);
  if (templates.length > 1) parts.push(`anyone receiving several → ${CERT_BUNDLE_COVER_TEMPLATE_NAME}`);
  return parts.join("; ");
}

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
  { token: "{{title}}", description: "Title only, e.g. Dr. (empty when none is recorded)", categories: ["ATTENDANCE", "APPRECIATION"] },
  { token: "{{firstName}}", description: "First name", categories: ["ATTENDANCE", "APPRECIATION"] },
  { token: "{{lastName}}", description: "Last name", categories: ["ATTENDANCE", "APPRECIATION"] },
  { token: "{{eventName}}", description: "Event name", categories: ["ATTENDANCE", "APPRECIATION"] },
  { token: "{{eventDateRange}}", description: "Event date range (e.g. 5th - 7th December 2025)", categories: ["ATTENDANCE", "APPRECIATION"] },
  { token: "{{venueLine}}", description: "Venue + city + country, prefixed with 'at'", categories: ["ATTENDANCE", "APPRECIATION"] },
  { token: "{{organizationName}}", description: "Your organization name", categories: ["ATTENDANCE", "APPRECIATION"] },
  { token: "{{certificateType}}", description: "'Certificate of Attendance' or 'Certificate of Appreciation'", categories: ["ATTENDANCE", "APPRECIATION"] },
  { token: "{{certificateSerial}}", description: "The cert's unique serial number (comma-joined when one email carries several certs)", categories: ["ATTENDANCE", "APPRECIATION"] },
  { token: "{{certificateList}}", description: "One line per attached certificate: type + serial (body only)", categories: ["ATTENDANCE", "APPRECIATION"] },
  { token: "{{abstractTitle}}", description: "Abstract / paper title (the speaker's accepted abstract, poster preferred)", categories: ["APPRECIATION"] },
];
