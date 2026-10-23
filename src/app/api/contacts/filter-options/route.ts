import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { getOrgContext } from "@/lib/api-auth";
import { auth } from "@/lib/auth";
import { principalFromCaller, requirePermission } from "@/lib/permissions/require-permission";

interface Option { value: string; count: number }

/**
 * The choices for the Contacts page's Specialty, Country and Role filters, with
 * how many contacts each holds (Oct 23, 2026). Spellings that differ only in
 * case are one choice, shown as the most common spelling, because the filter
 * matches ignoring case. `notSet` counts the contacts with no value.
 *
 * Aggregated in SQL, like the tag list: the book is ~56,000 rows and the
 * answer is a few hundred strings.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getOrgContext(req);
    if (!ctx) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const gate = requirePermission(principalFromCaller(await auth(), ctx), "contacts.read", { route: "contacts/filter-options:GET" });
    if (!gate.ok) return gate.response;

    return await runWithTenant(ctx.organizationId, async () => {
      const [specialty, country, role] = await Promise.all([
        textColumnOptions(ctx.organizationId, "specialty"),
        textColumnOptions(ctx.organizationId, "country"),
        db.contact.groupBy({
          by: ["role"],
          where: { organizationId: ctx.organizationId },
          _count: { _all: true },
        }),
      ]);

      const roleSet = role.filter((r) => r.role !== null);
      const response = NextResponse.json({
        specialties: specialty.options,
        specialtyNotSet: specialty.notSet,
        countries: country.options,
        countryNotSet: country.notSet,
        roles: roleSet
          .map((r) => ({ value: r.role as string, count: r._count._all }))
          .sort((a, b) => b.count - a.count),
        roleNotSet: role.find((r) => r.role === null)?._count._all ?? 0,
      });
      response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
      return response;
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "contacts/filter-options:failed" });
    return NextResponse.json({ error: "Failed to load filter options" }, { status: 500 });
  }
}

/** One text column's distinct values, grouped ignoring case, most common first. */
async function textColumnOptions(
  organizationId: string,
  column: "specialty" | "country",
): Promise<{ options: Option[]; notSet: number }> {
  // The column name is one of two literals above, never request input.
  const col = Prisma.raw(`"${column}"`);
  const rows = await db.$queryRaw<{ value: string | null; count: bigint }[]>`
    SELECT
      (array_agg(${col} ORDER BY n DESC, ${col}))[1] AS value,
      SUM(n)::bigint AS count
    FROM (
      SELECT ${col}, COUNT(*) AS n
      FROM "Contact"
      WHERE "organizationId" = ${organizationId}
      GROUP BY ${col}
    ) spellings
    GROUP BY lower(coalesce(${col}, ''))
    ORDER BY count DESC, value ASC`;

  let notSet = 0;
  const options: Option[] = [];
  for (const r of rows) {
    const count = Number(r.count);
    if (!r.value) {
      notSet += count;
      continue;
    }
    options.push({ value: r.value, count });
  }
  return { options, notSet };
}
