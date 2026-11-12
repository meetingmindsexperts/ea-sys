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
 * "012", "12", "A-012", "a012", "#12" and "A-012." all give 12. A bare
 * decimal (".5", "2.5") or a measure ("12 mg") is not an abstract number.
 */
export function abstractSerialFromToken(token: string): number | null {
  const m = /^#?\s*(?:(?:a|abs|abstract)[\s\-_#.]*)?0*(\d{1,6})\.?$/i.exec(token.trim());
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
  /** The abstract numbers of the row, as typed. */
  abstractTokens: string[];
  /** The reviewer names or emails of the row, as typed. */
  reviewerNames: string[];
}

export interface ParsedSheet {
  rows: SheetRow[];
  /** Lines with text but no abstract number (a header row, a stray note). Left out, and shown. */
  ignoredLines: { line: number; text: string }[];
  /** Spreadsheet pastes: a number found outside the abstract number column. Left out, and shown. */
  extraNumbers: { line: number; text: string }[];
  /** Why the paste cannot be read safely. When set there are no rows: nothing is guessed. */
  problem: string | null;
}

interface SheetLine {
  line: number;
  raw: string;
}

const isAbstractNumber = (text: string) => abstractSerialFromToken(text) != null;

/** A cell as pasted from a spreadsheet, without the quotes it adds. */
const cleanCell = (cell: string) => cell.trim().replace(/^"(.*)"$/, "$1").trim();

/**
 * A SPREADSHEET paste (tabs between cells) is read by column (review of
 * 87d819ee, Nov 12, 2026). The first version took every numeric cell as an
 * abstract, so a row-number column or a score column silently assigned
 * abstracts nobody had named. Now exactly ONE column holds the abstract number:
 * the one that is a number on most rows. Two such columns and the paste is
 * refused, because choosing between them would be a guess. A stray number in
 * another column is left out and reported.
 */
function parseColumns(lines: SheetLine[]): ParsedSheet {
  const grid = lines.map((l) => ({ line: l.line, raw: l.raw, cells: l.raw.split("\t").map(cleanCell) }));
  const width = Math.max(...grid.map((row) => row.cells.length));
  const numericRows = (column: number) => grid.filter((row) => isAbstractNumber(row.cells[column] ?? "")).length;
  const rowsWithANumber = grid.filter((row) => row.cells.some(isAbstractNumber)).length;
  const threshold = Math.max(1, Math.ceil(rowsWithANumber / 2));
  const candidates = Array.from({ length: width }, (_, column) => column).filter((column) => numericRows(column) >= threshold);

  if (candidates.length > 1) {
    const named = candidates.map((column) => column + 1).join(" and ");
    return {
      rows: [],
      ignoredLines: [],
      extraNumbers: [],
      problem: `Columns ${named} both hold numbers, so it is not clear which one is the abstract number. Paste only the abstract number column and the reviewer column(s): no row numbers, scores or counts.`,
    };
  }

  const sheet: ParsedSheet = { rows: [], ignoredLines: [], extraNumbers: [], problem: null };
  const abstractColumn = candidates[0];
  for (const row of grid) {
    const abstractCell = abstractColumn === undefined ? "" : row.cells[abstractColumn] ?? "";
    if (!isAbstractNumber(abstractCell)) {
      sheet.ignoredLines.push({ line: row.line, text: row.raw.trim().slice(0, 120) });
      continue;
    }
    const others = row.cells.filter((cell, column) => column !== abstractColumn && cell);
    for (const cell of others.filter(isAbstractNumber)) sheet.extraNumbers.push({ line: row.line, text: cell });
    sheet.rows.push({ line: row.line, abstractTokens: [abstractCell], reviewerNames: others.filter((cell) => !isAbstractNumber(cell)) });
  }
  return sheet;
}

/** What sits between a number and a name in a typed line: "012 -> Dr Rahman", "012: Dr Rahman". */
const TYPED_ARROWS = /->|=>|→|[:=]/g;

/**
 * "A-001 goes to Dr Rahman": the words between the number and the name. A bare
 * "to" counts only before a title, so a reviewer whose name is "To Lam" keeps it.
 */
const LEAD_IN = /^(?:(?:goes|go|assigned|is)\s+(?:to|for)|reviewed\s+by|(?:to|for)(?=\s+(?:dr|prof|professor|mr|mrs|ms)\b))\s+/i;

/** "Abstract 12" typed as two words is one number. */
function joinPrefixedNumbers(words: string[]): string[] {
  const joined: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const next = words[i + 1];
    if (/^(?:a|abs|abstract)$/i.test(words[i]) && next && /^\d+,?$/.test(next)) {
      joined.push(`${words[i]} ${next}`);
      i++;
    } else {
      joined.push(words[i]);
    }
  }
  return joined;
}

const withoutCommas = (word: string) => word.replace(/^,+|,+$/g, "");

/**
 * One part of a typed line: the abstract numbers at its start (or, when it
 * starts with the name, at its end) and everything else as ONE name. A comma
 * inside the name stays in it, so "012: Khan, Aisha" is one person, not two
 * (review of 87d819ee). Two reviewers on a line are separated by ";".
 */
function typedSegment(segment: string): { abstractTokens: string[]; name: string } {
  const words = joinPrefixedNumbers(segment.replace(TYPED_ARROWS, " ").replace(/,/g, ", ").trim().split(/\s+/).filter(Boolean));
  const isNumber = (word: string) => isAbstractNumber(withoutCommas(word));

  let lead = 0;
  while (lead < words.length && isNumber(words[lead])) lead++;
  let tail = words.length;
  while (lead === 0 && tail > 0 && isNumber(words[tail - 1])) tail--;

  const written = words.slice(lead, tail).join(" ").replace(/^[,\s]+|[,\s]+$/g, "");
  return {
    abstractTokens: [...words.slice(0, lead), ...words.slice(tail)].map(withoutCommas),
    // The lead-in only ever follows a number.
    name: lead > 0 ? written.replace(LEAD_IN, "").trim() : written,
  };
}

/** Typed lines: "012, Dr Rahman", "012 015 Dr Rahman", "Dr Rahman 012", "A-001 goes to Dr Rahman; Prof Haddad". */
function parseTypedLines(lines: SheetLine[]): ParsedSheet {
  const sheet: ParsedSheet = { rows: [], ignoredLines: [], extraNumbers: [], problem: null };
  for (const { line, raw } of lines) {
    const segments = raw.split(/[;|]/).map(typedSegment);
    const abstractTokens = segments.flatMap((segment) => segment.abstractTokens);
    if (abstractTokens.length === 0) {
      sheet.ignoredLines.push({ line, text: raw.trim().slice(0, 120) });
      continue;
    }
    sheet.rows.push({ line, abstractTokens, reviewerNames: segments.map((segment) => segment.name).filter(Boolean) });
  }
  return sheet;
}

/**
 * Read the pasted sheet. A paste from a spreadsheet (tabs) is read by column;
 * anything else is read as typed lines. A row with no reviewer is kept (the
 * preview says it names nobody); a row with no abstract number is left out and
 * reported.
 */
export function parseReviewerSheet(text: string): ParsedSheet {
  const lines: SheetLine[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    if (raw.trim()) lines.push({ line: index + 1, raw });
  });
  if (lines.length === 0) return { rows: [], ignoredLines: [], extraNumbers: [], problem: null };
  const tabbed = lines.filter((l) => l.raw.includes("\t")).length;
  return tabbed > 0 && tabbed >= lines.length / 2 ? parseColumns(lines) : parseTypedLines(lines);
}

// ── Matching a written name to a person on the pool ──────────────────────────

/** Words a chair puts in front of a name that are not part of it. */
const TITLES = new Set(["dr", "doctor", "prof", "professor", "mr", "mrs", "ms", "miss", "sir", "assoc", "associate", "asst", "assistant"]);

/**
 * Letters after a name. Dropped only as a trailing ", MD": "Md" is also how
 * Mohammed is written as a given name, and stripping it everywhere made
 * "Md Rahman" and "Dr Rahman" one person (review of 87d819ee).
 */
const DEGREES = new Set(["md", "phd", "mbbs", "frcp", "mrcp", "facc", "fesc", "facp", "msc"]);

/**
 * Text as comparable words: lower case, Latin accents removed, punctuation as
 * a separator. Only the Latin combining marks go: in Devanagari, Bengali, Tamil
 * or Thai the marks ARE the vowels, and removing them made different names equal.
 */
function plainWords(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

function withoutTrailingDegrees(name: string): string {
  const parts = name.split(",");
  while (parts.length > 1 && plainWords(parts[parts.length - 1]).every((word) => DEGREES.has(word))) parts.pop();
  return parts.join(",");
}

/** A written name as the words that identify the person: no titles, no trailing degrees. */
export function nameWords(name: string): string[] {
  return plainWords(withoutTrailingDegrees(name)).filter((word) => !TITLES.has(word));
}

/** A single Latin letter stands for a name starting with it ("J" for John). */
const isInitial = (word: string) => /^[a-z]$/.test(word);

/** A written word fits a name word when they are equal, or it is that word's initial. */
function wordFits(written: string, actual: string): boolean {
  if (written === actual) return true;
  return isInitial(written) && actual.startsWith(written);
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
  if (words.length === 0 || words.every(isInitial)) return { kind: "none" };

  const fits = pool.filter((r) => wordsFitPerson(words, nameWords(`${r.firstName} ${r.lastName}`)));
  if (fits.length === 1) return { kind: "matched", userId: fits[0].userId };
  if (fits.length > 1) return { kind: "ambiguous", candidates: fits.map((r) => r.userId) };
  return { kind: "none" };
}

/**
 * Names that differ only by case, spacing or punctuation are one name in the
 * preview. The title stays in the key: "Dr Rahman" and "Prof Rahman" may be
 * two people, and one choice must never cover both.
 */
export function reviewerNameKey(written: string): string {
  return written.includes("@") ? written.trim().toLowerCase() : plainWords(written).join(" ");
}

// ── The plan: what the sheet comes to once names are settled ─────────────────

/** One distinct reviewer name in the sheet, and how many abstract rows name it. */
export interface SheetReviewerName {
  key: string;
  /** As first written. */
  written: string;
  match: ReviewerNameMatch;
  /**
   * Matched, but NOT filled in: a one-word name sharing its row with another
   * one-word name. "Khan" and "Aisha" in two cells may be one person's last
   * and first name, so neither is assigned until the organiser says who.
   */
  held: boolean;
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
  /** The same assignments by abstract, for the row-by-row check before saving. */
  byAbstract: { abstractId: string; reviewerUserIds: string[] }[];
  /** Distinct (abstract, reviewer) pairs in `groups`. */
  pairCount: number;
  /** Names with no person chosen yet: their rows are not in `groups`. */
  unresolvedNames: number;
}

/** One bare word as written. "Dr Rahman" is not: a title marks a whole person, not half of a name. */
const isOneWordName = (written: string) => !written.includes("@") && plainWords(written).length === 1;

/**
 * The reviewer names of one row. Two one-word cells are tried as ONE name
 * first ("Khan" + "Aisha" is Aisha Khan when she is on the pool); otherwise
 * one-word names sharing a row are held for the organiser.
 */
function rowReviewerNames(row: SheetRow, pool: SheetReviewer[]): { names: string[]; held: boolean } {
  const cells = row.reviewerNames;
  if (cells.length < 2 || !cells.every(isOneWordName)) return { names: cells, held: false };
  const joined = cells.join(" ");
  if (cells.length === 2 && matchReviewerName(joined, pool).kind === "matched") return { names: [joined], held: false };
  return { names: cells, held: true };
}

/** The choice each name starts with: its one match, unless it is held. */
export function initialChoices(names: SheetReviewerName[]): Record<string, string | null> {
  const choices: Record<string, string | null> = {};
  for (const n of names) choices[n.key] = n.match.kind === "matched" && !n.held ? n.match.userId : null;
  return choices;
}

/** The distinct reviewer names in a parsed sheet, each matched against the pool. */
export function sheetReviewerNames(sheet: ParsedSheet, pool: SheetReviewer[]): SheetReviewerName[] {
  const byKey = new Map<string, SheetReviewerName>();
  for (const row of sheet.rows) {
    const { names, held } = rowReviewerNames(row, pool);
    for (const written of names) {
      const key = reviewerNameKey(written);
      if (!key) continue;
      const entry = byKey.get(key) ?? { key, written, match: matchReviewerName(written, pool), held: false, pairCount: 0 };
      entry.held = entry.held || held;
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
  const byAbstract = new Map<string, Set<string>>();

  for (const row of sheet.rows) {
    const abstractIds: string[] = [];
    for (const token of row.abstractTokens) {
      const id = lookup.byToken(token);
      if (id) abstractIds.push(id);
      else unknownAbstracts.add(token);
    }
    // A cell of only punctuation ("-") is no name at all.
    const written = rowReviewerNames(row, pool).names.filter((name) => reviewerNameKey(name));
    if (written.length === 0) {
      rowsWithoutReviewer.push(row.line);
      continue;
    }
    for (const name of written) {
      const userId = chosen[reviewerNameKey(name)];
      if (!userId) continue;
      const forReviewer = byReviewer.get(userId) ?? new Set<string>();
      for (const id of abstractIds) {
        forReviewer.add(id);
        byAbstract.set(id, (byAbstract.get(id) ?? new Set<string>()).add(userId));
      }
      byReviewer.set(userId, forReviewer);
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
    byAbstract: [...byAbstract.entries()].map(([abstractId, ids]) => ({ abstractId, reviewerUserIds: [...ids] })),
    pairCount: groups.reduce((sum, g) => sum + g.abstractIds.length, 0),
    unresolvedNames: names.filter((n) => !chosen[n.key]).length,
  };
}
