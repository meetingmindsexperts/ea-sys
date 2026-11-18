import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { RLS_APP_URL, RLS_DB_NAME, RLS_OWNER_URL, RLS_SERVER_LOG } from "./rls-env";

/**
 * What the test server said while the suite and the pages ran against it, and
 * whether the run was under row security at all.
 *
 * Under row security the failures that matter do not fail a request:
 *   - a WRITE the policy refuses is often fire-and-forget (a notice, a seed of
 *     templates): the route answers 200 and only the log says the row was not
 *     written. That is how an unstamped template seed was found on Nov 17, 2026.
 *   - a READ of Event outside a lane returns nothing, and the detector names it.
 *   - a page that throws has already answered 200 (it streams).
 * So this runs last and reads the log. It is the assertion of the whole run.
 *
 * WHAT IT DOES NOT SEE, so nobody reads a green run as more than it is:
 *   - an UPDATE or DELETE outside or across a lane: the policy filters it to
 *     zero rows and Postgres raises nothing;
 *   - a read outside a lane on any table but Event (the detector watches Event
 *     only), or made with raw SQL, or nested under another model;
 *   - the worker: no job runs beside the test server;
 *   - any write no browser spec makes (most POST, PUT and DELETE routes, the
 *     webhooks, the agent's tools).
 * Those are the tenancy harness's job (`npm run test:tenancy`) and the lane
 * test's; this run is the one that sees the whole product at once.
 */

const REFUSED_WRITE = "violates row-level security";
const READ_OUTSIDE_A_LANE = "tenant:event-query-no-lane";
/** The detector switching itself off, or hitting its cap: after either it reports nothing more. */
const DETECTOR_STOPPED = ["tenant:event-shadow-failed", "tenant:event-shadow-capped"];
const UNHANDLED = "request:unhandled-error";
/**
 * Unhandled errors that are the test server's own arrangement, not the
 * product: AWS is pointed at a dead address on purpose (playwright.rls.config.ts).
 */
const EXPECTED_UNHANDLED = [/ECONNREFUSED 127\.0\.0\.1:9\b/];
/** Postgres 42501 and its relatives, as Prisma relays them. */
const PERMISSION = /permission denied (?:for|to) [^"\\,]{0,60}(?:"(\w+)")?|must be owner of [^"\\,]{0,60}/;

function readLog(): string[] {
  const file = path.resolve(process.cwd(), RLS_SERVER_LOG);
  expect(fs.existsSync(file), `${RLS_SERVER_LOG} exists`).toBe(true);
  return fs.readFileSync(file, "utf8").split("\n");
}

test("the app's database role is one the policies apply to", async () => {
  // Without this the whole run can be green and mean nothing: an owner or a
  // role with BYPASSRLS ignores every policy.
  const app = new PrismaClient({ datasourceUrl: RLS_APP_URL });
  const owner = new PrismaClient({ datasourceUrl: RLS_OWNER_URL });
  try {
    const [role] = await app.$queryRawUnsafe<{ rolsuper: boolean; rolbypassrls: boolean; owns: number }[]>(
      `SELECT r.rolsuper, r.rolbypassrls,
              (SELECT count(*)::int FROM pg_tables t WHERE t.schemaname = 'public' AND t.tableowner = current_user) AS owns
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    expect(role, "the app's role").toEqual({ rolsuper: false, rolbypassrls: false, owns: 0 });
    // With no tenant named, the restricted role sees no event; the owner sees the seeded ones.
    const [seenByApp] = await app.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "Event"`);
    const [seenByOwner] = await owner.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "Event"`);
    expect(seenByOwner.n, "the database holds events").toBeGreaterThan(0);
    expect(seenByApp.n, "events visible to the app's role with no tenant named").toBe(0);
  } finally {
    await app.$disconnect();
    await owner.$disconnect();
  }
});

test("the detector's messages are the ones this spec searches for", () => {
  // The searches below are plain strings. If the detector's messages were
  // renamed, every search would find nothing and pass for ever.
  const source = fs.readFileSync(path.resolve(process.cwd(), "src/lib/tenant/lane-shadow.ts"), "utf8");
  for (const message of [READ_OUTSIDE_A_LANE, ...DETECTOR_STOPPED]) {
    expect(source, `lane-shadow.ts still logs "${message}"`).toContain(`"${message}"`);
  }
});

test("the server log holds no refused write, no Event read outside a lane, no page that threw", async () => {
  // A fire-and-forget write started by the last requests needs a moment to land.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const lines = readLog();
  const having = (needle: string) => lines.filter((l) => l.includes(needle));
  const sample = (found: string[]) => found.slice(0, 5).map((l) => l.slice(0, 500));

  // This log is from THIS run's server, on the row security database, with the privileged lane set up.
  expect(having(`localhost:55432/${RLS_DB_NAME}`).length, "the launcher's line naming the row security database").toBeGreaterThan(0);
  expect(having("db:operator-lane-initialized").length, "the app started its privileged lane").toBeGreaterThan(0);

  const refused = having(REFUSED_WRITE);
  const noLane = having(READ_OUTSIDE_A_LANE);
  const stopped = DETECTOR_STOPPED.flatMap(having);
  const threw = having(UNHANDLED).filter((l) => !EXPECTED_UNHANDLED.some((expected) => expected.test(l)));
  const denied: Record<string, number> = {};
  for (const line of lines) {
    const match = PERMISSION.exec(line);
    if (match) denied[match[1] ?? match[0]] = (denied[match[1] ?? match[0]] ?? 0) + 1;
  }

  console.log(
    `[e2e:rls] server log: ${lines.length} lines, ${refused.length} refused writes, ${noLane.length} Event reads outside a lane, ` +
      `${threw.length} unhandled errors, permission denied: ${JSON.stringify(denied)}`,
  );
  expect(sample(refused), "writes refused by a row policy").toEqual([]);
  expect(sample(noLane), "Event reads made outside a tenant lane").toEqual([]);
  expect(sample(stopped), "the detector stopped reporting part-way").toEqual([]);
  expect(sample(threw), "requests that threw (a page that throws still answers 200)").toEqual([]);
  expect(denied, "objects the restricted role was refused on").toEqual({});
});
