import fs from "fs/promises";
import path from "path";
import { randomBytes, randomUUID } from "crypto";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { apiLogger } from "./logger";
import { hashVerificationToken } from "./security";
import { formatPersonName, getTitleLabel, formatDate, slugify } from "./utils";
import { resolveTimezone, formatDateInTz, formatTimeInTz, tzLabel } from "./event-time";
import { DEFAULT_SPEAKER_AGREEMENT_HTML } from "./default-terms";
import { formatSessionRole } from "./session-enums";

export interface SpeakerAgreementTemplateMeta {
  url: string;
  filename: string;
  uploadedAt: string;
  uploadedBy: string;
}

// ── Agreement link + {{agreementBlock}} (July 16, 2026, owner request) ──────
//
// "Merge invitation + agreement": the speaker-invitation email now carries a
// one-liner about the agreement plus a "Review & Agree" CTA, exposed as the
// pre-rendered `{{agreementBlock}}` / `{{agreementBlockText}}` template
// variables. The separate agreement email type stays (re-sends/chasers). The
// helpers below are the ONE implementation shared by the single-send route
// and the bulk pipeline — which also fixes a latent bulk bug: bulk agreement
// sends never minted `{{agreementLink}}`, so the default agreement template's
// CTA button href stayed the literal token.

const AGREEMENT_TOKEN_RE = /\{\{(agreementBlock|agreementBlockText|agreementLink)\}\}/;

/** True when any template part references an agreement token — the mint is
 *  gated on this so a send whose template ignores the agreement never rotates
 *  (and thereby invalidates) a previously-emailed agreement link. */
export function templateUsesAgreementBlock(
  ...parts: Array<string | null | undefined>
): boolean {
  return parts.some((p) => !!p && AGREEMENT_TOKEN_RE.test(p));
}

/**
 * Mint the speaker's agreement link (fresh 30-day token, public URL).
 *
 * Two modes (review M1, July 16 2026):
 *   - rotate: true (default — STRICT agreement sends): delete every existing
 *     token first, so the latest agreement email always wins (pre-existing
 *     re-send semantics).
 *   - rotate: false (agreementBlock-driven sends — invitation/custom): mint
 *     ADDITIVELY, sweeping only EXPIRED rows. A casual invitation must never
 *     invalidate a previously-delivered agreement link; tokens are stored
 *     hashed, so "reuse the old link" is impossible — additive minting is
 *     the equivalent guarantee (both links stay valid until expiry, and
 *     acceptance sweeps all of the speaker's tokens).
 */
export async function mintSpeakerAgreementLink(
  speakerId: string,
  eventSlug: string,
  opts?: { rotate?: boolean },
): Promise<string> {
  const identifier = `speaker-agreement:${speakerId}`;
  const rawToken = randomBytes(32).toString("hex");
  const hashedToken = hashVerificationToken(rawToken);
  const rotate = opts?.rotate ?? true;

  await db.$transaction([
    db.verificationToken.deleteMany({
      where: rotate ? { identifier } : { identifier, expires: { lt: new Date() } },
    }),
    db.verificationToken.create({
      data: {
        identifier,
        token: hashedToken,
        expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    }),
  ]);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "";
  return `${appUrl}/e/${eventSlug}/speaker-agreement?token=${rawToken}`;
}

/**
 * Pre-rendered agreement CTA block. Three states:
 *   - already accepted  → green confirmation line, no CTA (re-inviting a
 *     signed speaker must not ask them to sign again)
 *   - link available    → one-liner + "Review & Agree" button
 *   - neither           → empty (the token disappears from the email)
 * The HTML is our own generated markup (rendered via rawHtmlKeys); the only
 * interpolated value is our own minted URL.
 */
export function buildAgreementBlock(opts: {
  agreementLink: string;
  agreementAcceptedAt?: Date | string | null;
}): { html: string; text: string } {
  if (opts.agreementAcceptedAt) {
    const when = new Date(opts.agreementAcceptedAt).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    return {
      html: `<p style="background: #f0fdf4; border-left: 4px solid #16a34a; padding: 12px 16px; color: #166534; font-size: 14px; margin: 20px 0;">&#10003; You have already reviewed and accepted the speaker agreement (${when}).</p>`,
      text: `You have already reviewed and accepted the speaker agreement (${when}).`,
    };
  }
  if (!opts.agreementLink) return { html: "", text: "" };
  return {
    html: `<div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 20px 0;">
      <p style="margin: 0 0 14px 0; color: #374151; font-size: 14px;">Your participation is covered by our <strong>speaker agreement</strong> — please take a moment to review and accept it.</p>
      <div style="text-align: center;">
        <a href="${opts.agreementLink}" style="display: inline-block; background: #00aade; color: white; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: 600;">Review &amp; Agree</a>
      </div>
      <p style="margin: 14px 0 0 0; color: #6b7280; font-size: 12px; text-align: center;">This link is unique to you and expires in 30 days.</p>
    </div>`,
    text: `Your participation is covered by our speaker agreement — please review and accept it here (link unique to you, expires in 30 days):\n${opts.agreementLink}`,
  };
}

export interface SpeakerEmailContext {
  // Speaker identity
  title: string;
  firstName: string;
  lastName: string;
  speakerName: string;
  speakerEmail: string;
  // Extended speaker fields — used by the MMG-style agreement HTML
  // ("{{jobTitle}}, {{speakerOrganization}}, {{speakerCountry}}"
  // appears in the Parties & Key Terms table).
  jobTitle: string;
  speakerOrganization: string;
  speakerCountry: string;

  // Event details
  eventName: string;
  eventSlug: string;
  eventStartDate: string;
  eventEndDate: string;
  eventDate: string;
  eventDateRange: string; // "Start — End" or just start if same-day
  eventVenue: string;
  eventAddress: string;
  eventCity: string;
  organizationName: string;

  // Presentation details
  sessionTitles: string;
  topicTitles: string;
  sessionDateTime: string;
  trackNames: string;
  role: string;

  // Rendered-at-send-time fields
  signedDate: string; // today, formatted for the agreement signature line

  // Pre-rendered HTML/text blocks for email templates
  presentationDetails: string;
  presentationDetailsText: string;
  // Moderator view — the sessions this speaker MODERATES, each with its full
  // topic run-sheet (topic, speakers, duration, computed start–end from the
  // session start + cumulative topic durations). Empty for non-moderators.
  moderatorDetails: string;
  moderatorDetailsText: string;
}

interface SpeakerEmailContextRow {
  speaker: {
    title: string | null;
    firstName: string;
    lastName: string;
    email: string;
    jobTitle: string | null;
    organization: string | null;
    country: string | null;
    sessions: Array<{
      role: string;
      session: {
        name: string;
        startTime: Date;
        endTime: Date;
        location: string | null;
        track: { name: string } | null;
        topics: Array<{
          title: string;
          duration: number | null;
          speakers: Array<{
            speaker: { title: string | null; firstName: string; lastName: string };
          }>;
        }>;
      };
    }>;
    topicSpeakers: Array<{
      topic: {
        id: string;
        title: string;
        duration: number | null;
        session: {
          name: string;
          startTime: Date;
          endTime: Date;
          track: { name: string } | null;
          // Ordered sibling topics — needed to compute THIS topic's start
          // time by stacking preceding durations from the session start.
          topics: Array<{ id: string; duration: number | null }>;
        };
      };
    }>;
  };
  event: {
    name: string;
    slug: string;
    startDate: Date;
    endDate: Date;
    timezone: string | null;
    venue: string | null;
    address: string | null;
    city: string | null;
    organization: { name: string };
  };
}

async function loadSpeakerEmailRow(eventId: string, speakerId: string): Promise<SpeakerEmailContextRow | null> {
  const [speaker, event] = await Promise.all([
    db.speaker.findFirst({
      where: { id: speakerId, eventId },
      select: {
        title: true,
        firstName: true,
        lastName: true,
        email: true,
        jobTitle: true,
        organization: true,
        country: true,
        sessions: {
          select: {
            role: true,
            session: {
              select: {
                name: true,
                startTime: true,
                endTime: true,
                location: true,
                track: { select: { name: true } },
                // Topic run-sheet — feeds {{moderatorDetails}} for sessions
                // this speaker moderates (topic, speakers, duration, times).
                topics: {
                  orderBy: { sortOrder: "asc" },
                  select: {
                    title: true,
                    duration: true,
                    speakers: {
                      select: {
                        speaker: { select: { title: true, firstName: true, lastName: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        topicSpeakers: {
          select: {
            topic: {
              select: {
                title: true,
                session: {
                  select: {
                    name: true,
                    startTime: true,
                    endTime: true,
                    track: { select: { name: true } },
                  },
                },
              },
            },
          },
        },
      },
    }),
    db.event.findFirst({
      where: { id: eventId },
      select: {
        name: true,
        slug: true,
        startDate: true,
        endDate: true,
        timezone: true,
        venue: true,
        address: true,
        city: true,
        organization: { select: { name: true } },
      },
    }),
  ]);

  if (!speaker || !event) return null;

  return { speaker, event } as SpeakerEmailContextRow;
}

/** "1h 30m" / "2h" / "45m"; "" when non-positive. */
function formatMinutes(mins: number): string {
  if (mins <= 0) return "";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h}h ${m}m`;
  return h ? `${h}h` : `${m}m`;
}

/** "1h 30m" / "2h" / "45m"; "" when the window is missing or non-positive. */
function formatSessionDuration(start: Date, end: Date): string {
  return formatMinutes(Math.round((end.getTime() - start.getTime()) / 60_000));
}

/**
 * One session's time window as SEPARATE lines — date, start–end clock,
 * duration (owner request: never one combined line). The duration line is
 * omitted when the window is missing/non-positive; without an end time the
 * clock line is just the start.
 *   ["Monday, March 15, 2026", "9:00 AM – 10:30 AM GMT+4", "1h 30m"]
 */
function sessionWindowLines(start: Date, end: Date | null, tz: string): string[] {
  const lines = [formatDateInTz(start, tz)];
  if (!end || end.getTime() <= start.getTime()) {
    lines.push(`${formatTimeInTz(start, tz)} ${tzLabel(start, tz)}`);
    return lines;
  }
  lines.push(`${formatTimeInTz(start, tz)} – ${formatTimeInTz(end, tz)} ${tzLabel(start, tz)}`);
  const duration = formatSessionDuration(start, end);
  if (duration) lines.push(duration);
  return lines;
}

const MOD_CELL_STYLE =
  "padding:8px 12px; border-bottom:1px solid #e5e7eb; color:#111827; font-size:13px; vertical-align:top;";
const MOD_HEAD_STYLE =
  "padding:8px 12px; border-bottom:1px solid #e5e7eb; color:#6b7280; font-size:12px; text-align:left; text-transform:uppercase; letter-spacing:0.03em;";

/**
 * {{moderatorDetails}} — for each session the speaker MODERATES: the session
 * name + time window, then the full topic run-sheet (topic, speakers,
 * duration, and each topic's start–end computed by stacking the topic
 * durations from the session start — SessionTopic has no stored start time).
 * A topic with no duration shows "—" and does not advance the clock.
 * Dynamic strings (topic titles, speaker names) are HTML-escaped.
 */
function buildModeratorBlocks(row: SpeakerEmailContextRow): { html: string; text: string } {
  const moderated = row.speaker.sessions.filter((s) => s.role === "MODERATOR");
  if (!moderated.length) return { html: "", text: "" };

  const eventTz = resolveTimezone(row.event.timezone);
  const htmlParts: string[] = [];
  const textParts: string[] = [];

  for (const { session } of moderated) {
    // Date / time / duration as separate lines (owner request).
    const windowLines = sessionWindowLines(session.startTime, session.endTime ?? null, eventTz);
    const headerHtml = `<strong>${escapeHtmlForAgreement(session.name)}</strong>${
      session.location ? ` · ${escapeHtmlForAgreement(session.location)}` : ""
    }`;
    const trackSuffix = session.track?.name
      ? `<br/>Track: ${escapeHtmlForAgreement(session.track.name)}`
      : "";

    textParts.push(
      `Session: ${session.name}${session.location ? ` · ${session.location}` : ""}\n${windowLines.join("\n")}${session.track?.name ? `\nTrack: ${session.track.name}` : ""}`,
    );

    let bodyRows = "";
    let clock = new Date(session.startTime).getTime();
    for (const topic of session.topics) {
      const speakers = topic.speakers
        .map((ts) => formatPersonName(ts.speaker.title, ts.speaker.firstName, ts.speaker.lastName))
        .join(", ");
      let timeCell = "—";
      let durationCell = "—";
      if (topic.duration && topic.duration > 0) {
        const start = new Date(clock);
        const end = new Date(clock + topic.duration * 60_000);
        timeCell = `${formatTimeInTz(start, eventTz)} – ${formatTimeInTz(end, eventTz)}`;
        durationCell = formatMinutes(topic.duration);
        clock = end.getTime();
      }
      bodyRows += `        <tr><td style="${MOD_CELL_STYLE} white-space:nowrap;">${timeCell}</td><td style="${MOD_CELL_STYLE}">${escapeHtmlForAgreement(topic.title)}</td><td style="${MOD_CELL_STYLE}">${speakers ? escapeHtmlForAgreement(speakers) : "—"}</td><td style="${MOD_CELL_STYLE} white-space:nowrap;">${durationCell}</td></tr>\n`;
      textParts.push(
        `  ${timeCell} · ${topic.title}${speakers ? ` — ${speakers}` : ""}${durationCell !== "—" ? ` (${durationCell})` : ""}`,
      );
    }

    const topicsTable = session.topics.length
      ? `<table style="border-collapse:collapse; width:100%; background:#f9fafb; border:1px solid #e5e7eb; border-radius:6px;">
        <tr><th style="${MOD_HEAD_STYLE}">Time</th><th style="${MOD_HEAD_STYLE}">Topic</th><th style="${MOD_HEAD_STYLE}">Speaker(s)</th><th style="${MOD_HEAD_STYLE}">Duration</th></tr>
${bodyRows}      </table>`
      : `<p style="margin:0; color:#6b7280; font-size:13px; font-style:italic;">No topics have been added to this session yet.</p>`;
    if (!session.topics.length) textParts.push("  (no topics added yet)");

    htmlParts.push(
      `<div style="margin:16px 0;">
      <p style="margin:0 0 2px 0; font-size:15px; color:#111827;">${headerHtml}</p>
      <p style="margin:0 0 8px 0; color:#6b7280; font-size:13px;">${windowLines.join("<br/>")}${trackSuffix}</p>
      ${topicsTable}
    </div>`,
    );
  }

  return { html: htmlParts.join("\n"), text: textParts.join("\n") };
}

function buildPresentationBlocks(row: SpeakerEmailContextRow): {
  sessionTitles: string;
  topicTitles: string;
  sessionDateTime: string;
  trackNames: string;
  role: string;
  html: string;
  text: string;
} {
  const sessionRows = row.speaker.sessions;
  const topicRows = row.speaker.topicSpeakers;

  const sessionTitles = sessionRows.map((s) => s.session.name).join("\n");
  const topicTitles = topicRows.map((t) => t.topic.title).join("\n");

  const firstSession = sessionRows[0]?.session ?? topicRows[0]?.topic.session ?? null;
  // Render in the EVENT's timezone — {sessionDateTime} lands inside the
  // quasi-legal personalized agreement document, and the Dubai-fixed
  // formatDateTime was wrong for any non-GST event (review M10).
  // Deliberately start-time-only and format-stable: the docx merge token must
  // not change shape under it. The email block below carries the richer
  // per-session time WINDOW + duration instead.
  const eventTz = resolveTimezone(row.event.timezone);
  const sessionDateTime = firstSession
    ? `${formatDateInTz(firstSession.startTime, eventTz)}, ${formatTimeInTz(firstSession.startTime, eventTz)} ${tzLabel(firstSession.startTime, eventTz)}`
    : "";

  // One "Date & Time" line PER session for the email block — start – end
  // clock in the event TZ plus the duration, e.g.
  // "Monday, March 15, 2026, 9:00 AM – 10:30 AM GMT+4 (1h 30m)".
  // Session-role sessions win; topic-only speakers fall back to their topics'
  // sessions (deduped — several topics can share one session).
  const timeSessions = sessionRows.length
    ? sessionRows.map((s) => s.session)
    : topicRows.map((t) => t.topic.session);
  const seenWindows = new Set<string>();
  const sessionDateTimeLines: string[] = [];
  for (const s of timeSessions) {
    const key = `${s.name}|${s.startTime.getTime()}`;
    if (seenWindows.has(key)) continue;
    seenWindows.add(key);
    // Three lines per session — date / time / duration (owner request).
    sessionDateTimeLines.push(
      sessionWindowLines(s.startTime, s.endTime ?? null, eventTz).join("<br/>"),
    );
  }

  const trackSet = new Set<string>();
  for (const s of sessionRows) if (s.session.track?.name) trackSet.add(s.session.track.name);
  for (const t of topicRows) if (t.topic.session.track?.name) trackSet.add(t.topic.session.track.name);
  const trackNames = Array.from(trackSet).join(", ");

  const roleSet = new Set<string>();
  for (const s of sessionRows) {
    const label = formatSessionRole(s.role);
    if (label) roleSet.add(label);
  }
  const role = Array.from(roleSet).join(", ");

  // Pre-rendered HTML block — rendered via rawHtmlKeys so it's not escaped.
  // Inline styles only (no <style> blocks) so juice / email clients render correctly.
  const rows: Array<[string, string]> = [];
  if (sessionTitles) rows.push(["Session", sessionTitles.replace(/\n/g, "<br/>")]);
  if (topicTitles) rows.push(["Topic", topicTitles.replace(/\n/g, "<br/>")]);
  if (sessionDateTimeLines.length) {
    // Blank line between sessions so each 3-line group reads as one entry.
    rows.push(["Date &amp; Time", sessionDateTimeLines.join("<br/><br/>")]);
  }
  if (trackNames) rows.push(["Track", trackNames]);
  // NO Role row (owner decision, July 17 2026): organizers send separate
  // emails to moderators vs speakers, so the block never displays the role.
  // The `role` context field itself stays — it's a {role} docx merge token.

  const html = rows.length
    ? `<table style="border-collapse:collapse; margin:16px 0; width:100%; background:#f9fafb; border:1px solid #e5e7eb; border-radius:6px;">
${rows
  .map(
    ([label, value]) =>
      `        <tr><td style="padding:10px 14px; border-bottom:1px solid #e5e7eb; color:#6b7280; font-size:13px; width:140px; vertical-align:top;">${label}</td><td style="padding:10px 14px; border-bottom:1px solid #e5e7eb; color:#111827; font-size:14px;">${value}</td></tr>`,
  )
  .join("\n")}
      </table>`
    : "";

  const text = rows.length
    ? rows.map(([label, value]) => `${label}: ${value.replace(/(<br\/>)+/g, ", ").replace(/&amp;/g, "&")}`).join("\n")
    : "";

  return { sessionTitles, topicTitles, sessionDateTime, trackNames, role, html, text };
}

/**
 * Build the speaker email context — used both as docx merge fields and as
 * email template variables. Single source of truth so docx attachments and
 * email body greetings stay in sync.
 */
export async function buildSpeakerEmailContext(
  eventId: string,
  speakerId: string,
): Promise<SpeakerEmailContext | null> {
  const row = await loadSpeakerEmailRow(eventId, speakerId);
  if (!row) return null;

  const { speaker, event } = row;
  const presentation = buildPresentationBlocks(row);
  const moderator = buildModeratorBlocks(row);

  // Build date range — single-day events show just the start date; multi-day
  // events show "Start — End" using an en-dash so the MMG template's
  // "{{eventDateRange}} · {{eventVenue}}, {{eventCity}}" line reads naturally.
  const startStr = formatDate(event.startDate);
  const endStr = formatDate(event.endDate);
  const eventDateRange =
    startStr === endStr ? startStr : `${startStr} – ${endStr}`;

  return {
    title: getTitleLabel(speaker.title),
    firstName: speaker.firstName,
    lastName: speaker.lastName,
    speakerName: formatPersonName(speaker.title, speaker.firstName, speaker.lastName),
    speakerEmail: speaker.email,
    jobTitle: speaker.jobTitle ?? "",
    speakerOrganization: speaker.organization ?? "",
    speakerCountry: speaker.country ?? "",

    eventName: event.name,
    eventSlug: event.slug,
    eventStartDate: startStr,
    eventEndDate: endStr,
    eventDate: startStr,
    eventDateRange,
    eventVenue: event.venue ?? "TBA",
    eventAddress: event.address ?? "",
    eventCity: event.city ?? "",
    organizationName: event.organization.name,

    signedDate: formatDate(new Date()),

    sessionTitles: presentation.sessionTitles,
    topicTitles: presentation.topicTitles,
    sessionDateTime: presentation.sessionDateTime,
    trackNames: presentation.trackNames,
    role: presentation.role,

    presentationDetails: presentation.html,
    presentationDetailsText: presentation.text,
    moderatorDetails: moderator.html,
    moderatorDetailsText: moderator.text,
  };
}

/**
 * Resolve a stored agreement-template URL ("/uploads/agreements/.../foo.docx")
 * to an absolute on-disk path inside `public/`. Path-traversal guarded.
 */
function resolveTemplatePath(url: string): string | null {
  if (!url.startsWith("/uploads/agreements/")) return null;
  const rel = url.replace(/^\/+/, "");
  const abs = path.resolve(process.cwd(), "public", rel);
  const expectedRoot = path.resolve(process.cwd(), "public", "uploads", "agreements");
  if (!abs.startsWith(expectedRoot + path.sep)) return null;
  return abs;
}

/**
 * Generate a personalized speaker agreement .docx by mail-merging the
 * event-level template with the speaker's context. Returns `null` if the
 * event has no template configured. Throws on render errors so the caller
 * can surface them.
 */
export async function generateSpeakerAgreementDocx(opts: {
  eventId: string;
  speakerId: string;
}): Promise<{ buffer: Buffer; filename: string } | null> {
  const { eventId, speakerId } = opts;

  const event = await db.event.findFirst({
    where: { id: eventId },
    select: { slug: true, speakerAgreementTemplate: true },
  });
  if (!event) return null;

  const meta = event.speakerAgreementTemplate as SpeakerAgreementTemplateMeta | null;
  if (!meta?.url) return null;

  const absPath = resolveTemplatePath(meta.url);
  if (!absPath) {
    apiLogger.error({ msg: "speaker-agreement:template-path-rejected", eventId, url: meta.url });
    return null;
  }

  const context = await buildSpeakerEmailContext(eventId, speakerId);
  if (!context) return null;

  let templateBuffer: Buffer;
  try {
    templateBuffer = await fs.readFile(absPath);
  } catch (err) {
    apiLogger.error({ err, msg: "speaker-agreement:template-read-failed", eventId, absPath });
    throw new Error("Speaker agreement template file is missing or unreadable");
  }

  const zip = new PizZip(templateBuffer);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: "{", end: "}" },
  });

  // docxtemplater does its own escaping — pass the plain context values, NOT
  // the HTML block (which is for the email body, not the .docx attachment).
  const mergeData: Record<string, string> = {
    title: context.title,
    firstName: context.firstName,
    lastName: context.lastName,
    speakerName: context.speakerName,
    speakerEmail: context.speakerEmail,
    eventName: context.eventName,
    eventStartDate: context.eventStartDate,
    eventEndDate: context.eventEndDate,
    eventDate: context.eventDate,
    eventVenue: context.eventVenue,
    eventAddress: context.eventAddress,
    organizationName: context.organizationName,
    sessionTitles: context.sessionTitles,
    topicTitles: context.topicTitles,
    sessionDateTime: context.sessionDateTime,
    trackNames: context.trackNames,
    role: context.role,
  };

  try {
    doc.render(mergeData);
  } catch (err) {
    apiLogger.error({ err, msg: "speaker-agreement:docx-render-failed", eventId, speakerId });
    throw new Error("Failed to render speaker agreement template — check that placeholders use { } delimiters");
  }

  const outBuf = doc.toBuffer({ compression: "DEFLATE" });
  const filename = `agreement-${slugify(event.slug)}-${slugify(context.lastName || "speaker")}.docx`;

  return { buffer: outBuf, filename };
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline HTML → PDF path (preferred when no .docx template is uploaded)
// ─────────────────────────────────────────────────────────────────────────────

export const SPEAKER_AGREEMENT_PDF_MIME = "application/pdf";

// ─── PDF letterhead images (July 17, 2026, organizer request) ────────────────
// Optional header/footer banner images drawn edge-to-edge on EVERY page of a
// generated agreement PDF. The speaker and presenter agreements each carry
// their OWN pair (`scope`). PDF-path only — an uploaded .docx template carries
// its own letterhead, and the public acceptance pages render the HTML text
// without them (the byte-for-byte parity guarantee covers the text, not
// PDF-only branding).

export const AGREEMENT_PDF_IMAGE_MAX_SIZE = 2 * 1024 * 1024; // 2 MB
/** pdfkit can embed PNG and JPEG only — WebP is NOT supported. */
export type AgreementPdfImageFormat = "png" | "jpeg";
export type AgreementPdfImageSlot = "header" | "footer";
/** Which agreement's letterhead a slot belongs to — each has its own pair. */
export type AgreementPdfImageScope = "speaker" | "presenter";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

/** Identify the image format from magic bytes — null for anything pdfkit can't embed. */
export function sniffAgreementImageFormat(buffer: Buffer): AgreementPdfImageFormat | null {
  if (buffer.length >= 4 && PNG_MAGIC.every((b, i) => buffer[i] === b)) return "png";
  if (buffer.length >= 3 && JPEG_MAGIC.every((b, i) => buffer[i] === b)) return "jpeg";
  return null;
}

/**
 * Pixel dimensions from the image header — needed BEFORE creating the pdfkit
 * document, because the letterhead height determines the page's content
 * margins. PNG: IHDR width/height at fixed offsets. JPEG: walk the marker
 * segments to the first SOF frame. Returns null on anything malformed (the
 * caller renders without the image rather than failing the agreement).
 */
export function probeImageDimensions(
  buffer: Buffer,
  format: AgreementPdfImageFormat,
): { width: number; height: number } | null {
  try {
    if (format === "png") {
      // 8-byte signature, then IHDR chunk: length(4) + "IHDR"(4) + width(4) + height(4).
      if (buffer.length < 24) return null;
      if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    // JPEG: scan markers for the first SOF0–SOF15 frame (excluding DHT/JPG/DAC).
    let pos = 2; // past FFD8
    while (pos + 4 <= buffer.length) {
      if (buffer[pos] !== 0xff) return null;
      const marker = buffer[pos + 1];
      // Standalone markers with no length payload.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        pos += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before any SOF
      const segLen = buffer.readUInt16BE(pos + 2);
      if (segLen < 2) return null;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        if (pos + 9 > buffer.length) return null;
        const height = buffer.readUInt16BE(pos + 5);
        const width = buffer.readUInt16BE(pos + 7);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      pos += 2 + segLen;
    }
    return null;
  } catch {
    return null;
  }
}

export const AGREEMENT_IMAGE_COLUMN = {
  speaker: {
    header: "speakerAgreementPdfHeaderImage",
    footer: "speakerAgreementPdfFooterImage",
  },
  presenter: {
    header: "presenterAgreementPdfHeaderImage",
    footer: "presenterAgreementPdfFooterImage",
  },
} as const satisfies Record<AgreementPdfImageScope, Record<AgreementPdfImageSlot, string>>;

const AGREEMENT_IMAGE_SELECT = {
  id: true,
  speakerAgreementPdfHeaderImage: true,
  speakerAgreementPdfFooterImage: true,
  presenterAgreementPdfHeaderImage: true,
  presenterAgreementPdfFooterImage: true,
} as const;

/**
 * Validate + persist a letterhead image for the agreement PDF. Mirrors
 * `saveSpeakerAgreementTemplate` (same directory, same previous-file cleanup,
 * same error class) so the two upload surfaces behave identically. PNG/JPEG
 * enforced by MAGIC BYTES, not the claimed MIME — pdfkit cannot embed WebP,
 * so a spoofed Content-Type would otherwise break rendering at send time.
 * Caller owns auth + rate limiting; org access is enforced by the event lookup.
 */
export async function saveAgreementPdfImage({
  eventId,
  organizationId,
  buffer,
  scope,
  slot,
  actorUserId,
}: {
  eventId: string;
  organizationId: string;
  buffer: Buffer;
  scope: AgreementPdfImageScope;
  slot: AgreementPdfImageSlot;
  actorUserId: string;
}): Promise<{ url: string }> {
  if (buffer.length > AGREEMENT_PDF_IMAGE_MAX_SIZE) {
    throw new SpeakerAgreementTemplateError(
      "IMAGE_TOO_LARGE",
      `Image must be under ${Math.round(AGREEMENT_PDF_IMAGE_MAX_SIZE / 1024 / 1024)}MB`,
    );
  }

  const format = sniffAgreementImageFormat(buffer);
  if (!format) {
    apiLogger.warn({ msg: "agreement-pdf-image:invalid-magic-bytes", actorUserId, scope, slot });
    throw new SpeakerAgreementTemplateError(
      "INVALID_IMAGE",
      "File is not a PNG or JPEG image (WebP is not supported in the agreement PDF)",
    );
  }
  if (!probeImageDimensions(buffer, format)) {
    apiLogger.warn({ msg: "agreement-pdf-image:unreadable-dimensions", actorUserId, scope, slot });
    throw new SpeakerAgreementTemplateError(
      "INVALID_IMAGE",
      "Image header is malformed — re-export the file and try again",
    );
  }

  const column = AGREEMENT_IMAGE_COLUMN[scope][slot];
  const event = await db.event.findFirst({
    where: { id: eventId, organizationId },
    select: AGREEMENT_IMAGE_SELECT,
  });
  if (!event) {
    throw new SpeakerAgreementTemplateError("EVENT_NOT_FOUND", `Event ${eventId} not found or access denied`);
  }

  const dirRel = path.join("uploads", "agreements", eventId);
  const dirAbs = path.resolve(process.cwd(), "public", dirRel);
  await fs.mkdir(dirAbs, { recursive: true });

  const storedFilename = `${scope}-${slot}-${randomUUID()}.${format === "png" ? "png" : "jpg"}`;
  await fs.writeFile(path.join(dirAbs, storedFilename), buffer);

  // Best-effort previous-file cleanup, path-traversal guarded.
  await unlinkAgreementUpload(event[column], "agreement-pdf-image:previous-unlink-failed");

  const url = `/${dirRel.replace(/\\/g, "/")}/${storedFilename}`;
  await db.event.update({ where: { id: eventId }, data: { [column]: url } });

  return { url };
}

/**
 * Clear a letterhead image slot: unlink the file (guarded) + null the column.
 * Idempotent — clearing an empty slot is a no-op.
 */
export async function deleteAgreementPdfImage({
  eventId,
  organizationId,
  scope,
  slot,
}: {
  eventId: string;
  organizationId: string;
  scope: AgreementPdfImageScope;
  slot: AgreementPdfImageSlot;
}): Promise<void> {
  const column = AGREEMENT_IMAGE_COLUMN[scope][slot];
  const event = await db.event.findFirst({
    where: { id: eventId, organizationId },
    select: AGREEMENT_IMAGE_SELECT,
  });
  if (!event) {
    throw new SpeakerAgreementTemplateError("EVENT_NOT_FOUND", `Event ${eventId} not found or access denied`);
  }

  await unlinkAgreementUpload(event[column], "agreement-pdf-image:delete-unlink-failed");
  await db.event.update({ where: { id: eventId }, data: { [column]: null } });
}

/** Unlink a file under /uploads/agreements/ — same guard as the .docx cleanup. */
async function unlinkAgreementUpload(url: string | null | undefined, failLogMsg: string): Promise<void> {
  if (!url?.startsWith("/uploads/agreements/")) return;
  const abs = path.resolve(process.cwd(), "public", url.replace(/^\/+/, ""));
  const expectedRoot = path.resolve(process.cwd(), "public", "uploads", "agreements");
  if (!abs.startsWith(expectedRoot + path.sep)) return;
  await fs.unlink(abs).catch((err) => apiLogger.warn({ err, msg: failLogMsg, abs }));
}

/**
 * Merge `{{token}}` placeholders in an HTML agreement body using the
 * speaker email context. Used both by the PDF attachment renderer and by
 * the public acceptance page so the two surfaces never disagree.
 *
 * Unknown tokens are left as-is (not stripped) so typos surface visibly
 * rather than silently disappearing. Values are escaped for HTML.
 */
export function mergeAgreementHtml(html: string, ctx: SpeakerEmailContext): string {
  const values: Record<string, string> = {
    title: ctx.title,
    firstName: ctx.firstName,
    lastName: ctx.lastName,
    speakerName: ctx.speakerName,
    speakerEmail: ctx.speakerEmail,
    jobTitle: ctx.jobTitle,
    speakerOrganization: ctx.speakerOrganization,
    speakerCountry: ctx.speakerCountry,
    eventName: ctx.eventName,
    eventStartDate: ctx.eventStartDate,
    eventEndDate: ctx.eventEndDate,
    eventDate: ctx.eventDate,
    eventDateRange: ctx.eventDateRange,
    eventVenue: ctx.eventVenue,
    eventAddress: ctx.eventAddress,
    eventCity: ctx.eventCity,
    organizationName: ctx.organizationName,
    signedDate: ctx.signedDate,
    sessionTitles: ctx.sessionTitles,
    topicTitles: ctx.topicTitles,
    sessionDateTime: ctx.sessionDateTime,
    trackNames: ctx.trackNames,
    role: ctx.role,
    // The DEFAULT_SPEAKER_AGREEMENT_HTML doesn't reference these, but an
    // organizer editing inline HTML may type `{{presentationDetails}}` —
    // we surface the plain-text variant for both names because the
    // pre-rendered HTML form is reserved for the email body (rendered via
    // `renderAndWrap`'s rawHtmlKeys path), where embedding raw <table>
    // markup makes sense; on the agreement page the surrounding HTML
    // structure is already a real document, so plain text is safer.
    presentationDetails: ctx.presentationDetailsText,
    presentationDetailsText: ctx.presentationDetailsText,
    // Same plain-text policy as presentationDetails (see comment above).
    moderatorDetails: ctx.moderatorDetailsText,
    moderatorDetailsText: ctx.moderatorDetailsText,
  };

  return html.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      const v = values[key as keyof typeof values];
      return escapeHtmlForAgreement(v ?? "");
    }
    return match;
  });
}

function escapeHtmlForAgreement(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const SAFE_HREF_SCHEMES = ["http:", "https:", "mailto:", "tel:"] as const;
/**
 * Accept only known-safe URL schemes for anchor hrefs in agreement HTML.
 * Relative URLs (starting with `/` or `#`) are allowed. Anything else
 * (javascript:, data:, file:, vbscript:, etc.) becomes empty so the
 * anchor renders as plain underlined text with no link annotation.
 */
function sanitizeHref(raw: string): string {
  const href = raw.trim();
  if (!href) return "";
  if (href.startsWith("/") || href.startsWith("#")) return href;
  const lower = href.toLowerCase();
  for (const scheme of SAFE_HREF_SCHEMES) {
    if (lower.startsWith(scheme)) return href;
  }
  return "";
}

/**
 * Resolve the inline agreement HTML for an event, merged with a speaker's
 * context. Used by the public acceptance page AND by the PDF generator, so
 * the speaker reads identical text online and in the email attachment.
 *
 * Returns `null` if the event/speaker pair can't be resolved.
 */
export async function resolveAgreementHtmlForSpeaker(
  eventId: string,
  speakerId: string,
): Promise<{ html: string; context: SpeakerEmailContext } | null> {
  const event = await db.event.findFirst({
    where: { id: eventId },
    select: { speakerAgreementHtml: true },
  });
  if (!event) return null;

  const context = await buildSpeakerEmailContext(eventId, speakerId);
  if (!context) return null;

  const raw = event.speakerAgreementHtml?.trim() || DEFAULT_SPEAKER_AGREEMENT_HTML;
  const merged = mergeAgreementHtml(raw, context);
  return { html: merged, context };
}

// ── Minimal HTML → pdfkit renderer ────────────────────────────────────────
//
// Renders the constrained subset of HTML that Tiptap emits for agreement
// bodies. Deliberately does NOT attempt to be a general HTML renderer —
// anything outside this allowlist is treated as pass-through text:
//
//   Blocks:  <p> <h1>..<h6> <ul> <ol> <li> <hr> <br> <blockquote> <div>
//   Inline:  <strong>/<b>, <em>/<i>, <u>, <a href="">, <span>
//
// Any other tag (<img>, <table>, <style>, <script>…) is skipped. Inline
// styles are ignored — the PDF picks font size/weight from the tag.

type TokenKind = "open" | "close" | "text";
interface Token {
  kind: TokenKind;
  tag?: string;
  attrs?: Record<string, string>;
  text?: string;
}

// Common named HTML entities that routinely appear in Word / web paste
// content. Extending beyond this is not worth it — everything else can
// still be written as a numeric entity like `&#8594;`.
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  copy: "©",
  reg: "®",
  trade: "™",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  bull: "•",
  middot: "·",
  euro: "€",
  laquo: "«",
  raquo: "»",
  sect: "§",
  para: "¶",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m);
}

function tokenizeHtml(html: string): Token[] {
  const out: Token[] = [];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m.index > last) {
      const text = decodeEntities(html.slice(last, m.index));
      if (text) out.push({ kind: "text", text });
    }
    last = m.index + m[0].length;
    if (m[0].startsWith("<!--")) continue;
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    const selfClosing = m[4] === "/" || tag === "br" || tag === "hr" || tag === "img";
    const attrs: Record<string, string> = {};
    const attrStr = m[3] || "";
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(attrStr)) !== null) {
      attrs[am[1].toLowerCase()] = decodeEntities(am[2] ?? am[3] ?? am[4] ?? "");
    }
    if (closing) {
      out.push({ kind: "close", tag });
    } else {
      out.push({ kind: "open", tag, attrs });
      if (selfClosing) out.push({ kind: "close", tag });
    }
  }
  if (last < html.length) {
    const text = decodeEntities(html.slice(last));
    if (text) out.push({ kind: "text", text });
  }
  return out;
}

// Exported for reuse by the certificate renderer, which uses
// `parseHtmlToBlocks` to handle WYSIWYG cert bodies. Keep these shapes
// stable — both the agreement PDF and the cert PDF compose against them.
export interface InlineRun {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  link?: string;
}

interface TableCell {
  runs: InlineRun[];
  isHeader: boolean;
}
interface TableRow {
  cells: TableCell[];
}

export type Block =
  | { kind: "paragraph"; runs: InlineRun[] }
  | { kind: "heading"; level: number; runs: InlineRun[] }
  | { kind: "list-item"; ordered: boolean; index: number; depth: number; runs: InlineRun[] }
  | { kind: "table"; rows: TableRow[] }
  | { kind: "callout"; runs: InlineRun[] }
  | { kind: "rule" };

/**
 * Parse HTML into a flat list of block-level render directives. Inline
 * formatting is preserved per-run inside each block.
 *
 * @internal Exported for tests; callers should prefer `generateSpeakerAgreementPdf`.
 */
export function parseHtmlToBlocks(html: string): Block[] {
  const tokens = tokenizeHtml(html);
  const blocks: Block[] = [];

  // Format state stacks for inline runs.
  const boldStack: boolean[] = [];
  const italicStack: boolean[] = [];
  const underlineStack: boolean[] = [];
  const linkStack: string[] = [];

  // Block context stacks — tracks which block type is currently being built.
  type BlockCtx =
    | { kind: "paragraph" | "heading"; level?: number; runs: InlineRun[] }
    | { kind: "list"; ordered: boolean; counter: number; depth: number }
    | { kind: "list-item"; ordered: boolean; index: number; depth: number; runs: InlineRun[] }
    | { kind: "callout"; runs: InlineRun[] }
    | { kind: "table"; rows: TableRow[] }
    | { kind: "tr"; cells: TableCell[] }
    | { kind: "cell"; isHeader: boolean; runs: InlineRun[] };
  const ctx: BlockCtx[] = [];

  const currentRunSlot = (): InlineRun[] | null => {
    for (let i = ctx.length - 1; i >= 0; i--) {
      const c = ctx[i];
      if (
        c.kind === "paragraph" ||
        c.kind === "heading" ||
        c.kind === "list-item" ||
        c.kind === "callout" ||
        c.kind === "cell"
      ) {
        return c.runs;
      }
    }
    return null;
  };

  const pushText = (raw: string, opts?: { preserveNewlines?: boolean }) => {
    if (!raw) return;
    // Collapse internal whitespace but preserve at least one space between
    // runs. When `preserveNewlines` is set (e.g. from <br>), `\n` is kept
    // as a hard line break for pdfkit to honor at render time.
    const text = opts?.preserveNewlines
      ? raw.replace(/[ \t]+/g, " ") // collapse horizontal whitespace only
      : raw.replace(/\s+/g, " ");
    if (!text) return;

    const slot = currentRunSlot();
    if (!slot) {
      // Text outside any block — wrap in an implicit paragraph.
      if (text.trim() === "") return;
      ctx.push({ kind: "paragraph", runs: [] });
    }
    const target = currentRunSlot();
    if (!target) return;

    const run: InlineRun = {
      text,
      bold: boldStack.length > 0,
      italic: italicStack.length > 0,
      underline: underlineStack.length > 0 || linkStack.length > 0,
      link: linkStack.length > 0 ? linkStack[linkStack.length - 1] : undefined,
    };
    // Merge with previous run if formatting matches — keeps line-breaking clean.
    const prev = target[target.length - 1];
    if (
      prev &&
      prev.bold === run.bold &&
      prev.italic === run.italic &&
      prev.underline === run.underline &&
      prev.link === run.link
    ) {
      prev.text += run.text;
    } else {
      target.push(run);
    }
  };

  const flushTopBlock = () => {
    const top = ctx[ctx.length - 1];
    if (!top) return;
    if (top.kind === "list" || top.kind === "table" || top.kind === "tr") {
      // Don't pop container contexts on stray close/open boundaries — they're
      // popped only when their matching end tag is seen.
      return;
    }
    if (top.kind === "paragraph" && top.runs.length > 0) {
      blocks.push({ kind: "paragraph", runs: top.runs });
    } else if (top.kind === "heading" && top.runs.length > 0) {
      blocks.push({ kind: "heading", level: top.level ?? 2, runs: top.runs });
    } else if (top.kind === "list-item" && top.runs.length > 0) {
      blocks.push({
        kind: "list-item",
        ordered: top.ordered,
        index: top.index,
        depth: top.depth,
        runs: top.runs,
      });
    } else if (top.kind === "callout" && top.runs.length > 0) {
      blocks.push({ kind: "callout", runs: top.runs });
    } else if (top.kind === "cell") {
      // Cells can be flushed independently when </td> is seen; they flush
      // into the enclosing row context, not into blocks directly.
      for (let i = ctx.length - 2; i >= 0; i--) {
        const row = ctx[i];
        if (row.kind === "tr") {
          row.cells.push({ runs: top.runs, isHeader: top.isHeader });
          break;
        }
      }
    }
    ctx.pop();
  };

  const openListItem = () => {
    // Find enclosing list to infer ordering + depth.
    let ordered = false;
    let depth = 0;
    let listAt = -1;
    for (let i = ctx.length - 1; i >= 0; i--) {
      if (ctx[i].kind === "list") {
        listAt = i;
        ordered = (ctx[i] as Extract<BlockCtx, { kind: "list" }>).ordered;
        break;
      }
    }
    if (listAt === -1) {
      // Stray <li> — treat as paragraph.
      ctx.push({ kind: "paragraph", runs: [] });
      return;
    }
    const list = ctx[listAt] as Extract<BlockCtx, { kind: "list" }>;
    list.counter += 1;
    // Count nested lists for indent depth.
    for (let i = 0; i < ctx.length; i++) if (ctx[i].kind === "list") depth++;
    ctx.push({
      kind: "list-item",
      ordered,
      index: list.counter,
      depth: Math.max(0, depth - 1),
      runs: [],
    });
  };

  for (const tok of tokens) {
    if (tok.kind === "text") {
      pushText(tok.text ?? "");
      continue;
    }

    const tag = tok.tag!;
    if (tok.kind === "open") {
      // Inline formatting
      if (tag === "strong" || tag === "b") { boldStack.push(true); continue; }
      if (tag === "em" || tag === "i") { italicStack.push(true); continue; }
      if (tag === "u") { underlineStack.push(true); continue; }
      if (tag === "a") {
        // Whitelist URL schemes so an organizer pasting `javascript:` /
        // `data:` / `file:` from an untrusted source can't turn the PDF
        // into a phishing vector. Unknown schemes render as plain text
        // (empty href string on the run means no link annotation emitted).
        linkStack.push(sanitizeHref(tok.attrs?.href ?? ""));
        continue;
      }
      if (tag === "span") continue; // transparent

      // Block-level
      if (tag === "br") {
        pushText("\n", { preserveNewlines: true });
        continue;
      }
      if (tag === "hr") {
        flushTopBlock();
        blocks.push({ kind: "rule" });
        continue;
      }
      if (tag === "blockquote") {
        flushTopBlock();
        ctx.push({ kind: "callout", runs: [] });
        continue;
      }
      if (tag === "p" || tag === "div") {
        // Tiptap emits `<li><p>text</p></li>` and `<td><p>text</p></td>` —
        // if we flush on <p>, the enclosing li/cell becomes empty + stray
        // paragraph. Treat <p> as transparent inside list-items and cells.
        const top = ctx[ctx.length - 1];
        if (top && (top.kind === "list-item" || top.kind === "cell")) {
          continue;
        }
        flushTopBlock();
        ctx.push({ kind: "paragraph", runs: [] });
        continue;
      }
      if (tag === "table") {
        flushTopBlock();
        ctx.push({ kind: "table", rows: [] });
        continue;
      }
      if (tag === "tbody" || tag === "thead" || tag === "tfoot") {
        // Transparent containers — table rows live under them.
        continue;
      }
      if (tag === "tr") {
        // Close any open cell first, then open a row under the enclosing table.
        // If there's no table, create an implicit one so stray <tr> isn't lost.
        for (let i = ctx.length - 1; i >= 0; i--) {
          if (ctx[i].kind === "cell") {
            flushTopBlock();
            break;
          }
          if (ctx[i].kind === "table" || ctx[i].kind === "tr") break;
        }
        const hasTable = ctx.some((c) => c.kind === "table");
        if (!hasTable) ctx.push({ kind: "table", rows: [] });
        ctx.push({ kind: "tr", cells: [] });
        continue;
      }
      if (tag === "td" || tag === "th") {
        // Close any previously-open cell in the same row.
        for (let i = ctx.length - 1; i >= 0; i--) {
          if (ctx[i].kind === "cell") {
            flushTopBlock();
            break;
          }
          if (ctx[i].kind === "tr") break;
        }
        ctx.push({ kind: "cell", isHeader: tag === "th", runs: [] });
        continue;
      }
      if (/^h[1-6]$/.test(tag)) {
        flushTopBlock();
        ctx.push({ kind: "heading", level: Number(tag.slice(1)), runs: [] });
        continue;
      }
      if (tag === "ul" || tag === "ol") {
        flushTopBlock();
        ctx.push({ kind: "list", ordered: tag === "ol", counter: 0, depth: 0 });
        continue;
      }
      if (tag === "li") {
        flushTopBlock();
        openListItem();
        continue;
      }
      // Unknown tag — ignore structurally, still render inner text
      continue;
    }

    // close tag
    if (tag === "strong" || tag === "b") { boldStack.pop(); continue; }
    if (tag === "em" || tag === "i") { italicStack.pop(); continue; }
    if (tag === "u") { underlineStack.pop(); continue; }
    if (tag === "a") { linkStack.pop(); continue; }
    if (tag === "span") continue;

    if (tag === "p" || tag === "div") {
      // Mirror of the open-tag logic — transparent inside list-items and cells.
      const top = ctx[ctx.length - 1];
      if (top && (top.kind === "list-item" || top.kind === "cell")) {
        continue;
      }
      flushTopBlock();
      continue;
    }
    if (tag === "blockquote" || /^h[1-6]$/.test(tag) || tag === "li") {
      flushTopBlock();
      continue;
    }
    if (tag === "ul" || tag === "ol") {
      // Pop the list context.
      for (let i = ctx.length - 1; i >= 0; i--) {
        if (ctx[i].kind === "list") {
          ctx.splice(i, 1);
          break;
        }
      }
      continue;
    }
    if (tag === "td" || tag === "th") {
      // Close the cell — flushes its runs into the enclosing row.
      for (let i = ctx.length - 1; i >= 0; i--) {
        if (ctx[i].kind === "cell") {
          flushTopBlock();
          break;
        }
      }
      continue;
    }
    if (tag === "tr") {
      // Close the row — flush any open cell, then drain row into the table.
      for (let i = ctx.length - 1; i >= 0; i--) {
        if (ctx[i].kind === "cell") {
          flushTopBlock();
          break;
        }
        if (ctx[i].kind === "tr") break;
      }
      for (let i = ctx.length - 1; i >= 0; i--) {
        if (ctx[i].kind === "tr") {
          const row = ctx[i] as Extract<BlockCtx, { kind: "tr" }>;
          for (let j = i - 1; j >= 0; j--) {
            if (ctx[j].kind === "table") {
              (ctx[j] as Extract<BlockCtx, { kind: "table" }>).rows.push({ cells: row.cells });
              break;
            }
          }
          ctx.splice(i, 1);
          break;
        }
      }
      continue;
    }
    if (tag === "tbody" || tag === "thead" || tag === "tfoot") {
      continue;
    }
    if (tag === "table") {
      // Close any open cell/row first, then drain the table into blocks.
      for (let i = ctx.length - 1; i >= 0; i--) {
        if (ctx[i].kind === "cell") {
          flushTopBlock();
          break;
        }
        if (ctx[i].kind === "tr" || ctx[i].kind === "table") break;
      }
      for (let i = ctx.length - 1; i >= 0; i--) {
        if (ctx[i].kind === "tr") {
          const row = ctx[i] as Extract<BlockCtx, { kind: "tr" }>;
          for (let j = i - 1; j >= 0; j--) {
            if (ctx[j].kind === "table") {
              (ctx[j] as Extract<BlockCtx, { kind: "table" }>).rows.push({ cells: row.cells });
              break;
            }
          }
          ctx.splice(i, 1);
          break;
        }
      }
      for (let i = ctx.length - 1; i >= 0; i--) {
        if (ctx[i].kind === "table") {
          const tbl = ctx[i] as Extract<BlockCtx, { kind: "table" }>;
          if (tbl.rows.length > 0) blocks.push({ kind: "table", rows: tbl.rows });
          ctx.splice(i, 1);
          break;
        }
      }
      continue;
    }
    // Unknown close — ignore
  }

  // Flush anything left open at EOF.
  while (ctx.length > 0) {
    const top = ctx[ctx.length - 1];
    if (top.kind === "list") {
      ctx.pop();
      continue;
    }
    if (top.kind === "cell") {
      flushTopBlock();
      continue;
    }
    if (top.kind === "tr") {
      // Drain open row into enclosing table.
      for (let j = ctx.length - 2; j >= 0; j--) {
        if (ctx[j].kind === "table") {
          (ctx[j] as Extract<BlockCtx, { kind: "table" }>).rows.push({ cells: top.cells });
          break;
        }
      }
      ctx.pop();
      continue;
    }
    if (top.kind === "table") {
      if (top.rows.length > 0) blocks.push({ kind: "table", rows: top.rows });
      ctx.pop();
      continue;
    }
    flushTopBlock();
  }

  return blocks;
}

type PDFKitDoc = InstanceType<typeof import("pdfkit")>;

function pickFont(bold: boolean, italic: boolean): string {
  if (bold && italic) return "Helvetica-BoldOblique";
  if (bold) return "Helvetica-Bold";
  if (italic) return "Helvetica-Oblique";
  return "Helvetica";
}

/**
 * Substitute glyphs that aren't in Helvetica's WinAnsi encoding so they
 * render as legible ASCII in the PDF rather than missing-glyph boxes.
 * Applied only at PDF emission — the acceptance HTML view keeps the
 * original Unicode since browsers render it fine.
 */
function sanitizePdfText(s: string): string {
  const substituted = s
    .replace(/☐/g, "[ ]")
    .replace(/☑/g, "[x]")
    .replace(/☒/g, "[x]")
    // Non-WinAnsi dashes only — explicit enumeration so we don't accidentally
    // include en-dash (U+2013) or em-dash (U+2014), which ARE WinAnsi-safe and
    // get preserved by the allowlist below. Earlier `[‐-―]` was a range
    // U+2010..U+2015 that swallowed en/em dashes, making the allowlist dead.
    .replace(/[‐‑‒―]/g, "-")
    .replace(/[‘’]/g, "'") // smart single quotes
    .replace(/[“”]/g, '"') // smart double quotes
    .replace(/•/g, "•") // bullet (this IS in WinAnsi but belt-and-suspenders)
    .replace(/ /g, " "); // nbsp
  // Defensive sweep: codepoints outside printable ASCII + Latin-1
  // Supplement get replaced with "?". pdfkit's default WinAnsi encoder
  // throws on unencodable codepoints — this stops a stray emoji / CJK /
  // box-drawing char from nuking a whole batch of PDFs.
  let out = "";
  for (const ch of substituted) {
    const cp = ch.codePointAt(0) ?? 0;
    const safe =
      cp === 0x0a || cp === 0x09 ||
      (cp >= 0x20 && cp <= 0x7e) ||
      (cp >= 0xa0 && cp <= 0xff) ||
      cp === 0x2013 || cp === 0x2014 || // en/em dashes (WinAnsi-mapped)
      cp === 0x2022 || // bullet
      cp === 0x20ac || // euro
      cp === 0x2122; // trademark
    out += safe ? ch : "?";
  }
  return out;
}

const HEADING_FONT_SIZE = [20, 17, 15, 13, 12, 11]; // h1..h6
const BODY_FONT_SIZE = 11;
const BLOCK_SPACING = 6;
const HEADING_SPACING_TOP = 10;
const HEADING_SPACING_BOTTOM = 4;
const LIST_INDENT = 16;
const LINE_HEIGHT = 1.35;

function renderBlocksToDoc(doc: PDFKitDoc, blocks: Block[], contentWidth: number): void {
  for (const block of blocks) {
    if (block.kind === "rule") {
      doc.moveDown(0.3);
      const y = doc.y;
      doc.moveTo(doc.page.margins.left, y)
        .lineTo(doc.page.width - doc.page.margins.right, y)
        .strokeColor("#d1d5db")
        .lineWidth(1)
        .stroke()
        .strokeColor("black")
        .lineWidth(1);
      doc.moveDown(0.5);
      continue;
    }

    if (block.kind === "heading") {
      doc.moveDown(HEADING_SPACING_TOP / BODY_FONT_SIZE);
      const size = HEADING_FONT_SIZE[Math.min(block.level, 6) - 1] ?? 13;
      renderRunsLine(doc, block.runs, { defaultBold: true, fontSize: size, width: contentWidth });
      doc.moveDown(HEADING_SPACING_BOTTOM / BODY_FONT_SIZE);
      continue;
    }

    if (block.kind === "paragraph") {
      renderRunsLine(doc, block.runs, { fontSize: BODY_FONT_SIZE, width: contentWidth });
      doc.moveDown(BLOCK_SPACING / BODY_FONT_SIZE);
      continue;
    }

    if (block.kind === "list-item") {
      const indent = LIST_INDENT * (block.depth + 1);
      const marker = block.ordered ? `${block.index}.` : "•";
      const markerX = doc.page.margins.left + indent - LIST_INDENT + 4;
      const textX = doc.page.margins.left + indent;
      const itemWidth = contentWidth - indent;

      // Draw the marker with lineBreak:false so it doesn't advance y. Then
      // capture that baseline and render the runs at THE SAME y, at the
      // hanging-indent x. `renderRunsLine` will call doc.text which wraps
      // multi-line content correctly within `itemWidth`.
      const baselineY = doc.y;
      doc.font("Helvetica").fontSize(BODY_FONT_SIZE).fillColor("black");
      doc.text(marker, markerX, baselineY, { lineBreak: false });

      renderRunsLine(doc, block.runs, {
        fontSize: BODY_FONT_SIZE,
        width: itemWidth,
        x: textX,
        y: baselineY,
      });
      // renderRunsLine leaves doc.y advanced to the line after the wrapped text.
      doc.moveDown(0.2);
      continue;
    }

    if (block.kind === "callout") {
      renderCallout(doc, block.runs, contentWidth);
      continue;
    }

    if (block.kind === "table") {
      renderTable(doc, block.rows, contentWidth);
      continue;
    }
  }
}

function renderCallout(doc: PDFKitDoc, runs: InlineRun[], contentWidth: number): void {
  const leftBorderColor = "#d97706"; // amber — matches the app's callout style
  const bgColor = "#fffbeb";
  const padX = 12;
  const padY = 10;

  doc.moveDown(0.3);
  const startY = doc.y;

  // First-pass height estimate via a temporary render into a dry container:
  // pdfkit exposes `heightOfString` which honors width+lineGap. Sum across runs.
  let estimatedHeight = 0;
  const innerWidth = contentWidth - padX * 2;
  for (const run of runs) {
    doc.font(pickFont(run.bold, run.italic)).fontSize(BODY_FONT_SIZE);
    estimatedHeight += doc.heightOfString(sanitizePdfText(run.text), {
      width: innerWidth,
      lineGap: BODY_FONT_SIZE * (LINE_HEIGHT - 1),
    });
  }
  const boxHeight = Math.max(BODY_FONT_SIZE * LINE_HEIGHT + padY * 2, estimatedHeight + padY * 2);

  // Draw background + left border.
  doc
    .save()
    .rect(doc.page.margins.left, startY, contentWidth, boxHeight)
    .fill(bgColor)
    .rect(doc.page.margins.left, startY, 4, boxHeight)
    .fill(leftBorderColor)
    .restore();

  // Render text on top.
  doc.fillColor("#92400e");
  renderRunsLine(doc, runs, {
    fontSize: BODY_FONT_SIZE,
    width: innerWidth,
    x: doc.page.margins.left + padX,
    y: startY + padY,
  });
  doc.fillColor("black");

  // Advance past the box (heightOfString approximation may be off by a line).
  doc.y = Math.max(doc.y, startY + boxHeight);
  doc.moveDown(0.5);
}

function renderTable(doc: PDFKitDoc, rows: TableRow[], contentWidth: number): void {
  if (rows.length === 0) return;

  // Column count = widest row's cell count. Equal widths; no colspan support yet.
  const colCount = rows.reduce((max, r) => Math.max(max, r.cells.length), 0);
  if (colCount === 0) return;
  const colWidth = contentWidth / colCount;
  const padX = 6;
  const padY = 5;
  const borderColor = "#d1d5db";
  const headerBg = "#f3f4f6";

  doc.moveDown(0.4);
  const tableLeft = doc.page.margins.left;

  for (const row of rows) {
    // Measure row height = tallest cell.
    const cellHeights: number[] = [];
    for (let ci = 0; ci < colCount; ci++) {
      const cell = row.cells[ci];
      if (!cell) {
        cellHeights.push(BODY_FONT_SIZE * LINE_HEIGHT);
        continue;
      }
      let h = 0;
      for (const run of cell.runs) {
        doc
          .font(pickFont(run.bold || cell.isHeader, run.italic))
          .fontSize(BODY_FONT_SIZE);
        h += doc.heightOfString(sanitizePdfText(run.text), {
          width: colWidth - padX * 2,
          lineGap: BODY_FONT_SIZE * (LINE_HEIGHT - 1),
        });
      }
      cellHeights.push(Math.max(BODY_FONT_SIZE * LINE_HEIGHT, h));
    }
    const rowHeight = Math.max(...cellHeights) + padY * 2;

    // Page-break if the row won't fit.
    const bottom = doc.page.height - doc.page.margins.bottom;
    if (doc.y + rowHeight > bottom) {
      doc.addPage();
    }

    const rowY = doc.y;
    const isHeader = row.cells.every((c) => c.isHeader);

    // Background for header rows.
    if (isHeader) {
      doc.save().rect(tableLeft, rowY, contentWidth, rowHeight).fill(headerBg).restore();
    }

    // Cell contents.
    for (let ci = 0; ci < colCount; ci++) {
      const cell = row.cells[ci];
      const cellX = tableLeft + ci * colWidth;
      if (cell && cell.runs.length > 0) {
        renderRunsLine(doc, cell.runs, {
          fontSize: BODY_FONT_SIZE,
          width: colWidth - padX * 2,
          defaultBold: cell.isHeader,
          x: cellX + padX,
          y: rowY + padY,
        });
      }
    }

    // Borders: outer rectangle + vertical column dividers.
    doc.strokeColor(borderColor).lineWidth(0.5);
    doc.rect(tableLeft, rowY, contentWidth, rowHeight).stroke();
    for (let ci = 1; ci < colCount; ci++) {
      doc
        .moveTo(tableLeft + ci * colWidth, rowY)
        .lineTo(tableLeft + ci * colWidth, rowY + rowHeight)
        .stroke();
    }
    doc.strokeColor("black").lineWidth(1);

    doc.x = tableLeft;
    doc.y = rowY + rowHeight;
  }

  doc.moveDown(0.5);
}

function renderRunsLine(
  doc: PDFKitDoc,
  runs: InlineRun[],
  opts: {
    fontSize: number;
    width: number;
    defaultBold?: boolean;
    x?: number;
    y?: number;
  },
): void {
  if (runs.length === 0) return;

  if (opts.x !== undefined && opts.y !== undefined) {
    doc.x = opts.x;
    doc.y = opts.y;
  }

  doc.fillColor("black").fontSize(opts.fontSize);

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const isLast = i === runs.length - 1;
    const font = pickFont(run.bold || !!opts.defaultBold, run.italic);
    doc.font(font);

    const color = run.link ? "#00aade" : "black";
    doc.fillColor(color);

    doc.text(sanitizePdfText(run.text), {
      continued: !isLast,
      underline: run.underline,
      width: opts.width,
      lineGap: opts.fontSize * (LINE_HEIGHT - 1),
      link: run.link || undefined,
    });
  }
  doc.fillColor("black");
}

/**
 * Generate a personalized speaker agreement PDF from the event's inline
 * HTML body (`Event.speakerAgreementHtml`). Preferred path when no .docx
 * template is uploaded.
 *
 * Returns `null` when the event/speaker pair can't be resolved. Throws on
 * PDF render errors so the caller can surface them.
 *
 * Uses PDF's built-in Helvetica — no TTF shipping, no HTML-parsing deps.
 * Supported HTML: <p>, <h1>..<h6>, <ul>, <ol>, <li>, <strong>/<b>,
 * <em>/<i>, <u>, <a>, <br>, <hr>, <blockquote>, <div>, <span>. Other tags
 * (<img>, <table>…) are flattened to their text content.
 */
/**
 * Generic agreement HTML → PDF renderer shared by the speaker + presenter
 * agreements. Takes ALREADY-MERGED HTML and paints an A4 document with a
 * centered heading, the parsed HTML body, and a two-column signature block.
 * Callers own token-merging + filename derivation. (Lives here because the
 * private `renderBlocksToDoc` HTML painter + its helpers are module-scoped in
 * this file; presenter-agreement.ts imports this rather than duplicating ~250
 * lines of pdfkit block rendering.)
 */
/** A letterhead image ready to draw: raw bytes + pixel dimensions. */
export interface AgreementPdfImage {
  buffer: Buffer;
  width: number;
  height: number;
}

export interface AgreementPdfOptions {
  /** Already token-merged agreement HTML. */
  html: string;
  /** PDF metadata Title. */
  docTitle: string;
  /** PDF metadata Author. */
  docAuthor: string;
  /** Large centered heading at the top of page 1. */
  headingTitle: string;
  /** Muted subtitle under the heading (usually the event name). */
  headingSubtitle: string;
  /**
   * The sole signer (July 17, 2026, organizer request): only the speaker /
   * presenter signs — no organizer counter-signature column. The block leaves
   * generous blank space above the line so the signer can insert an
   * e-signature into the PDF.
   */
  signatureLabel: string;
  signatureName: string;
  /** Letterhead banner drawn edge-to-edge at the top of EVERY page. */
  headerImage?: AgreementPdfImage | null;
  /** Letterhead banner drawn edge-to-edge at the bottom of EVERY page. */
  footerImage?: AgreementPdfImage | null;
}

// A4 in points.
const AGREEMENT_PAGE_WIDTH = 595.28;
const AGREEMENT_PAGE_HEIGHT = 841.89;
// Height caps so a mis-sized (e.g. square) upload can't swallow the content
// area — a capped image scales down preserving aspect and centers.
const AGREEMENT_HEADER_MAX_HEIGHT = 200;
const AGREEMENT_FOOTER_MAX_HEIGHT = 150;
// Breathing room between a letterhead image and the text content.
const AGREEMENT_IMAGE_CONTENT_GAP = 24;

interface PlacedLetterheadImage {
  buffer: Buffer;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Scale a letterhead image to full page width (edge-to-edge), capped at
 * maxHeight — a cap shrinks it proportionally and centers it horizontally.
 * `y` is resolved by the caller (0 for header, pageHeight − height for footer).
 */
export function placeLetterheadImage(
  img: AgreementPdfImage,
  maxHeight: number,
): { x: number; width: number; height: number } {
  const fullWidthHeight = AGREEMENT_PAGE_WIDTH * (img.height / img.width);
  if (fullWidthHeight <= maxHeight) {
    return { x: 0, width: AGREEMENT_PAGE_WIDTH, height: fullWidthHeight };
  }
  const width = maxHeight * (img.width / img.height);
  return { x: (AGREEMENT_PAGE_WIDTH - width) / 2, width, height: maxHeight };
}

export async function renderAgreementHtmlToPdf(opts: AgreementPdfOptions): Promise<Buffer> {
  // Lazy import — pdfkit is ~2MB. Only load when actually rendering.
  const PDFDocument = (await import("pdfkit")).default;

  const blocks = parseHtmlToBlocks(opts.html);

  // Letterhead layout is computed BEFORE the document exists because the
  // image heights determine the content margins on every page.
  const header: PlacedLetterheadImage | null = opts.headerImage
    ? { buffer: opts.headerImage.buffer, y: 0, ...placeLetterheadImage(opts.headerImage, AGREEMENT_HEADER_MAX_HEIGHT) }
    : null;
  const footerPlacement = opts.footerImage
    ? placeLetterheadImage(opts.footerImage, AGREEMENT_FOOTER_MAX_HEIGHT)
    : null;
  const footer: PlacedLetterheadImage | null =
    opts.footerImage && footerPlacement
      ? { buffer: opts.footerImage.buffer, y: AGREEMENT_PAGE_HEIGHT - footerPlacement.height, ...footerPlacement }
      : null;

  const doc = new PDFDocument({
    size: "A4",
    margins: {
      top: header ? header.height + AGREEMENT_IMAGE_CONTENT_GAP : 60,
      bottom: footer ? footer.height + AGREEMENT_IMAGE_CONTENT_GAP : 60,
      left: 60,
      right: 60,
    },
    info: { Title: opts.docTitle, Author: opts.docAuthor },
  });

  // Drawn on page 1 below and on every auto/manual page break via pageAdded.
  // doc.image with explicit x/y does not move the text cursor, so drawing
  // mid-flow (pdfkit fires pageAdded during text overflow) is safe. A corrupt
  // image must not kill the agreement send: first failure logs + disables
  // that slot for the rest of the document.
  let headerBroken = false;
  let footerBroken = false;
  const drawLetterhead = () => {
    if (header && !headerBroken) {
      try {
        doc.image(header.buffer, header.x, header.y, { width: header.width, height: header.height });
      } catch (err) {
        headerBroken = true;
        apiLogger.warn({ err, msg: "agreement:pdf-header-image-draw-failed" });
      }
    }
    if (footer && !footerBroken) {
      try {
        doc.image(footer.buffer, footer.x, footer.y, { width: footer.width, height: footer.height });
      } catch (err) {
        footerBroken = true;
        apiLogger.warn({ err, msg: "agreement:pdf-footer-image-draw-failed" });
      }
    }
  };
  doc.on("pageAdded", drawLetterhead);
  drawLetterhead();

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    doc.on("end", () => resolve());
    doc.on("error", reject);
  });

  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // Document title.
  doc.font("Helvetica-Bold").fontSize(22).fillColor("black");
  doc.text(opts.headingTitle, { align: "center" });
  doc.font("Helvetica").fontSize(12).fillColor("#555");
  doc.text(opts.headingSubtitle, { align: "center" });
  doc.fillColor("black").moveDown(1.2);

  try {
    renderBlocksToDoc(doc, blocks, contentWidth);
  } catch (err) {
    apiLogger.error({ err, msg: "agreement:pdf-render-failed" });
    doc.end();
    throw new Error("Failed to render agreement PDF");
  }

  // Signature block — single signer (the speaker / presenter), no organizer
  // counter-signature. ~110pt tall including the 64pt e-signature gap. Text
  // auto-paginates in pdfkit but the hand-drawn line does not — break to a
  // fresh page up front if the whole block can't fit, so the line never lands
  // below the footer letterhead.
  const halfWidth = contentWidth / 2 - 10;
  const leftX = doc.page.margins.left;
  const E_SIGN_GAP = 64;
  const BLOCK_HEIGHT = 14 + 16 + E_SIGN_GAP + 18;
  doc.moveDown(2);
  if (doc.y + BLOCK_HEIGHT > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
  const sigY = doc.y;

  doc.font("Helvetica-Bold").fontSize(11);
  doc.text(opts.signatureLabel, leftX, sigY, { width: halfWidth });
  doc.font("Helvetica").fontSize(11);
  doc.text(opts.signatureName, leftX, doc.y, { width: halfWidth });

  const lineY = doc.y + E_SIGN_GAP;
  doc
    .moveTo(leftX, lineY)
    .lineTo(leftX + halfWidth, lineY)
    .strokeColor("#9ca3af")
    .stroke()
    .strokeColor("black");
  doc.font("Helvetica").fontSize(9).fillColor("#6b7280");
  doc.text("Signature", leftX, lineY + 4, { width: halfWidth });
  doc.fillColor("black");

  doc.end();
  await done;

  return Buffer.concat(chunks);
}

/**
 * Load a stored letterhead image for rendering: same path-traversal guard as
 * the .docx template, magic-byte re-check (the file on disk, not the upload
 * claim, is what pdfkit embeds), and dimension probe. Failure-isolated — any
 * problem logs a warn and returns null so the agreement still renders/sends
 * without the letterhead rather than blocking the email. Shared with the
 * presenter agreement (presenter-agreement.ts).
 */
export async function loadAgreementPdfImage(
  url: string | null,
  eventId: string,
  slot: AgreementPdfImageSlot,
): Promise<AgreementPdfImage | null> {
  if (!url) return null;
  try {
    const abs = resolveTemplatePath(url);
    if (!abs) {
      apiLogger.warn({ msg: "agreement:pdf-image-path-rejected", eventId, slot, url });
      return null;
    }
    const buffer = await fs.readFile(abs);
    const format = sniffAgreementImageFormat(buffer);
    if (!format) {
      apiLogger.warn({ msg: "agreement:pdf-image-not-png-or-jpeg", eventId, slot });
      return null;
    }
    const dims = probeImageDimensions(buffer, format);
    if (!dims) {
      apiLogger.warn({ msg: "agreement:pdf-image-dimensions-unreadable", eventId, slot });
      return null;
    }
    return { buffer, ...dims };
  } catch (err) {
    apiLogger.warn({ err, msg: "agreement:pdf-image-load-failed", eventId, slot });
    return null;
  }
}

export async function generateSpeakerAgreementPdf(opts: {
  eventId: string;
  speakerId: string;
}): Promise<{ buffer: Buffer; filename: string } | null> {
  const { eventId, speakerId } = opts;

  const resolved = await resolveAgreementHtmlForSpeaker(eventId, speakerId);
  if (!resolved) return null;

  const event = await db.event.findFirst({
    where: { id: eventId },
    select: {
      slug: true,
      name: true,
      speakerAgreementPdfHeaderImage: true,
      speakerAgreementPdfFooterImage: true,
    },
  });
  if (!event) return null;

  const [headerImage, footerImage] = await Promise.all([
    loadAgreementPdfImage(event.speakerAgreementPdfHeaderImage, eventId, "header"),
    loadAgreementPdfImage(event.speakerAgreementPdfFooterImage, eventId, "footer"),
  ]);

  const buffer = await renderAgreementHtmlToPdf({
    html: resolved.html,
    docTitle: `Speaker Agreement — ${event.name}`,
    docAuthor: resolved.context.organizationName,
    headingTitle: "Speaker Agreement",
    headingSubtitle: event.name,
    signatureLabel: "Speaker",
    signatureName: resolved.context.speakerName,
    headerImage,
    footerImage,
  });

  const filename = `agreement-${slugify(event.slug)}-${slugify(resolved.context.lastName || "speaker")}.pdf`;
  return { buffer, filename };
}

/**
 * Decide which attachment the agreement email should carry, preferring the
 * uploaded .docx (explicit organizer choice) over the inline HTML→PDF
 * default. Returns `null` with a reason string when neither is available.
 *
 * `hasInlineHtml` accepts the raw `Event.speakerAgreementHtml` column — we
 * treat a non-null non-empty string OR an unset field (defaults to seeded
 * HTML on event create) as "inline is available". In practice every event
 * created after April 2026 has this seeded, so this mostly short-circuits
 * to `"pdf"` unless the organizer explicitly uploaded a .docx.
 */
export function pickAgreementAttachmentMode(input: {
  hasDocxTemplate: boolean;
  hasInlineHtml: boolean;
}): "docx" | "pdf" | null {
  if (input.hasDocxTemplate) return "docx";
  if (input.hasInlineHtml) return "pdf";
  return null;
}

export const SPEAKER_AGREEMENT_DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const SPEAKER_AGREEMENT_TEMPLATE_MAX_SIZE = 2 * 1024 * 1024; // 2 MB
const DOCX_MAGIC_BYTES = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04 (DOCX is a zip)

export class SpeakerAgreementTemplateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "SpeakerAgreementTemplateError";
  }
}

/**
 * Validate + persist a speaker-agreement .docx template for an event.
 *
 * Factored out of `POST /api/events/[eventId]/speaker-agreement-template` so
 * that both the dashboard upload route AND the MCP `upload_speaker_agreement_template`
 * tool can share the exact same zip-magic-byte check, 2MB cap, file-write,
 * previous-file cleanup, and audit-log write. One source of truth — the two
 * surfaces can't drift apart silently.
 *
 * Throws `SpeakerAgreementTemplateError` with a code for predictable callers.
 * The caller is responsible for auth + rate limiting. Access is enforced
 * here by requiring the `organizationId` match on the event lookup.
 */
export async function saveSpeakerAgreementTemplate({
  eventId,
  organizationId,
  buffer,
  filename,
  actorUserId,
}: {
  eventId: string;
  organizationId: string;
  buffer: Buffer;
  filename: string;
  actorUserId: string;
}): Promise<SpeakerAgreementTemplateMeta> {
  if (buffer.length > SPEAKER_AGREEMENT_TEMPLATE_MAX_SIZE) {
    throw new SpeakerAgreementTemplateError(
      "TEMPLATE_TOO_LARGE",
      `Template must be under ${Math.round(SPEAKER_AGREEMENT_TEMPLATE_MAX_SIZE / 1024 / 1024)}MB`,
    );
  }

  const isZip =
    buffer.length >= DOCX_MAGIC_BYTES.length &&
    DOCX_MAGIC_BYTES.every((b, i) => buffer[i] === b);
  if (!isZip) {
    apiLogger.warn({ msg: "agreement-template:invalid-magic-bytes", actorUserId });
    throw new SpeakerAgreementTemplateError(
      "INVALID_DOCX",
      "File content is not a valid .docx document (missing zip magic bytes)",
    );
  }

  const event = await db.event.findFirst({
    where: { id: eventId, organizationId },
    select: { id: true, speakerAgreementTemplate: true },
  });
  if (!event) {
    throw new SpeakerAgreementTemplateError(
      "EVENT_NOT_FOUND",
      `Event ${eventId} not found or access denied`,
    );
  }

  const dirRel = path.join("uploads", "agreements", eventId);
  const dirAbs = path.resolve(process.cwd(), "public", dirRel);
  await fs.mkdir(dirAbs, { recursive: true });

  const storedFilename = `${randomUUID()}.docx`;
  const fileAbs = path.join(dirAbs, storedFilename);
  await fs.writeFile(fileAbs, buffer);

  // Best-effort previous-file cleanup. Path-traversal guarded.
  const previous = event.speakerAgreementTemplate as SpeakerAgreementTemplateMeta | null;
  await unlinkAgreementUpload(previous?.url, "agreement-template:previous-unlink-failed");

  const safeFilename =
    filename && filename.trim() ? filename.trim().slice(0, 255) : "template.docx";
  const meta: SpeakerAgreementTemplateMeta = {
    url: `/${dirRel.replace(/\\/g, "/")}/${storedFilename}`,
    filename: safeFilename,
    uploadedAt: new Date().toISOString(),
    uploadedBy: actorUserId,
  };

  await db.event.update({
    where: { id: eventId },
    data: { speakerAgreementTemplate: meta as unknown as Prisma.InputJsonValue },
  });

  return meta;
}
