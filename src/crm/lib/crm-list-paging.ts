/**
 * Server paging for the CRM contacts and accounts lists (Oct 29, 2026).
 *
 * WHY: the lists loaded up to 1,000 rows and sorted them in the browser. With
 * 3,340 contacts on prod, two thirds of the book never reached the screen
 * except through a search, and a column sort only sorted the first 1,000.
 * Now the server sorts and sends 100 rows at a time ("Load more").
 *
 * Two kinds of cursor, chosen by the sort:
 *  - KEYSET for sorts on stored columns (name, score): the cursor holds the
 *    last row's sort values and id, and the next page is "everything after
 *    that", which costs the same on page 1 and page 50.
 *  - OFFSET for sorts on a relation count (deals, contacts): an aggregate has
 *    no column a keyset can compare against. At this size an offset is cheap.
 *
 * Every sort ends on `id`, so rows that tie on the sort never repeat or go
 * missing across a page boundary. The cursor is opaque (base64url JSON) and
 * carries its own sort, so a cursor from one sort is refused under another.
 *
 * SERVER ONLY: uses Buffer. The client passes the cursor back untouched.
 */

export const CRM_LIST_PAGE_SIZE = 100;

export type ListSortDir = "asc" | "desc";

type CursorValue = string | number;

interface KeysetCursor {
  m: "k";
  s: string;
  d: ListSortDir;
  /** The last row's sort values, id last. */
  v: CursorValue[];
}

interface OffsetCursor {
  m: "o";
  s: string;
  d: ListSortDir;
  o: number;
}

export type ListCursor = KeysetCursor | OffsetCursor;

export function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function isCursorValue(v: unknown): v is CursorValue {
  return typeof v === "string" || (typeof v === "number" && Number.isFinite(v));
}

/**
 * The cursor, or null when it does not parse or was minted for another sort
 * (the caller answers 400, never a silently wrong page).
 */
export function decodeListCursor(raw: string, sort: string, dir: ListSortDir): ListCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const c = parsed as Record<string, unknown>;
  if (c.s !== sort || c.d !== dir) return null;
  if (c.m === "k" && Array.isArray(c.v) && c.v.length > 0 && c.v.length <= 8 && c.v.every(isCursorValue)) {
    return { m: "k", s: sort, d: dir, v: c.v };
  }
  if (c.m === "o" && typeof c.o === "number" && Number.isInteger(c.o) && c.o > 0 && c.o <= 1_000_000) {
    return { m: "o", s: sort, d: dir, o: c.o };
  }
  return null;
}

/**
 * "After this row" for a keyset sort over `fields` (id last), as a Prisma
 * where: (a > x) OR (a = x AND b > y) OR (a = x AND b = y AND id > z).
 * Plain objects, so it slots into any model's where.
 */
export function keysetAfter(fields: string[], values: CursorValue[], dir: ListSortDir): { OR: Record<string, unknown>[] } | null {
  if (fields.length !== values.length) return null;
  const op = dir === "asc" ? "gt" : "lt";
  const OR = fields.map((field, i) => {
    const clause: Record<string, unknown> = {};
    for (let j = 0; j < i; j++) clause[fields[j]!] = values[j];
    clause[field] = { [op]: values[i] };
    return clause;
  });
  return { OR };
}

export function parseSortDir(raw: string | null): ListSortDir {
  return raw === "desc" ? "desc" : "asc";
}
