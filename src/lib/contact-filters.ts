import type { Prisma } from "@prisma/client";
import { parseAttendeeRole, type AttendeeRoleValue } from "@/lib/schemas";

/** The "Not set" choice for specialty, country and role. */
export const NOT_SET = "none";

/**
 * The Contacts page filters, shared by the list (`GET /api/contacts`) and the
 * export (`GET /api/contacts/export`) so an export is exactly what the page
 * shows (Oct 23, 2026). The export is capped at 25,000 rows and the book holds
 * ~56,000, so filtering is how a usable file is taken.
 *
 * Specialty and country match whole values, ignoring case: the data carries
 * "UNITED ARAB EMIRATES" beside "United Arab Emirates". For all three, the
 * value "none" is the "Not set" choice; role is otherwise the AttendeeRole enum.
 */
export interface ContactFilters {
  search: string;
  tags: string[];
  specialty: string | null;
  country: string | null;
  role: AttendeeRoleValue | typeof NOT_SET | null;
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
      specialty: params.get("specialty")?.trim() || null,
      country: params.get("country")?.trim() || null,
      role,
    },
  };
}

/** One text column: a value (case-insensitive) or "Not set" (null or empty). */
function textColumnWhere(
  column: "specialty" | "country",
  value: string | null,
): Prisma.ContactWhereInput | null {
  if (!value) return null;
  if (value === NOT_SET) return { OR: [{ [column]: null }, { [column]: "" }] };
  return { [column]: { equals: value, mode: "insensitive" } };
}

/** The Prisma where for one organisation's contacts under these filters. */
export function contactFiltersWhere(organizationId: string, f: ContactFilters): Prisma.ContactWhereInput {
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
  return !!(f.search || f.tags.length || f.specialty || f.country || f.role);
}

/** The filters as query parameters, for the page's list and export URLs. */
export function contactFiltersQuery(
  f: Partial<Omit<ContactFilters, "role">> & { role?: string | null },
): Record<string, string> {
  const q: Record<string, string> = {};
  if (f.search) q.search = f.search;
  if (f.tags?.length) q.tags = f.tags.join(",");
  if (f.specialty) q.specialty = f.specialty;
  if (f.country) q.country = f.country;
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
  if (f.specialty) out.specialty = f.specialty;
  if (f.country) out.country = f.country;
  if (f.role) out.role = f.role;
  return out;
}
