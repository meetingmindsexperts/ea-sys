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

/**
 * "On <date>, <person> wrote:", which Gmail and Apple Mail wrap over up to 3
 * lines, followed only by ">" lines. "wrote:" must END a line, or a sponsor's
 * "On the budget, my CFO wrote: we can do 5k" would fold their own reply. And
 * an unquoted line after the marker means an inline reply (answers between
 * the quoted lines), which is new text and must stay visible.
 */
function isOnWroteAt(lines: string[], i: number): boolean {
  if (!/^On\s/.test(lines[i]!)) return false;
  const last = lines.slice(i, i + 3).findIndex((l) => /\swrote:$/.test(l));
  if (last === -1) return false;
  if (!/^On\s.{5,300}\swrote:$/.test(lines.slice(i, i + last + 1).join(" "))) return false;
  return lines.slice(i + last + 1).every((l) => l === "" || l.startsWith(">"));
}

/**
 * Outlook's header block: "From: ..." with "Sent:" or "Date:" AND "To:" or
 * "Subject:" in the next lines. Asking for both keeps an ordinary "From: Dubai
 * / Date: 3 Dec" travel note in the body.
 */
function isOutlookHeaderAt(lines: string[], i: number): boolean {
  if (!/^From:\s?\S/.test(lines[i]!)) return false;
  const next = lines.slice(i + 1, i + 6);
  return next.some((l) => /^(Sent|Date):\s?\S/.test(l)) && next.some((l) => /^(To|Subject):\s?\S/.test(l));
}

/**
 * The first line of a trailing all-">" block (blank lines allowed), or -1.
 * Found in one backward walk: checking "is everything after here quoted" from
 * every ">" line was quadratic, and the text is any sender's.
 */
function quotedTailStart(lines: string[]): number {
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.startsWith(">")) start = i;
    else if (line !== "") break;
  }
  return start;
}

/** Index of the line where the earlier conversation starts, or -1. */
function quoteStart(lines: string[]): number {
  const tail = quotedTailStart(lines);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i === tail || ORIGINAL_MESSAGE.test(line)) return i;
    if (OUTLOOK_SEPARATOR.test(line) && isOutlookHeaderAt(lines, i + 1)) return i;
    if (isOutlookHeaderAt(lines, i) || isOnWroteAt(lines, i)) return i;
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
  if (shown.length > COLLAPSED_CHARS) shown = shown.slice(0, safeCut(shown));
  return shown.length < text.length ? { shown: shown.trimEnd(), truncated: true } : { shown: text, truncated: false };
}

/**
 * Where to cut a text that is over the character cap: at a space when one is
 * near, never inside a link (a cut link would still be clickable, to the
 * wrong address), never between the two halves of an emoji.
 */
function safeCut(text: string): number {
  const space = text.lastIndexOf(" ", COLLAPSED_CHARS);
  let cut = space > COLLAPSED_CHARS / 2 ? space : COLLAPSED_CHARS;
  for (const m of text.matchAll(URL_PATTERN)) {
    if (m.index! >= cut) break;
    if (m.index! + m[0].length > cut) cut = m.index!;
  }
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return cut;
}

export type TextPart = { kind: "text"; text: string } | { kind: "link"; href: string; label: string };

/** Links longer than this show as their host instead. */
const LONG_LINK = 60;
/** Outlook's optional brackets, the URL (capped, so a crafted body stays cheap), the closing bracket. */
const URL_PATTERN = /(<)?(https?:\/\/[^\s<>"]{1,2048})(>)?/g;

function linkLabel(href: string): string {
  if (href.length <= LONG_LINK) return href;
  try {
    return `${new URL(href).hostname}/…`;
  } catch {
    return `${href.slice(0, LONG_LINK)}…`;
  }
}

const count = (s: string, ch: string) => s.split(ch).length - 1;

/**
 * Drop the sentence punctuation that follows a bare link ("see https://x.com.").
 * A loop, not a regex: `[.,]+$` rescans a long run from every start, which a
 * sender could use to freeze the tab. A ")" stays when it closes one inside
 * the link, as in Wikipedia's `Foo_(bar)`.
 */
function trimTrailingPunctuation(href: string): string {
  let end = href.length;
  while (end > 0) {
    const ch = href[end - 1]!;
    if (".,;:!?]".includes(ch)) end -= 1;
    else if (ch === ")" && count(href.slice(0, end), ")") > count(href.slice(0, end), "(")) end -= 1;
    else break;
  }
  return href.slice(0, end);
}

/**
 * Split text into plain runs and http(s) links, a long link labelled by its
 * host. Outlook writes a link as `text<https://...>`: inside the brackets the
 * whole thing is the link and the brackets go; a bare link loses trailing
 * punctuation, which stays as text. Only http and https become links: the
 * text is the sender's.
 */
export function linkifyEmailText(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const bracketed = Boolean(match[1] && match[3]);
    const url = match[2]!;
    const href = bracketed ? url : trimTrailingPunctuation(url);
    if (!/^https?:\/\/[^/]/.test(href)) continue;
    const at = bracketed ? match.index! : match.index! + (match[1]?.length ?? 0);
    // `text<https://...>` loses its brackets, so keep the two words apart.
    const glued = bracketed && at > 0 && /\S/.test(text[at - 1]!);
    const before = text.slice(last, at) + (glued ? " " : "");
    if (before) parts.push({ kind: "text", text: before });
    parts.push({ kind: "link", href, label: linkLabel(href) });
    last = bracketed ? match.index! + match[0].length : at + href.length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}
