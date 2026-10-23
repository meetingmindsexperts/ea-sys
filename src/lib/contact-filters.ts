import type { Prisma } from "@prisma/client";
import { parseAttendeeRole, type AttendeeRoleValue } from "@/lib/schemas";

/**
 * The "Not recorded" choice for specialty, country and role. A sentinel no real
 * value uses (a specialty literally called "none" would otherwise be read as
 * blank).
 */
export const NOT_SET = "__none__";

/**
 * The Contacts page filters, shared by the list (`GET /api/contacts`) and the
 * export (`GET /api/contacts/export`) so an export is exactly what the page
 * shows (Oct 23, 2026). The export is capped at 25,000 rows and the book holds
 * ~56,000, so filtering is how a usable file is taken.
 *
 * Specialty and country match whole values, ignoring case: the data carries
 * "UNITED ARAB EMIRATES" beside "United Arab Emirates". Each takes SEVERAL
 * values (Oct 23, 2026), matched as any-of, so "UAE" and "United Arab
 * Emirates" can be picked together; the fields combine with AND. Several
 * values travel as repeated parameters (`specialty=A&specialty=B`), never one
 * comma list, because real values contain commas ("Others, please specify").
 * For all three, `NOT_SET` is the "Not recorded" choice; role is otherwise
 * the AttendeeRole enum and takes one value.
 */
export interface ContactFilters {
  search: string;
  tags: string[];
  specialty: string[];
  country: string[];
  role: AttendeeRoleValue | typeof NOT_SET | null;
}

/** Query parameters with repeated keys, for the list, options and export URLs. */
export type ContactFilterParams = Record<string, string | string[]>;

/** URLSearchParams that repeat a key for each value of an array. */
export function toSearchParams(params: ContactFilterParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : [value]) out.append(key, v);
  }
  return out;
}

/** Every value of a repeated parameter, trimmed, blanks dropped, duplicates removed. */
function allValues(params: URLSearchParams, key: string): string[] {
  return [...new Set(params.getAll(key).map((v) => v.trim()).filter(Boolean))];
}

export type ParsedContactFilters =
  | { ok: true; filters: ContactFilters }
  | { ok: false; error: string; field: string };

export function parseContactFilters(params: URLSearchParams): ParsedContactFilters {
  const roleParam = params.get("role")?.trim() || "";
  const role = roleParam === NOT_SET ? NOT_SET : parseAttendeeRole(roleParam);
  // An unknown role is refused, not ignored: ignoring it would return the
  // whole book while the caller believes it filtered.
  if (roleParam && !role) return { ok: false, error: `Unknown role: ${roleParam}`, field: "role" };
  return {
    ok: true,
    filters: {
      search: params.get("search")?.trim() || "",
      tags: (params.get("tags") || "").split(",").map((t) => t.trim()).filter(Boolean),
      specialty: allValues(params, "specialty"),
      country: allValues(params, "country"),
      role,
    },
  };
}

/**
 * Prisma compiles a case-insensitive `equals` to ILIKE on Postgres, where `%`
 * and `_` are wildcards: a specialty of "%" matched 43,518 contacts. Escaped
 * here so a value only ever matches itself.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** One value of a text column: case-insensitive, or "Not recorded" (null or empty). */
function textValueWhere(column: "specialty" | "country", value: string): Prisma.ContactWhereInput[] {
  if (value === NOT_SET) return [{ [column]: null }, { [column]: "" }];
  return [{ [column]: { equals: escapeLike(value), mode: "insensitive" } }];
}

/** A text column matching ANY of the chosen values; null when none are chosen. */
function textColumnWhere(column: "specialty" | "country", values: string[]): Prisma.ContactWhereInput | null {
  if (values.length === 0) return null;
  return { OR: values.flatMap((v) => textValueWhere(column, v)) };
}

/** The Prisma where for one organisation's contacts under these filters. */
export function contactFiltersWhere(organizationId: string, f: ContactFilters): Prisma.ContactWhereInput {
  // A facet counts under every OTHER filter, so this also serves the options
  // route with one field emptied (`{ ...f, specialty: [] }`).
  const and: Prisma.ContactWhereInput[] = [];
  if (f.search) {
    and.push({
      OR: [
        { firstName: { contains: f.search, mode: "insensitive" } },
        { lastName: { contains: f.search, mode: "insensitive" } },
        { email: { contains: f.search, mode: "insensitive" } },
        { organization: { contains: f.search, mode: "insensitive" } },
      ],
    });
  }
  if (f.tags.length > 0) and.push({ tags: { hasSome: f.tags } });
  if (f.role === NOT_SET) and.push({ role: null });
  else if (f.role) and.push({ role: f.role });
  for (const clause of [textColumnWhere("specialty", f.specialty), textColumnWhere("country", f.country)]) {
    if (clause) and.push(clause);
  }
  return and.length > 0 ? { organizationId, AND: and } : { organizationId };
}

/** True when any filter narrows the book. */
export function hasContactFilters(f: ContactFilters): boolean {
  return !!(f.search || f.tags.length || f.specialty.length || f.country.length || f.role);
}

/** The filters as query parameters, for the page's list and export URLs. */
export function contactFiltersQuery(
  f: Partial<Omit<ContactFilters, "role">> & { role?: string | null },
): ContactFilterParams {
  const q: ContactFilterParams = {};
  if (f.search) q.search = f.search;
  if (f.tags?.length) q.tags = f.tags.join(",");
  if (f.specialty?.length) q.specialty = f.specialty;
  if (f.country?.length) q.country = f.country;
  if (f.role) q.role = f.role;
  return q;
}

/**
 * The filters for the export's audit row, without the search text: it is
 * often a person's name or email, so the route stores its fingerprint instead
 * (`fingerprintSearchTerm`, server-only; this file is also loaded in the browser).
 */
export function contactFiltersAudit(f: ContactFilters): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (f.tags.length) out.tags = f.tags;
  if (f.specialty.length) out.specialty = f.specialty;
  if (f.country.length) out.country = f.country;
  if (f.role) out.role = f.role;
  return out;
}

export interface FilterOption { value: string; count: number }

/**
 * Distinct values with counts, grouped ignoring case, each shown as its most
 * common spelling; blanks go to `notSet`. The filter matches ignoring case, so
 * picking an option reproduces its count. Surrounding spaces are trimmed here
 * for display; no stored value carries them today (checked Oct 23, 2026).
 */
export function groupFilterValues(rows: { value: string | null; count: number }[]): { options: FilterOption[]; notSet: number } {
  const groups = new Map<string, { best: string; bestCount: number; count: number }>();
  let notSet = 0;
  for (const r of rows) {
    const value = r.value?.trim();
    if (!value) {
      notSet += r.count;
      continue;
    }
    const key = value.toLowerCase();
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { best: value, bestCount: r.count, count: r.count });
      continue;
    }
    g.count += r.count;
    if (r.count > g.bestCount || (r.count === g.bestCount && value < g.best)) {
      g.best = value;
      g.bestCount = r.count;
    }
  }
  const options = [...groups.values()]
    .map((g) => ({ value: g.best, count: g.count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  return { options, notSet };
}

/**
 * A download name that says what is inside: `contacts-india-cardiology-2026-10-23.csv`
 * rather than `contacts-1761209.csv`, so a file kept for later is not mistaken
 * for the whole book. The search text is left out of the name on purpose.
 */
export function contactExportFileName(query: ContactFilterParams, today: Date = new Date()): string {
  const parts = [query.country, query.specialty, query.role, query.tags]
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter((v): v is string => !!v)
    .map((v) => (v === NOT_SET ? "not-recorded" : v));
  if (query.search) parts.push("search");
  const slug = parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const date = today.toISOString().slice(0, 10);
  return slug ? `contacts-${slug}-${date}.csv` : `contacts-all-${date}.csv`;
}
