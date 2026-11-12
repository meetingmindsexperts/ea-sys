/**
 * The per-test reset survives a write that is still in flight (Nov 12, 2026).
 *
 * `resetCrm()` truncates Organization + User CASCADE. A service that returned
 * while one of its fire-and-forget writes was still running leaves a statement
 * that holds a child table and is about to lock Organization, while the
 * TRUNCATE holds Organization and waits for the child. Postgres calls that a
 * deadlock and aborts one of them; when it was the TRUNCATE, the NEXT test
 * failed in `beforeEach` and a deploy was blocked by a test that had not run.
 *
 * This builds that deadlock on purpose, on a real Postgres, because only a
 * real one says what the error looks like when it comes back through Prisma
 * (P2010 with 40P01 in `meta`), which is what the retry has to recognise.
 *
 * Run: INTEGRATION_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/crm_test npm run test:integration-db
 */
import { describe, it, expect, afterAll } from "vitest";
import { db } from "@/lib/db";
import { resetCrm, resetStats } from "./helper";

afterAll(async () => {
  await db.$disconnect();
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("resetCrm (real DB)", () => {
  it("runs its TRUNCATE again when a write still in flight deadlocks it", async () => {
    const seed = await resetCrm();
    const retriesBefore = resetStats.deadlockRetries;

    // The straggler, at the instant that matters: an INSERT takes its own
    // table's lock when it starts and its parent's (the foreign-key check, a
    // row share lock on Organization) when it ends. Between the two, the
    // TRUNCATE can take Organization and queue for the child. A single INSERT
    // cannot be paused there, so the two locks are taken apart, by hand.
    let holdingChild!: () => void;
    const childHeld = new Promise<void>((resolve) => (holdingChild = resolve));
    const straggler = db
      .$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('LOCK TABLE "CrmActivity" IN ROW EXCLUSIVE MODE');
          holdingChild();
          // Long enough for the reset below to take Organization and start waiting for CrmActivity.
          await pause(500);
          await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${seed.orgId} FOR SHARE`;
        },
        { timeout: 20_000 },
      )
      .then(
        () => "committed" as const,
        (err: unknown) => (/deadlock detected/i.test(String((err as Error)?.message)) ? ("lost the deadlock" as const) : Promise.reject(err)),
      );

    await childHeld;
    const next = await resetCrm();
    const outcome = await straggler;

    // The reset finished, whichever of the two Postgres aborted.
    expect(await db.organization.count()).toBe(1);
    expect(await db.user.count()).toBe(1);
    expect(next.orgId).not.toBe(seed.orgId);
    expect(await db.crmActivity.count()).toBe(0);
    // And it was a real deadlock: either the TRUNCATE lost and was run again
    // (the case that used to fail the next test), or the straggler lost.
    expect(resetStats.deadlockRetries > retriesBefore || outcome === "lost the deadlock", `retries ${resetStats.deadlockRetries - retriesBefore}, straggler ${outcome}`).toBe(true);
  });
});
