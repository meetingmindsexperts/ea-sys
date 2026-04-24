import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { apiLogger } from "./logger";
import { formatPersonName, getTitleLabel, formatDate, formatDateTime, slugify } from "./utils";
import { DEFAULT_SPEAKER_AGREEMENT_HTML } from "./default-terms";

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

// ─────────────────────────────────────────────────────────────────────────────
// Inline HTML → PDF path (preferred when no .docx template is uploaded)
// ─────────────────────────────────────────────────────────────────────────────

export const SPEAKER_AGREEMENT_PDF_MIME = "application/pdf";

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
    eventName: ctx.eventName,
    eventStartDate: ctx.eventStartDate,
    eventEndDate: ctx.eventEndDate,
    eventDate: ctx.eventDate,
    eventVenue: ctx.eventVenue,
    eventAddress: ctx.eventAddress,
    organizationName: ctx.organizationName,
    sessionTitles: ctx.sessionTitles,
    topicTitles: ctx.topicTitles,
    sessionDateTime: ctx.sessionDateTime,
    trackNames: ctx.trackNames,
    role: ctx.role,
    // These two carry HTML on purpose for the email body; for the agreement
    // body we expose the plain-text variants under the same names.
    presentationDetails: ctx.presentationDetailsText,
    presentationDetailsText: ctx.presentationDetailsText,
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

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
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

interface InlineRun {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  link?: string;
}

type Block =
  | { kind: "paragraph"; runs: InlineRun[] }
  | { kind: "heading"; level: number; runs: InlineRun[] }
  | { kind: "list-item"; ordered: boolean; index: number; depth: number; runs: InlineRun[] }
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
    | { kind: "list-item"; ordered: boolean; index: number; depth: number; runs: InlineRun[] };
  const ctx: BlockCtx[] = [];

  const currentRunSlot = (): InlineRun[] | null => {
    for (let i = ctx.length - 1; i >= 0; i--) {
      const c = ctx[i];
      if (c.kind === "paragraph" || c.kind === "heading" || c.kind === "list-item") {
        return c.runs;
      }
    }
    return null;
  };

  const pushText = (raw: string) => {
    if (!raw) return;
    // Collapse internal whitespace but preserve at least one space between runs.
    const text = raw.replace(/\s+/g, " ");
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
    if (top.kind === "list") {
      // Don't pop list containers on stray close/open boundaries — they're
      // popped only when their matching </ul>/</ol> is seen.
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
        linkStack.push(tok.attrs?.href ?? "");
        continue;
      }
      if (tag === "span") continue; // transparent

      // Block-level
      if (tag === "br") {
        pushText("\n");
        continue;
      }
      if (tag === "hr") {
        flushTopBlock();
        blocks.push({ kind: "rule" });
        continue;
      }
      if (tag === "p" || tag === "blockquote" || tag === "div") {
        flushTopBlock();
        ctx.push({ kind: "paragraph", runs: [] });
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

    if (tag === "p" || tag === "blockquote" || tag === "div" || /^h[1-6]$/.test(tag) || tag === "li") {
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
    // Unknown close — ignore
  }

  // Flush anything left open at EOF.
  while (ctx.length > 0) {
    const top = ctx[ctx.length - 1];
    if (top.kind === "list") {
      ctx.pop();
    } else {
      flushTopBlock();
    }
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
      const startX = doc.page.margins.left + indent - LIST_INDENT + 4;
      doc.font("Helvetica").fontSize(BODY_FONT_SIZE).fillColor("black");
      doc.text(marker, startX, doc.y, { continued: false, lineBreak: false });
      // Render runs on the same line with a hanging indent.
      const itemWidth = contentWidth - indent;
      renderRunsLine(doc, block.runs, {
        fontSize: BODY_FONT_SIZE,
        width: itemWidth,
        x: doc.page.margins.left + indent,
        y: doc.y - BODY_FONT_SIZE * LINE_HEIGHT, // stay on same line as marker
      });
      doc.moveDown(0.2);
      continue;
    }
  }
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

    doc.text(run.text, {
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
export async function generateSpeakerAgreementPdf(opts: {
  eventId: string;
  speakerId: string;
}): Promise<{ buffer: Buffer; filename: string } | null> {
  const { eventId, speakerId } = opts;

  const resolved = await resolveAgreementHtmlForSpeaker(eventId, speakerId);
  if (!resolved) return null;

  const event = await db.event.findFirst({
    where: { id: eventId },
    select: { slug: true, name: true },
  });
  if (!event) return null;

  // Lazy import — pdfkit is ~2MB. Only load when actually rendering.
  const PDFDocument = (await import("pdfkit")).default;

  const blocks = parseHtmlToBlocks(resolved.html);

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 60, bottom: 60, left: 60, right: 60 },
    info: {
      Title: `Speaker Agreement — ${event.name}`,
      Author: resolved.context.organizationName,
    },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    doc.on("end", () => resolve());
    doc.on("error", reject);
  });

  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // Document title.
  doc.font("Helvetica-Bold").fontSize(22).fillColor("black");
  doc.text("Speaker Agreement", { align: "center" });
  doc.font("Helvetica").fontSize(12).fillColor("#555");
  doc.text(event.name, { align: "center" });
  doc.fillColor("black").moveDown(1.2);

  try {
    renderBlocksToDoc(doc, blocks, contentWidth);
  } catch (err) {
    apiLogger.error({ err, msg: "speaker-agreement:pdf-render-failed", eventId, speakerId });
    doc.end();
    throw new Error("Failed to render speaker agreement PDF");
  }

  // Signature block.
  doc.moveDown(2);
  const sigY = doc.y;
  const halfWidth = contentWidth / 2 - 10;
  const leftX = doc.page.margins.left;
  const rightX = doc.page.margins.left + contentWidth / 2 + 10;

  doc.font("Helvetica-Bold").fontSize(11);
  doc.text("Speaker", leftX, sigY, { width: halfWidth });
  doc.text("Organizer", rightX, sigY, { width: halfWidth });

  doc.font("Helvetica").fontSize(11);
  doc.text(resolved.context.speakerName, leftX, doc.y, { width: halfWidth });
  const afterNameY = doc.y;
  doc.text(resolved.context.organizationName, rightX, sigY + 16, { width: halfWidth });

  doc.moveDown(1.5);
  const lineY = Math.max(doc.y, afterNameY + 30);
  doc
    .moveTo(leftX, lineY)
    .lineTo(leftX + halfWidth, lineY)
    .moveTo(rightX, lineY)
    .lineTo(rightX + halfWidth, lineY)
    .strokeColor("#9ca3af")
    .stroke()
    .strokeColor("black");
  doc.font("Helvetica").fontSize(9).fillColor("#6b7280");
  doc.text("Signature", leftX, lineY + 4, { width: halfWidth });
  doc.text("Signature", rightX, lineY + 4, { width: halfWidth });
  doc.fillColor("black");

  doc.end();
  await done;

  const buffer = Buffer.concat(chunks);
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
  if (previous?.url?.startsWith("/uploads/agreements/")) {
    const previousAbs = path.resolve(process.cwd(), "public", previous.url.replace(/^\/+/, ""));
    const expectedRoot = path.resolve(process.cwd(), "public", "uploads", "agreements");
    if (previousAbs.startsWith(expectedRoot + path.sep)) {
      await fs.unlink(previousAbs).catch((err) =>
        apiLogger.warn({ err, msg: "agreement-template:previous-unlink-failed", previousAbs }),
      );
    }
  }

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
