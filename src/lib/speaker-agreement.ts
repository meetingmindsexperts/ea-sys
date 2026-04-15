import fs from "fs/promises";
import path from "path";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { db } from "./db";
import { apiLogger } from "./logger";
import { formatPersonName, getTitleLabel, formatDate, formatDateTime, slugify } from "./utils";

export interface SpeakerAgreementTemplateMeta {
  url: string;
  filename: string;
  uploadedAt: string;
  uploadedBy: string;
}

const SESSION_ROLE_LABELS: Record<string, string> = {
  SPEAKER: "Speaker",
  MODERATOR: "Moderator",
  CHAIRPERSON: "Chairperson",
  PANELIST: "Panelist",
};

export interface SpeakerEmailContext {
  // Speaker identity
  title: string;
  firstName: string;
  lastName: string;
  speakerName: string;
  speakerEmail: string;

  // Event details
  eventName: string;
  eventSlug: string;
  eventStartDate: string;
  eventEndDate: string;
  eventDate: string;
  eventVenue: string;
  eventAddress: string;
  organizationName: string;

  // Presentation details
  sessionTitles: string;
  topicTitles: string;
  sessionDateTime: string;
  trackNames: string;
  role: string;

  // Pre-rendered HTML/text blocks for email templates
  presentationDetails: string;
  presentationDetailsText: string;
}

interface SpeakerEmailContextRow {
  speaker: {
    title: string | null;
    firstName: string;
    lastName: string;
    email: string;
    sessions: Array<{
      role: string;
      session: {
        name: string;
        startTime: Date;
        endTime: Date;
        location: string | null;
        track: { name: string } | null;
      };
    }>;
    topicSpeakers: Array<{
      topic: {
        title: string;
        session: {
          name: string;
          startTime: Date;
          track: { name: string } | null;
        };
      };
    }>;
  };
  event: {
    name: string;
    slug: string;
    startDate: Date;
    endDate: Date;
    venue: string | null;
    address: string | null;
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
        venue: true,
        address: true,
        organization: { select: { name: true } },
      },
    }),
  ]);

  if (!speaker || !event) return null;

  return { speaker, event } as SpeakerEmailContextRow;
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
  const sessionDateTime = firstSession ? formatDateTime(firstSession.startTime) : "";

  const trackSet = new Set<string>();
  for (const s of sessionRows) if (s.session.track?.name) trackSet.add(s.session.track.name);
  for (const t of topicRows) if (t.topic.session.track?.name) trackSet.add(t.topic.session.track.name);
  const trackNames = Array.from(trackSet).join(", ");

  const roleSet = new Set<string>();
  for (const s of sessionRows) {
    const label = SESSION_ROLE_LABELS[s.role] ?? s.role;
    if (label) roleSet.add(label);
  }
  const role = Array.from(roleSet).join(", ");

  // Pre-rendered HTML block — rendered via rawHtmlKeys so it's not escaped.
  // Inline styles only (no <style> blocks) so juice / email clients render correctly.
  const rows: Array<[string, string]> = [];
  if (sessionTitles) rows.push(["Session", sessionTitles.replace(/\n/g, "<br/>")]);
  if (topicTitles) rows.push(["Topic", topicTitles.replace(/\n/g, "<br/>")]);
  if (sessionDateTime) rows.push(["Date &amp; Time", sessionDateTime]);
  if (trackNames) rows.push(["Track", trackNames]);
  if (role) rows.push(["Role", role]);

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
    ? rows.map(([label, value]) => `${label}: ${value.replace(/<br\/>/g, ", ").replace(/&amp;/g, "&")}`).join("\n")
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

  return {
    title: getTitleLabel(speaker.title),
    firstName: speaker.firstName,
    lastName: speaker.lastName,
    speakerName: formatPersonName(speaker.title, speaker.firstName, speaker.lastName),
    speakerEmail: speaker.email,

    eventName: event.name,
    eventSlug: event.slug,
    eventStartDate: formatDate(event.startDate),
    eventEndDate: formatDate(event.endDate),
    eventDate: formatDate(event.startDate),
    eventVenue: event.venue ?? "TBA",
    eventAddress: event.address ?? "",
    organizationName: event.organization.name,

    sessionTitles: presentation.sessionTitles,
    topicTitles: presentation.topicTitles,
    sessionDateTime: presentation.sessionDateTime,
    trackNames: presentation.trackNames,
    role: presentation.role,

    presentationDetails: presentation.html,
    presentationDetailsText: presentation.text,
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

export const SPEAKER_AGREEMENT_DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
