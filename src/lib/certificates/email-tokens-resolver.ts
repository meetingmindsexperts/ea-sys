/**
 * Server-only token resolver for cover emails — imports DB + logger, so
 * kept out of the client-bundle path. Pairs with the client-safe
 * `email-tokens.ts` (constants + token spec).
 *
 * Resolves the 8 tokens documented in email-tokens.ts. Unknown tokens
 * render empty + emit a structured warn so a typo'd token shows up in
 * /logs at warn level rather than silently on every email. Per the
 * always-log-failures contract.
 */

import { db } from "@/lib/db";
import { escapeHtml } from "@/lib/html";
import { apiLogger } from "@/lib/logger";
import type { CertificateType } from "@prisma/client";

/** One certificate inside a bundle email — feeds the plural tokens. */
export interface CoverEmailBundleCert {
  serial: string;
  type: CertificateType;
  /** Disambiguates two same-category certs in {{certificateList}}. Operator
   *  input → escaped inside the resolver under `escapeDynamic`. */
  templateName?: string | null;
}

/** Pre-resolved values the sender feeds in. */
export interface CoverEmailTokenContext {
  recipientName: string;
  /**
   * Split name parts — optional because only the bulk-email send path (and
   * the preview) carries them; the manual Issue worker's run items snapshot
   * `recipientName` only. Back the `{{firstName}}`/`{{lastName}}` tokens so
   * a saved EMAIL template picked as the cert cover (its greeting is
   * usually "Dear {{firstName}}") renders correctly instead of blank.
   */
  firstName?: string | null;
  lastName?: string | null;
  eventName: string;
  eventStartDate: Date;
  eventEndDate: Date;
  venue?: string | null;
  city?: string | null;
  country?: string | null;
  organizationName: string;
  certificateType: CertificateType;
  certificateSerial: string;
  /**
   * All certs carried by this email (multi-cert bundles). When absent or
   * length 1, every token resolves exactly as the historical single-cert
   * email. With 2+ certs: {{certificateType}} joins the distinct labels,
   * {{certificateSerial}} comma-joins the serials, and {{certificateList}}
   * renders one line per cert.
   */
  bundle?: { certs: CoverEmailBundleCert[] };
  /** Speaker id, when this is an APPRECIATION recipient. Used to look
   *  up `{{abstractTitle}}` on demand — null for ATTENDANCE. */
  speakerId: string | null;
  /** Event id, scopes the abstract lookup. */
  eventId: string;
  /**
   * When true, HTML-escape values the resolver derives INTERNALLY (i.e.
   * `abstractTitle`, fetched from the DB here rather than supplied by the
   * caller). The caller already pre-escapes the values it passes in
   * (recipientName/eventName/venue/…) for the HTML-body path, but it
   * cannot reach `abstractTitle` — a speaker-authored, untrusted string —
   * because that's looked up inside `resolveCoverEmailTokens`. Set this on
   * the escaped context used for the HTML body; leave false/undefined for
   * the plain-text subject + text-body paths so they aren't double-escaped.
   */
  escapeDynamic?: boolean;
}

const CERT_TYPE_LABELS: Record<CertificateType, string> = {
  ATTENDANCE: "Certificate of Attendance",
  APPRECIATION: "Certificate of Appreciation",
};

/**
 * Look up the speaker's accepted abstract title for this event. Prefers
 * POSTER presentationType (matches the existing PDF-renderer
 * `loadPosterAbstractTitle` behavior), falls back to any ACCEPTED
 * abstract, returns null if none.
 *
 * Returns null for non-speaker recipients OR speakers with no accepted
 * abstracts — the caller substitutes empty string in that case.
 */
async function loadAbstractTitle(speakerId: string | null, eventId: string): Promise<string | null> {
  if (!speakerId) return null;
  const poster = await db.abstract.findFirst({
    where: {
      speakerId,
      eventId,
      status: "ACCEPTED",
      presentationType: "POSTER",
    },
    select: { title: true },
    orderBy: { createdAt: "asc" },
  });
  if (poster) return poster.title;
  const any = await db.abstract.findFirst({
    where: { speakerId, eventId, status: "ACCEPTED" },
    select: { title: true },
    orderBy: { createdAt: "asc" },
  });
  return any?.title ?? null;
}

/** Match the in-PDF formatter exactly so cover email + cert visual
 *  print identical date strings. */
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function ordinal(n: number): string {
  if (n >= 11 && n <= 13) return `${n}th`;
  const last = n % 10;
  if (last === 1) return `${n}st`;
  if (last === 2) return `${n}nd`;
  if (last === 3) return `${n}rd`;
  return `${n}th`;
}

function formatDate(d: Date): string {
  return `${ordinal(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
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

function composeVenueLine(ctx: CoverEmailTokenContext): string {
  const parts: string[] = [];
  if (ctx.venue) parts.push(ctx.venue);
  if (ctx.city) parts.push(ctx.city);
  if (ctx.country) parts.push(ctx.country);
  return parts.length > 0 ? `at ${parts.join(", ")}` : "";
}

/** The certs this email covers — a 1-element list when no bundle context is
 *  supplied, so the singular tokens keep their historical values. */
function bundleCerts(ctx: CoverEmailTokenContext): CoverEmailBundleCert[] {
  if (ctx.bundle?.certs?.length) return ctx.bundle.certs;
  return [{ serial: ctx.certificateSerial, type: ctx.certificateType }];
}

/** `{{certificateList}}` — one "Label — SERIAL" line per cert. The template
 *  name is appended only when it disambiguates two same-category certs. */
function buildCertificateList(certs: CoverEmailBundleCert[], escapeDynamic: boolean): string {
  const typeCounts = new Map<CertificateType, number>();
  for (const c of certs) typeCounts.set(c.type, (typeCounts.get(c.type) ?? 0) + 1);
  const lines = certs.map((c) => {
    const label = CERT_TYPE_LABELS[c.type];
    const needsName = (typeCounts.get(c.type) ?? 0) > 1 && c.templateName?.trim();
    const name = needsName
      ? ` (${escapeDynamic ? escapeHtml(c.templateName!.trim()) : c.templateName!.trim()})`
      : "";
    return `${label}${name} — ${c.serial}`;
  });
  return `<p>${lines.join("<br/>")}</p>`;
}

/**
 * Resolve every `{{token}}` in `template` against `ctx`. Async because
 * the abstract title lookup is per-recipient. Unknown tokens render
 * empty + log warn — a typo'd token shows up in /logs as
 * `cert-email-token:unknown`, not silently on the email.
 */
export async function resolveCoverEmailTokens(
  template: string,
  ctx: CoverEmailTokenContext,
): Promise<string> {
  const certs = bundleCerts(ctx);
  const distinctLabels = [...new Set(certs.map((c) => CERT_TYPE_LABELS[c.type]))];
  const baseTokens: Record<string, string> = {
    recipientName: ctx.recipientName,
    // Saved EMAIL templates reused as cert covers use these vars — resolve
    // them here so a "Dear {{firstName}}" greeting doesn't render blank.
    // Fall back to the full recipientName when the caller has no split
    // parts (manual Issue runs snapshot only the full name).
    firstName: ctx.firstName?.trim() || ctx.recipientName,
    lastName: ctx.lastName?.trim() || "",
    eventName: ctx.eventName,
    eventDateRange: formatDateRange(ctx.eventStartDate, ctx.eventEndDate),
    // Aliases matching the EmailTemplate variable names.
    eventDate: formatDate(ctx.eventStartDate),
    eventVenue: ctx.venue ?? "",
    venueLine: composeVenueLine(ctx),
    organizationName: ctx.organizationName,
    certificateType: distinctLabels.join(" & "),
    certificateSerial: certs.map((c) => c.serial).join(", "),
    certificateList: buildCertificateList(certs, !!ctx.escapeDynamic),
  };

  // abstractTitle — only DB-fetched if the template actually references
  // it. Saves a roundtrip per recipient when the token isn't used.
  let abstractTitle = "";
  if (template.includes("{{abstractTitle}}")) {
    const t = await loadAbstractTitle(ctx.speakerId, ctx.eventId);
    if (t) {
      // Speaker-authored, untrusted. Escape for the HTML-body path so a
      // title like `<script>…</script>` can't inject into the cert email.
      abstractTitle = ctx.escapeDynamic ? escapeHtml(t) : t;
    } else if (ctx.speakerId) {
      apiLogger.info({
        msg: "cert-email-token:abstract-missing",
        speakerId: ctx.speakerId,
        eventId: ctx.eventId,
        certificateSerial: ctx.certificateSerial,
        hint: "Template uses {{abstractTitle}} but the speaker has no accepted abstract — token resolves empty.",
      });
    } else {
      apiLogger.info({
        msg: "cert-email-token:no-resolver-for-category",
        certificateType: ctx.certificateType,
        certificateSerial: ctx.certificateSerial,
        hint: "ATTENDANCE template uses {{abstractTitle}} — token resolves empty (only valid on APPRECIATION).",
      });
    }
  }

  const tokens: Record<string, string> = { ...baseTokens, abstractTitle };

  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (key in tokens) return tokens[key];
    apiLogger.warn({
      msg: "cert-email-token:unknown",
      token: key,
      certificateType: ctx.certificateType,
      certificateSerial: ctx.certificateSerial,
      hint:
        "Unknown token in cert cover-email body. Allowed: " +
        Object.keys(tokens).join(", "),
    });
    return "";
  });
}
