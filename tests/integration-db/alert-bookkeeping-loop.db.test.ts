/**
 * The alert path must not alert about its own bookkeeping (Nov 18, 2026), on
 * a REAL Postgres.
 *
 * An error line becomes an alert; before sending, the alert path reads the
 * `AlertState` table. When that read failed with anything but a retryable
 * connection error, Prisma's error event logged it at error, which asked the
 * alert path to alert again, which read again: about 150 log lines a second,
 * for as long as the process lived. Found when a test server was started with
 * no database; on production a rotated database password, or a missing grant
 * on that one table, would have started it.
 *
 * Only a real database shows this: the loop runs through Prisma's own error
 * event, which a mocked client never emits. The table is renamed for the
 * length of a test so its reads fail the way a missing grant fails them, and
 * renamed back whatever happens.
 *
 * Run: INTEGRATION_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/crm_test npm run test:integration-db
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { dbLogger } from "@/lib/logger";
import { claimAlertSend } from "@/lib/admin-alert";
import { inAlertBookkeeping } from "@/lib/alert-bookkeeping";

const HIDDEN = "AlertState_hidden_by_test";

async function hideAlertState() {
  await db.$executeRawUnsafe(`ALTER TABLE "AlertState" RENAME TO "${HIDDEN}"`);
}

async function restoreAlertState() {
  await db.$executeRawUnsafe(`ALTER TABLE IF EXISTS "${HIDDEN}" RENAME TO "AlertState"`);
}

/** Prisma emits its error event on a later tick than the rejection. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

const messages = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((call) => (call[0] as { msg?: string } | undefined)?.msg);

describe("a failure of the alert system's own bookkeeping", () => {
  let error: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    error = vi.spyOn(dbLogger, "error").mockImplementation(() => undefined);
    warn = vi.spyOn(dbLogger, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await restoreAlertState();
  });

  it("is logged below the alerting level, and the alert still goes out", async () => {
    await hideAlertState();

    const claim = await claimAlertSend(`loop-test-${Date.now()}`);
    await settle();

    // The alert that was being sent is not lost: the in-memory record decides.
    expect(claim).toEqual({ send: true, suppressed: 0 });
    // Nothing at error: an error line here is what fed the loop.
    expect(messages(error)).toEqual([]);
    expect(messages(warn)).toContain("admin-alert:state-unavailable");
  });

  it("covers the raw statements, which reach the handler without naming the table", async () => {
    await inAlertBookkeeping(() => db.$queryRawUnsafe(`SELECT 1 FROM "NoSuchTableAtAll"`)).catch(() => undefined);
    await settle();

    expect(messages(error)).toEqual([]);
    expect(messages(warn)).toContain("admin-alert:state-unavailable");
  });

  it("covers a read of the table made outside the marked path", async () => {
    await hideAlertState();

    await db.alertState.findUnique({ where: { key: "__silence__" } }).catch(() => undefined);
    await settle();

    expect(messages(error)).toEqual([]);
    expect(messages(warn)).toContain("admin-alert:state-unavailable");
  });

  it("leaves every other failed query at error, where it alerts", async () => {
    await db.$queryRawUnsafe(`SELECT 1 FROM "NoSuchTableAtAll"`).catch(() => undefined);
    await settle();

    expect(messages(warn)).not.toContain("admin-alert:state-unavailable");
    expect(error).toHaveBeenCalled();
  });
});
