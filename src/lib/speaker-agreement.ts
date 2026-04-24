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
        city: true,
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

interface InlineRun {
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

type Block =
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
    .replace(/[‐-―]/g, "-") // various dashes → ASCII hyphen (— is already WinAnsi but ‐-– etc. aren't always)
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
