import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { getOrgContext } from "@/lib/api-auth";
import { auth } from "@/lib/auth";
import { principalFromCaller, requirePermission } from "@/lib/permissions/require-permission";
import { contactFiltersWhere, groupFilterValues, parseContactFilters } from "@/lib/contact-filters";

/**
 * The choices for the Contacts page's Specialty, Country and Role filters, with
 * how many contacts each holds (Oct 23, 2026). Each picker's counts follow the
 * OTHER filters on the page (country = India shows how many Indian contacts are
 * in each specialty), so a count is what picking it returns. Spellings that
 * differ only in case are one choice. `total` is the whole book, for the
 * "of N" beside a filtered count.
 *
 * Grouped in the database, then by case in `groupFilterValues`: a few hundred
 * distinct values, never a row per contact.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getOrgContext(req);
    if (!ctx) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const gate = requirePermission(principalFromCaller(await auth(), ctx), "contacts.read", { route: "contacts/filter-options:GET" });
    if (!gate.ok) return gate.response;

    const parsed = parseContactFilters(new URL(req.url).searchParams);
    if (!parsed.ok) {
      apiLogger.warn({ msg: "contacts/filter-options:invalid-filter", organizationId: ctx.organizationId, userId: ctx.userId, field: parsed.field });
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const f = parsed.filters;
    const orgId = ctx.organizationId;

    return await runWithTenant(orgId, async () => {
      const [specialtyRows, countryRows, roleRows, total] = await Promise.all([
        db.contact.groupBy({ by: ["specialty"], where: contactFiltersWhere(orgId, { ...f, specialty: [] }), _count: { _all: true } }),
        db.contact.groupBy({ by: ["country"], where: contactFiltersWhere(orgId, { ...f, country: [] }), _count: { _all: true } }),
        db.contact.groupBy({ by: ["role"], where: contactFiltersWhere(orgId, { ...f, role: null }), _count: { _all: true } }),
        db.contact.count({ where: { organizationId: orgId } }),
      ]);

      const specialty = groupFilterValues(specialtyRows.map((r) => ({ value: r.specialty, count: r._count._all })));
      const country = groupFilterValues(countryRows.map((r) => ({ value: r.country, count: r._count._all })));
      const role = groupFilterValues(roleRows.map((r) => ({ value: r.role, count: r._count._all })));

      const response = NextResponse.json({
        total,
        specialties: specialty.options,
        specialtyNotSet: specialty.notSet,
        countries: country.options,
        countryNotSet: country.notSet,
        roles: role.options,
        roleNotSet: role.notSet,
      });
      response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
      return response;
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "contacts/filter-options:failed" });
    return NextResponse.json({ error: "Failed to load filter options" }, { status: 500 });
  }
}
