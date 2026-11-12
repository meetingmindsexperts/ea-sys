/**
 * Reading what a committee chair sends: abstract numbers and reviewer NAMES.
 *
 * Bulk reviewer assignment on the Abstracts page (Nov 12, 2026) has three
 * doors: tick boxes, "Select by IDs" (pasted abstract numbers) and a pasted
 * sheet of "abstract number + reviewer". This module is everything those doors
 * need to turn pasted text into ids, and nothing else: it writes nothing and
 * knows nothing about the database. The server re-checks every pair it is sent
 * (`assignReviewersBulk` in abstract-service.ts), so a wrong match here can
 * only ever propose, never assign.
 *
 * Two rules worth knowing before changing it:
 *
 *  - A chair writes "Dr Rahman", not an email. Names are matched against the
 *    event's REVIEWER POOL only, and a name is filled in only when exactly one
 *    person on the pool fits. None or several is left for the organiser to
 *    pick: a guess here would hand an abstract to the wrong person.
 *  - Abstract numbers are read loosely ("012", "12", "A-012", "a12" are all
 *    A-012) because the page shows "A-012" and a spreadsheet rarely does.
 *
 * Pure and client-safe: no imports.
 */

/** The abstract fields the resolvers need. */
export interface SheetAbstract {
  id: string;
  serialId: number | null;
}

/** One person on the event's reviewer pool. */
export interface SheetReviewer {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
}

/**
 * The abstract number a token names, or null when it names none.
 * "012", "12", "A-012", "a012", "#12" and "A-012." all give 12.
 */
export function abstractSerialFromToken(token: string): number | null {
  const m = /^#?(?:a|abs|abstract)?[\s\-_#.]*0*(\d{1,6})\.?$/i.exec(token.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

/**
 * "Select by IDs" for abstracts: pasted numbers (or full ids) to abstract ids.
 * Tokens split on whitespace, commas and semicolons. Matched ids come back
 * de-duplicated in first-seen order; tokens that named nothing in the supplied
 * list come back in `unmatched`.
 */
export function resolvePastedAbstractIds(
  text: string,
  abstracts: SheetAbstract[],
): { matched: string[]; unmatched: string[] } {
  const tokens = Array.from(new Set(text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)));
  const lookup = abstractLookup(abstracts);

  const matched: string[] = [];
  const unmatched: string[] = [];
  const seen = new Set<string>();
  for (const tok of tokens) {
    const id = lookup.byToken(tok);
    if (!id) {
      unmatched.push(tok);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    matched.push(id);
  }
  return { matched, unmatched };
}

function abstractLookup(abstracts: SheetAbstract[]) {
  const bySerial = new Map<number, string>();
  const ids = new Set<string>();
  for (const a of abstracts) {
    ids.add(a.id);
    if (a.serialId != null) bySerial.set(a.serialId, a.id);
  }
  return {
    byToken(token: string): string | null {
      if (ids.has(token)) return token;
      const serial = abstractSerialFromToken(token);
      return serial == null ? null : bySerial.get(serial) ?? null;
    },
  };
}

// ── The pasted sheet ─────────────────────────────────────────────────────────

/** One usable row of the sheet: the abstracts it names and the reviewers it names for them. */
export interface SheetRow {
  /** 1-based line in the pasted text. */
  line: number;
  /** The cells that read as abstract numbers, as typed. */
  abstractTokens: string[];
  /** The other non-empty cells, as typed: reviewer names or emails. */
  reviewerNames: string[];
}

export interface ParsedSheet {
  rows: SheetRow[];
  /** Lines with text but no abstract number (a header row, a stray note). Left out, and shown. */
  ignoredLines: { line: number; text: string }[];
}

/** What sits between a number and a name in a typed line: "012 -> Dr Rahman", "012: Dr Rahman". */
const TYPED_SEPARATORS = /->|=>|→|[,;|:=]/;

/** "A-001 goes to Dr Rahman": the words before the name are not part of it. */
const LEAD_IN = /^(?:goes\s+to|go\s+to|assigned\s+to|reviewed\s+by|to|for)\s+/i;

/**
 * A line with no separator at all: the abstract numbers at its start (or, when
 * it starts with the name, at its end), and the rest as ONE name.
 * "012 015 Dr Rahman" and "Dr Rahman 012" both work.
 */
function bareLineCells(line: string): string[] {
  const words = line.trim().split(/\s+/);
  const isNumber = (w: string) => abstractSerialFromToken(w) != null;

  let lead = 0;
  while (lead < words.length && isNumber(words[lead])) lead++;
  if (lead > 0) return [...words.slice(0, lead), words.slice(lead).join(" ")];

  let tail = words.length;
  while (tail > 0 && isNumber(words[tail - 1])) tail--;
  return [words.slice(0, tail).join(" "), ...words.slice(tail)];
}

/**
 * How a line splits into cells. A paste from a spreadsheet separates cells with
 * tabs; a typed line uses a comma, colon or arrow ("012, Dr Rahman"); a line
 * with neither is read by `bareLineCells`.
 */
function cellsOf(line: string): string[] {
  if (line.includes("\t")) return line.split("\t");
  if (TYPED_SEPARATORS.test(line)) return line.split(new RegExp(TYPED_SEPARATORS, "g"));
  return bareLineCells(line);
}

/** A cell as typed, without the quotes a spreadsheet adds or a "goes to" before a name. */
function cleanCell(cell: string): string {
  return cell.trim().replace(/^"(.*)"$/, "$1").trim().replace(LEAD_IN, "").trim();
}

/**
 * Read the pasted sheet. In each row, every cell that reads as an abstract
 * number is an abstract and every other non-empty cell is a reviewer, so the
 * column order does not matter, a second reviewer column works, and
 * "012, 015, 040, Dr Rahman" gives all three to one person.
 *
 * A row with no reviewer cell is kept (the preview says it names nobody); a
 * row with no abstract number is ignored and reported.
 */
export function parseReviewerSheet(text: string): ParsedSheet {
  const rows: SheetRow[] = [];
  const ignoredLines: { line: number; text: string }[] = [];

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    if (!raw.trim()) return;
    const cells = cellsOf(raw).map(cleanCell).filter(Boolean);
    const abstractTokens = cells.filter((c) => abstractSerialFromToken(c) != null);
    if (abstractTokens.length === 0) {
      ignoredLines.push({ line, text: raw.trim().slice(0, 120) });
      return;
    }
    const reviewerNames = cells.filter((c) => abstractSerialFromToken(c) == null);
    rows.push({ line, abstractTokens, reviewerNames });
  });

  return { rows, ignoredLines };
}

// ── Matching a written name to a person on the pool ──────────────────────────

/** Words a chair puts round a name that are not part of it. */
const HONORIFICS = new Set([
  "dr", "doctor", "prof", "professor", "mr", "mrs", "ms", "miss", "sir", "assoc", "associate", "asst", "assistant",
  "md", "phd", "mbbs", "frcp", "facc", "fesc", "msc",
]);

/** A written name as comparable words: lower case, no accents, no titles, no punctuation. */
export function nameWords(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    // Any script's letters and digits stay; punctuation ("Al-Rashid", "J.") separates words.
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w && !HONORIFICS.has(w));
}

/** A written word fits a name word when they are equal, or it is that word's initial ("J" for John). */
function wordFits(written: string, actual: string): boolean {
  if (written === actual) return true;
  return written.length === 1 && actual.startsWith(written);
}

/** Every written word fits a DIFFERENT word of the person's name. */
function wordsFitPerson(written: string[], actual: string[]): boolean {
  const free = [...actual];
  // Whole words first: an initial must not use up the word a later whole word needs.
  const ordered = [...written].sort((a, b) => b.length - a.length);
  for (const w of ordered) {
    const at = free.findIndex((a) => wordFits(w, a));
    if (at === -1) return false;
    free.splice(at, 1);
  }
  return true;
}

export type ReviewerNameMatch =
  | { kind: "matched"; userId: string }
  /** Several people on the pool fit: the organiser picks. */
  | { kind: "ambiguous"; candidates: string[] }
  /** Nobody on the pool fits: add them on the Reviewers page, or pick. */
  | { kind: "none" };

/**
 * Who on the pool a written name means. An email matches its exact address.
 * A name matches the people whose first and last names contain every word
 * written ("Dr Rahman", "A. Rahman" and "Rahman Aisha" all fit Aisha Rahman).
 * Exactly one fit is a match; anything else is left to the organiser.
 */
export function matchReviewerName(written: string, pool: SheetReviewer[]): ReviewerNameMatch {
  const text = written.trim();
  if (!text) return { kind: "none" };

  if (text.includes("@")) {
    const email = text.toLowerCase();
    const byEmail = pool.filter((r) => r.email.trim().toLowerCase() === email);
    return byEmail.length === 1 ? { kind: "matched", userId: byEmail[0].userId } : { kind: "none" };
  }

  const words = nameWords(text);
  // A lone initial ("J") says nothing about who is meant.
  if (words.length === 0 || words.every((w) => w.length === 1)) return { kind: "none" };

  const fits = pool.filter((r) => wordsFitPerson(words, nameWords(`${r.firstName} ${r.lastName}`)));
  if (fits.length === 1) return { kind: "matched", userId: fits[0].userId };
  if (fits.length > 1) return { kind: "ambiguous", candidates: fits.map((r) => r.userId) };
  return { kind: "none" };
}

/** Names that differ only by case, spacing or a title are one name in the preview. */
export function reviewerNameKey(written: string): string {
  return written.includes("@") ? written.trim().toLowerCase() : nameWords(written).join(" ");
}

// ── The plan: what the sheet comes to once names are settled ─────────────────

/** One distinct reviewer name in the sheet, and how many abstract rows name it. */
export interface SheetReviewerName {
  key: string;
  /** As first written. */
  written: string;
  match: ReviewerNameMatch;
  /** Pairs (abstract, this name) the sheet asks for. */
  pairCount: number;
}

export interface SheetPlan {
  /** Distinct reviewer names, in first-seen order. */
  names: SheetReviewerName[];
  /** Abstract numbers the event does not have, as typed. */
  unknownAbstracts: string[];
  /** Rows that name an abstract and no reviewer. */
  rowsWithoutReviewer: number[];
  /**
   * The assignments, grouped by reviewer: built from `choices` (name key to
   * the chosen userId, or null to leave that name out).
   */
  groups: { reviewerUserId: string; abstractIds: string[] }[];
  /** Distinct (abstract, reviewer) pairs in `groups`. */
  pairCount: number;
  /** Names with no person chosen yet: their rows are not in `groups`. */
  unresolvedNames: number;
}

/** The choice each name starts with: its one match, or nothing. */
export function initialChoices(names: SheetReviewerName[]): Record<string, string | null> {
  const choices: Record<string, string | null> = {};
  for (const n of names) choices[n.key] = n.match.kind === "matched" ? n.match.userId : null;
  return choices;
}

/** The distinct reviewer names in a parsed sheet, each matched against the pool. */
export function sheetReviewerNames(sheet: ParsedSheet, pool: SheetReviewer[]): SheetReviewerName[] {
  const byKey = new Map<string, SheetReviewerName>();
  for (const row of sheet.rows) {
    for (const written of row.reviewerNames) {
      const key = reviewerNameKey(written);
      if (!key) continue;
      const entry = byKey.get(key) ?? { key, written, match: matchReviewerName(written, pool), pairCount: 0 };
      entry.pairCount += row.abstractTokens.length;
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()];
}

/**
 * What the sheet comes to: which abstracts go to whom, given the organiser's
 * choice for each name. Unknown abstract numbers and unresolved names are
 * reported, never guessed.
 */
export function buildSheetPlan(
  sheet: ParsedSheet,
  abstracts: SheetAbstract[],
  pool: SheetReviewer[],
  choices?: Record<string, string | null>,
): SheetPlan {
  const names = sheetReviewerNames(sheet, pool);
  const chosen = choices ?? initialChoices(names);
  const lookup = abstractLookup(abstracts);

  const unknownAbstracts = new Set<string>();
  const rowsWithoutReviewer: number[] = [];
  const byReviewer = new Map<string, Set<string>>();

  for (const row of sheet.rows) {
    const abstractIds: string[] = [];
    for (const token of row.abstractTokens) {
      const id = lookup.byToken(token);
      if (id) abstractIds.push(id);
      else unknownAbstracts.add(token);
    }
    if (row.reviewerNames.length === 0) {
      rowsWithoutReviewer.push(row.line);
      continue;
    }
    for (const written of row.reviewerNames) {
      const userId = chosen[reviewerNameKey(written)];
      if (!userId) continue;
      const set = byReviewer.get(userId) ?? new Set<string>();
      for (const id of abstractIds) set.add(id);
      byReviewer.set(userId, set);
    }
  }

  const groups = [...byReviewer.entries()]
    .map(([reviewerUserId, ids]) => ({ reviewerUserId, abstractIds: [...ids] }))
    .filter((g) => g.abstractIds.length > 0);

  return {
    names,
    unknownAbstracts: [...unknownAbstracts],
    rowsWithoutReviewer,
    groups,
    pairCount: groups.reduce((sum, g) => sum + g.abstractIds.length, 0),
    unresolvedNames: names.filter((n) => !chosen[n.key]).length,
  };
}
