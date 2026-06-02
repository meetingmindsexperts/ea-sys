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
import { apiLogger } from "@/lib/logger";
import type { CertificateType } from "@prisma/client";

/** Pre-resolved values the sender feeds in. */
export interface CoverEmailTokenContext {
  recipientName: string;
  eventName: string;
  eventStartDate: Date;
  eventEndDate: Date;
  venue?: string | null;
  city?: string | null;
  country?: string | null;
  organizationName: string;
  certificateType: CertificateType;
  certificateSerial: string;
  /** Speaker id, when this is an APPRECIATION recipient. Used to look
   *  up `{{abstractTitle}}` on demand — null for ATTENDANCE. */
  speakerId: string | null;
  /** Event id, scopes the abstract lookup. */
  eventId: string;
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
  const baseTokens: Record<string, string> = {
    recipientName: ctx.recipientName,
    eventName: ctx.eventName,
    eventDateRange: formatDateRange(ctx.eventStartDate, ctx.eventEndDate),
    venueLine: composeVenueLine(ctx),
    organizationName: ctx.organizationName,
    certificateType: CERT_TYPE_LABELS[ctx.certificateType],
    certificateSerial: ctx.certificateSerial,
  };

  // abstractTitle — only DB-fetched if the template actually references
  // it. Saves a roundtrip per recipient when the token isn't used.
  let abstractTitle = "";
  if (template.includes("{{abstractTitle}}")) {
    const t = await loadAbstractTitle(ctx.speakerId, ctx.eventId);
    if (t) {
      abstractTitle = t;
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
