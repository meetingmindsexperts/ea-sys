/**
 * Display shaping for a captured email's plain text (Nov 2, 2026).
 *
 * WHY: the inbox showed `textBody` verbatim, and verbatim is unreadable for
 * two common shapes. A newsletter's text part is mostly blank lines (a 10times
 * mailer ran for screens on 2,500 characters), and a reply carries the whole
 * earlier conversation under it, so a sponsor thread grows by every previous
 * message each time someone answers. On prod, 3 of the first 13 captured
 * messages had long blank runs and 4 repeated their history.
 *
 * Display only: the stored body is never changed, so the full text is always
 * one click away ("Show earlier messages", "Show more").
 *
 * Client-safe: pure string work, no Node APIs.
 */

/** Lines a long message shows before "Show more". */
export const COLLAPSED_LINES = 20;
/** Characters a long message shows before "Show more" (a few very long lines). */
export const COLLAPSED_CHARS = 1500;

/**
 * Trim each line, drop Outlook's redundant `<mailto:...>` annotations, and
 * collapse every run of blank lines into one.
 */
export function tidyEmailText(text: string): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/<mailto:[^>\s]*>/gi, "")
    .split("\n")
    .map((line) => line.trim());

  const out: string[] = [];
  for (const line of lines) {
    if (line === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

const OUTLOOK_SEPARATOR = /^_{10,}$/;
const ORIGINAL_MESSAGE = /^-{2,}\s*Original Message\s*-{2,}$/i;

/** "On <date>, <person> wrote:", which Gmail and Apple Mail wrap over up to 3 lines. */
function isOnWroteAt(lines: string[], i: number): boolean {
  if (!/^On\s/.test(lines[i]!)) return false;
  const joined = lines.slice(i, i + 3).join(" ");
  return /^On\s.{5,300}?\swrote:$/.test(joined.slice(0, joined.indexOf("wrote:") + "wrote:".length));
}

/** Outlook's header block: "From: ..." with "Sent:" or "Date:" within the next lines. */
function isOutlookHeaderAt(lines: string[], i: number): boolean {
  if (!/^From:\s?\S/.test(lines[i]!)) return false;
  return lines.slice(i + 1, i + 4).some((l) => /^(Sent|Date):\s?\S/.test(l));
}

/** Gmail-style quoting: every remaining non-blank line starts with ">". */
function isQuotedTailAt(lines: string[], i: number): boolean {
  if (!lines[i]!.startsWith(">")) return false;
  return lines.slice(i).every((l) => l === "" || l.startsWith(">"));
}

/** Index of the line where the earlier conversation starts, or -1. */
function quoteStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (ORIGINAL_MESSAGE.test(line)) return i;
    if (OUTLOOK_SEPARATOR.test(line) && isOutlookHeaderAt(lines, i + 1)) return i;
    if (isOutlookHeaderAt(lines, i) || isOnWroteAt(lines, i) || isQuotedTailAt(lines, i)) return i;
  }
  return -1;
}

export interface SplitEmailText {
  /** What this message itself says. */
  body: string;
  /** The earlier conversation it carries, or null when there is none. */
  quoted: string | null;
}

/**
 * Split a TIDIED text into the new part and the quoted history. When nothing
 * comes before the history (a bare forward), there is nothing to hide it
 * behind, so the whole text stays the body.
 */
export function splitQuotedHistory(text: string): SplitEmailText {
  const lines = text.split("\n");
  const start = quoteStart(lines);
  if (start === -1) return { body: text, quoted: null };

  const body = lines.slice(0, start).join("\n").trim();
  if (body === "") return { body: text, quoted: null };
  return { body, quoted: lines.slice(start).join("\n").trim() };
}

/** The first part of a long text and whether anything was cut. */
export function collapseLongText(text: string): { shown: string; truncated: boolean } {
  const lines = text.split("\n");
  let shown = lines.length > COLLAPSED_LINES ? lines.slice(0, COLLAPSED_LINES).join("\n") : text;
  if (shown.length > COLLAPSED_CHARS) {
    const cut = shown.lastIndexOf(" ", COLLAPSED_CHARS);
    shown = shown.slice(0, cut > COLLAPSED_CHARS / 2 ? cut : COLLAPSED_CHARS);
  }
  return shown.length < text.length ? { shown: shown.trimEnd(), truncated: true } : { shown: text, truncated: false };
}

export type TextPart = { kind: "text"; text: string } | { kind: "link"; href: string; label: string };

/** Links longer than this show as their host instead. */
const LONG_LINK = 60;
const URL_PATTERN = /<?(https?:\/\/[^\s<>"]+)>?/g;

function linkLabel(href: string): string {
  if (href.length <= LONG_LINK) return href;
  try {
    return `${new URL(href).hostname}/…`;
  } catch {
    return `${href.slice(0, LONG_LINK)}…`;
  }
}

/**
 * Split text into plain runs and http(s) links, a long link labelled by its
 * host. Outlook writes a link as `text<https://...>`, so the angle brackets
 * go with it. Only http and https become links: the text is the sender's.
 */
export function linkifyEmailText(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const href = match[1]!.replace(/[.,;:!?)\]]+$/, "");
    const at = match.index!;
    const end = at + match[0].indexOf(match[1]!) + href.length;
    const consumed = match[0].endsWith(">") && href === match[1] ? at + match[0].length : end;
    // `text<https://...>` loses its brackets, so keep the two words apart.
    const glued = match[0].startsWith("<") && at > 0 && /\S/.test(text[at - 1]!);
    const before = text.slice(last, at) + (glued ? " " : "");
    if (before) parts.push({ kind: "text", text: before });
    parts.push({ kind: "link", href, label: linkLabel(href) });
    last = consumed;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}
