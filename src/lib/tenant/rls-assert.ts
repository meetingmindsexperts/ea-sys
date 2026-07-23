/**
 * RLS enforcement tripwire (Contacts pilot C3 review H1, owner decision
 * July 23, 2026: REFUSE TO BOOT).
 *
 * The shared policy files (prisma/rls/*.sql) deliberately omit FORCE ROW
 * LEVEL SECURITY — enforcement comes from connecting as a NON-owner app
 * role. That leaves exactly one silent failure mode: a deployment that
 * claims enforcement (RLS_SET_LOCAL=1) but connects as a role Postgres
 * exempts from RLS (the table owner — e.g. Supabase's DEFAULT connection
 * string — or a superuser / BYPASSRLS role). Every policy then no-ops with
 * no error and no log line, and every tenant can read every tenant's rows.
 *
 * This assert converts that silent hole into a loud boot failure:
 *   - flag OFF (master today): zero-cost no-op, no DB call;
 *   - flag ON: every table that carries at least one policy must report
 *     row_security_active() = true for the CONNECTED role, and at least one
 *     policied table must exist at all (a bootstrap that forgot to apply
 *     prisma/rls/*.sql is the same class of misconfiguration).
 *
 * Callers (both entry points):
 *   - src/instrumentation.ts  → throw = Next.js server refuses to start
 *   - worker/index.ts         → process.exit(1) on rejection
 *
 * row_security_active(oid) is evaluated by Postgres for the CURRENT role,
 * which is exactly the question we're asking; using the oid from pg_policy's
 * own join means no identifier quoting and the check self-extends to every
 * future prisma/rls/<domain>.sql without a hand-maintained table list.
 */

type RlsQueryClient = {
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
};

const POLICIED_TABLES_SQL = `
  SELECT c.relname AS "table", row_security_active(c.oid) AS "active"
  FROM (SELECT DISTINCT polrelid FROM pg_policy) p
  JOIN pg_class c ON c.oid = p.polrelid
  ORDER BY c.relname
`;

export async function assertRlsEnforced(client: RlsQueryClient): Promise<void> {
  if (process.env.RLS_SET_LOCAL !== "1") return;

  const rows = await client.$queryRawUnsafe<{ table: string; active: boolean }[]>(
    POLICIED_TABLES_SQL,
  );

  if (rows.length === 0) {
    throw new Error(
      "RLS_SET_LOCAL=1 but the database has ZERO row-level-security policies — " +
        "the bootstrap did not apply prisma/rls/*.sql. Refusing to serve without " +
        "tenant isolation.",
    );
  }

  const bypassed = rows.filter((r) => !r.active);
  if (bypassed.length > 0) {
    throw new Error(
      `RLS_SET_LOCAL=1 but row-level security is NOT active for the connected role on: ` +
        `${bypassed.map((r) => r.table).join(", ")}. The connection role bypasses RLS ` +
        `(table owner / superuser / BYPASSRLS — e.g. Supabase's default connection ` +
        `string). Connect as a NON-owner app role (see tests/tenancy/policies/` +
        `00-roles.sql, the reference role split). Refusing to serve without tenant ` +
        `isolation.`,
    );
  }
}
