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
 * Two halves, both on a real Postgres:
 *  1. the retry itself, against an error Postgres really sends with SQLSTATE
 *     40P01, because only a real one says what it looks like when it comes
 *     back through Prisma (P2010 with 40P01 in `meta`), which is what the
 *     retry has to recognise. Deterministic: no race involved;
 *  2. the race itself, built on purpose with the same two locks in the same
 *     order as the CI failure. Postgres chooses which side to abort, and the
 *     reset must finish either way.
 *
 * Run: INTEGRATION_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/crm_test npm run test:integration-db
 */
import { describe, it, expect, afterAll } from "vitest";
import { db } from "@/lib/db";
import { resetCrm, resetStats, retryOnDeadlock } from "./helper";

afterAll(async () => {
  await db.$disconnect();
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolves once another session's TRUNCATE is blocked on a lock; throws if none
 * is within 15 seconds. Asked OUTSIDE the straggler's transaction on purpose:
 * inside one, Postgres answers pg_stat_activity from a snapshot taken at the
 * first look and the TRUNCATE would never appear.
 */
async function truncateIsWaiting(): Promise<void> {
  for (let i = 0; i < 150; i++) {
    const [row] = await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND query ILIKE 'TRUNCATE%'`;
    if (Number(row?.n ?? 0) > 0) return;
    await pause(100);
  }
  throw new Error("the reset's TRUNCATE never queued behind the straggler's lock");
}

/** A statement Postgres fails with the given SQLSTATE, through the same driver path as any other. */
const raise = (sqlstate: string) =>
  db.$executeRawUnsafe(`DO $$ BEGIN RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '${sqlstate}'; END $$`);

describe("retryOnDeadlock (real DB)", () => {
  it("runs the statement again after a 40P01 and returns its result", async () => {
    const before = resetStats.deadlockRetries;
    let calls = 0;
    const result = await retryOnDeadlock(async () => {
      calls += 1;
      if (calls === 1) await raise("40P01");
      return "done";
    });
    expect(result).toBe("done");
    expect(calls).toBe(2);
    expect(resetStats.deadlockRetries - before).toBe(1);
  });

  it("throws any other error at once", async () => {
    const before = resetStats.deadlockRetries;
    let calls = 0;
    // Division by zero's SQLSTATE: a real Postgres error that is not a deadlock.
    await expect(
      retryOnDeadlock(async () => {
        calls += 1;
        await db.$executeRawUnsafe(`DO $$ BEGIN RAISE EXCEPTION 'no such thing' USING ERRCODE = '22012'; END $$`);
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(resetStats.deadlockRetries - before).toBe(0);
  });

  it("gives up after six attempts and throws the deadlock", async () => {
    let calls = 0;
    await expect(
      retryOnDeadlock(async () => {
        calls += 1;
        await raise("40P01");
      }),
    ).rejects.toThrow(/deadlock detected/);
    expect(calls).toBe(6);
  });
});

describe("resetCrm (real DB)", () => {
  it("finishes when a write still in flight deadlocks its TRUNCATE, whichever side Postgres aborts", async () => {
    const seed = await resetCrm();
    const retriesBefore = resetStats.deadlockRetries;

    // The straggler, at the instant that matters: an INSERT takes its own
    // table's lock when it starts and its parent's (the foreign-key check, a
    // row share lock on Organization) when it ends. Between the two, the
    // TRUNCATE can take Organization and queue for the child. A single INSERT
    // cannot be paused there, so the two locks are taken apart, by hand.
    let holdingChild!: () => void;
    const childHeld = new Promise<void>((resolve) => (holdingChild = resolve));
    let askForParent!: () => void;
    const truncateQueued = new Promise<void>((resolve) => (askForParent = resolve));
    const straggler = db
      .$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('LOCK TABLE "CrmActivity" IN ROW EXCLUSIVE MODE');
          holdingChild();
          // Not a fixed pause: held here until Postgres itself shows the reset's
          // TRUNCATE queued behind a lock (it holds Organization by then and is
          // waiting for CrmActivity). A slow machine only makes this wait longer.
          await truncateQueued;
          await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${seed.orgId} FOR SHARE`;
        },
        { timeout: 25_000 },
      )
      .then(
        () => "committed" as const,
        (err: unknown) => (/deadlock detected/i.test(String((err as Error)?.message)) ? ("lost the deadlock" as const) : Promise.reject(err)),
      );

    await childHeld;
    const resetting = resetCrm();
    // Released whether or not the TRUNCATE was seen, so a failure here cannot leave the transaction open.
    await truncateIsWaiting().finally(askForParent);
    const next = await resetting;
    const outcome = await straggler;

    // The reset finished, whichever of the two Postgres aborted.
    expect(await db.organization.count()).toBe(1);
    expect(await db.user.count()).toBe(1);
    expect(next.orgId).not.toBe(seed.orgId);
    expect(await db.crmActivity.count()).toBe(0);
    // And it was a real deadlock: either the TRUNCATE lost and was run again
    // (the case that used to fail the next test), or the straggler lost.
    // Postgres picks; both happen on the same machine from run to run.
    expect(resetStats.deadlockRetries > retriesBefore || outcome === "lost the deadlock", `retries ${resetStats.deadlockRetries - retriesBefore}, straggler ${outcome}`).toBe(true);
  });
});
