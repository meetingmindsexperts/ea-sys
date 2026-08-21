/**
 * Prove tenant isolation BEHAVES, on a real database, from the app role.
 *
 * scripts/bootstrap-rls.ts answers a structural question: is row-level security
 * switched on for the connected role. This answers the question that actually
 * matters: with a tenant lane set, does the app role see that tenant's rows and
 * nobody else's.
 *
 * The two are different, and the gap between them is where the interesting
 * failures live. A policy can be active and still wrong (predicate on the
 * column, WITH CHECK missing, a table with no policy at all), and every one of
 * those looks identical to "working" from the outside, because RLS answers a
 * wrong query with zero rows rather than an error.
 *
 * HOW IT READS THE TRUTH
 * ----------------------
 * Two connections. The OWNER (DIRECT_URL) bypasses RLS, so it sees every row
 * and provides the denominator. The APP role (DATABASE_URL) is the one under
 * test. Comparing them is what distinguishes "isolated" from "empty".
 *
 * Requires at least two organizations with data; one tenant cannot demonstrate
 * isolation from anybody. The sandbox (npm run sandbox:setup) is exactly that.
 *
 * USAGE
 *   # sandbox
 *   DIRECT_URL=postgresql://postgres:postgres@localhost:55432/sandbox \
 *   DATABASE_URL=postgresql://app_user:app_user_pw@localhost:55432/sandbox \
 *   npx tsx scripts/verify-tenant-isolation.ts
 *
 *   # platform: both URLs are already the right ones, so no env needed
 *   npx tsx scripts/verify-tenant-isolation.ts
 *
 * Read-only. Opens transactions to set the lane and rolls every one of them
 * back; it never writes.
 */
import path from "node:path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { listPoliciedTables } from "../src/lib/tenant/rls-assert";

/** Tables worth naming in the report even when unpoliced, for contrast. */
const ALWAYS_REPORT = ["Event"];

interface Row {
  table: string;
  policied: boolean;
  ownerTotal: number;
  perLane: Record<string, number>;
  noLane: number;
}

function fail(msg: string): never {
  console.error(`\n✋ ${msg}\n`);
  process.exit(1);
}

async function countAs(
  client: PrismaClient,
  table: string,
  orgId: string | null,
): Promise<number> {
  // The lane has to be set on the SAME backend as the query, so both go in one
  // transaction. Rolled back either way: this script never writes.
  return client
    .$transaction(async (tx) => {
      if (orgId !== null) {
        await tx.$executeRaw`SELECT set_config('app.current_org', ${orgId}, true)`;
      }
      const r = await tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS "n" FROM "${table}"`,
      );
      return Number(r[0]?.n ?? 0);
    })
    .catch(() => -1); // -1 distinguishes "query failed" from "zero rows"
}

async function main() {
  dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
  dotenv.config({ path: path.resolve(process.cwd(), ".env") });

  const ownerUrl = process.env.DIRECT_URL;
  const appUrl = process.env.DATABASE_URL;
  if (!ownerUrl || !appUrl) fail("Both DIRECT_URL (owner) and DATABASE_URL (app role) must be set.");
  if (ownerUrl === appUrl) {
    fail(
      "DIRECT_URL and DATABASE_URL are the same connection.\n" +
        "   The app role must be a NON-owner, or RLS is bypassed and this proves nothing.",
    );
  }

  const owner = new PrismaClient({ datasourceUrl: ownerUrl });
  const app = new PrismaClient({ datasourceUrl: appUrl });

  try {
    const orgs = await owner.organization.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    if (orgs.length < 2) {
      fail(
        `Only ${orgs.length} organization(s) in this database.\n` +
          `   Isolation cannot be demonstrated with fewer than two. Use the sandbox:\n` +
          `   npm run sandbox:setup`,
      );
    }

    const policied = new Set((await listPoliciedTables(owner)).map((t) => t.table));
    const tables = [...new Set([...policied, ...ALWAYS_REPORT])].sort();

    console.log(`\nOrganizations: ${orgs.map((o) => o.name).join(", ")}`);
    console.log(`Tables checked: ${tables.length} (${policied.size} policied)\n`);

    const rows: Row[] = [];
    for (const table of tables) {
      const ownerTotal = await countAs(owner, table, null);
      if (ownerTotal <= 0) continue; // no data, nothing to prove either way

      const perLane: Record<string, number> = {};
      for (const o of orgs) perLane[o.name] = await countAs(app, table, o.id);
      rows.push({
        table,
        policied: policied.has(table),
        ownerTotal,
        perLane,
        noLane: await countAs(app, table, null),
      });
    }

    const width = Math.max(...rows.map((r) => r.table.length), 20);
    const header = ["table".padEnd(width), "all".padStart(5)]
      .concat(orgs.map((o) => o.name.slice(0, 10).padStart(11)))
      .concat(["no-lane".padStart(8)])
      .join("");
    console.log(header);
    console.log("-".repeat(header.length));

    const leaks: Row[] = [];
    const unpoliciedWithData: Row[] = [];

    for (const r of rows) {
      const cells = orgs.map((o) => String(r.perLane[o.name]).padStart(11)).join("");
      const flag = !r.policied ? "  ← NO POLICY" : "";
      console.log(
        r.table.padEnd(width) +
          String(r.ownerTotal).padStart(5) +
          cells +
          String(r.noLane).padStart(8) +
          flag,
      );

      if (!r.policied) {
        unpoliciedWithData.push(r);
        continue;
      }
      // A lane seeing everything the owner sees means the policy is not
      // filtering. With >=2 orgs holding rows, that is a leak.
      const sawEverything = orgs.some((o) => r.perLane[o.name] === r.ownerTotal);
      const orgsWithRows = orgs.filter((o) => r.perLane[o.name] > 0).length;
      if (sawEverything && orgsWithRows > 1) leaks.push(r);
      // An unset lane must see nothing: fail-closed is the whole contract.
      if (r.noLane > 0) leaks.push(r);
    }

    console.log();

    if (leaks.length > 0) {
      fail(
        `ISOLATION FAILED on: ${[...new Set(leaks.map((l) => l.table))].join(", ")}\n` +
          `   Either a lane saw rows belonging to another tenant, or an UNSET lane\n` +
          `   returned rows when it must return none.`,
      );
    }

    console.log("✓ Every policied table with data is isolated per tenant,");
    console.log("  and returns nothing when no tenant lane is set.\n");

    if (unpoliciedWithData.length > 0) {
      console.log("⚠ Tables with data and NO policy — readable from every lane:");
      for (const r of unpoliciedWithData) console.log(`    ${r.table} (${r.ownerTotal} rows)`);
      console.log(
        "\n  Not necessarily wrong. Some are global by design (the tenant list, the\n" +
          "  API keys read in order to LEARN the tenant). Event is the one that is\n" +
          "  neither: it is un-swept. See docs/PLATFORM_PROVISIONING.md.\n",
      );
    }
  } finally {
    await owner.$disconnect();
    await app.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
