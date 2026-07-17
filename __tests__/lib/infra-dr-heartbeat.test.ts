/**
 * Unit tests for the DR card's uploads-mirror heartbeat (July 17, 2026).
 *
 * The "Uploads mirror — 15.3h ago" false alarm: fetchDr() aged the uploads
 * row off the newest object under uploads/, but the hourly `aws s3 sync`
 * only writes objects when a local file CHANGED — so a quiet stretch > 3h
 * tripped the alert while the cron was healthy. The fix: the cron writes
 * heartbeats/uploads-mirror after every successful sync, and the row uses
 * whichever is newer — heartbeat or newest uploads/ object (the fallback IS
 * the pre-fix behavior, so the card keeps working until the crontab change
 * lands). This suite pins:
 *
 * 1. Heartbeat missing (404) → fall back to newest-object age, no warn log
 *    (pre-crontab-change is an expected state, not an error).
 * 2. Heartbeat newer than the newest object → row is fresh even when no
 *    file changed for > staleAfterHours (kills the false-alarm class).
 * 3. Heartbeat AND newest object both old → row is stale (a genuinely dead
 *    cron is still detected).
 * 4. Non-404 heartbeat error (IAM/KMS/network) → logs infra:dr-heartbeat-failed
 *    at warn and degrades to the newest-object fallback, never throws.
 * 5. Only the uploads stream issues a HeadObject — db/ and env/ write a new
 *    object every run, so their newest-object age is already correct.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-s3", () => {
  class ListObjectsV2Command {
    readonly kind = "list";
    constructor(public input: { Bucket: string; Prefix: string; MaxKeys?: number }) {}
  }
  class HeadObjectCommand {
    readonly kind = "head";
    constructor(public input: { Bucket: string; Key: string }) {}
  }
  class S3Client {
    send = sendMock;
  }
  return { S3Client, ListObjectsV2Command, HeadObjectCommand };
});

// aws-ops.ts imports db (Prisma) and other server modules at module load —
// stub the ones that would touch real infrastructure.
vi.mock("@/lib/db", () => ({ db: {} }));
const warnMock = vi.fn();
vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: (...args: unknown[]) => warnMock(...args), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/worker-jobs", () => ({ EXPECTED_JOBS: [] }));
vi.mock("@/lib/build-info", () => ({ getBuildInfo: () => ({}) }));
vi.mock("@/lib/admin-alert", () => ({ getAlertSilence: vi.fn() }));

import { fetchDr, fetchDrHeartbeat } from "@/lib/infra/aws-ops";

const HOUR = 3600_000;
const now = Date.now();

type FakeCommand = { kind: "list" | "head"; input: { Prefix?: string; Key?: string } };

/** Route sendMock by command type + prefix/key. */
function routeSend(opts: {
  /** newest object LastModified per prefix; [] = empty prefix */
  objects: Record<string, Date[]>;
  /** heartbeat behavior: a Date, "missing" (404), or an Error to throw */
  heartbeat: Date | "missing" | Error;
}) {
  sendMock.mockImplementation(async (cmd: FakeCommand) => {
    if (cmd.kind === "head") {
      if (opts.heartbeat instanceof Error) throw opts.heartbeat;
      if (opts.heartbeat === "missing") {
        const err = new Error("NotFound") as Error & { name: string };
        err.name = "NotFound";
        throw err;
      }
      return { LastModified: opts.heartbeat };
    }
    const dates = opts.objects[cmd.input.Prefix as string] ?? [];
    return { Contents: dates.map((d, i) => ({ Key: `${cmd.input.Prefix}obj-${i}`, LastModified: d })) };
  });
}

function uploadsRow(rows: { label: string; latestAt: string | null; stale: boolean; ageHours: number | null }[]) {
  const row = rows.find((r) => r.label === "Uploads mirror");
  expect(row).toBeDefined();
  return row!;
}

beforeEach(() => {
  sendMock.mockReset();
  warnMock.mockReset();
});

describe("fetchDrHeartbeat", () => {
  it("returns the LastModified when the heartbeat object exists", async () => {
    const at = new Date(now - 10 * 60_000);
    routeSend({ objects: {}, heartbeat: at });
    await expect(fetchDrHeartbeat("heartbeats/uploads-mirror")).resolves.toEqual(at);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("returns null on 404 without logging — pre-crontab-change is expected, not an error", async () => {
    routeSend({ objects: {}, heartbeat: "missing" });
    await expect(fetchDrHeartbeat("heartbeats/uploads-mirror")).resolves.toBeNull();
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("logs infra:dr-heartbeat-failed at warn and returns null on a non-404 error", async () => {
    const boom = new Error("AccessDenied") as Error & { name: string };
    boom.name = "AccessDenied";
    routeSend({ objects: {}, heartbeat: boom });
    await expect(fetchDrHeartbeat("heartbeats/uploads-mirror")).resolves.toBeNull();
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: "heartbeats/uploads-mirror" }),
      "infra:dr-heartbeat-failed",
    );
  });
});

describe("fetchDr uploads-mirror row", () => {
  it("falls back to newest-object age when the heartbeat is missing (pre-fix behavior preserved)", async () => {
    const objectAt = new Date(now - 15.3 * HOUR);
    routeSend({ objects: { "uploads/": [objectAt] }, heartbeat: "missing" });
    const dr = await fetchDr();
    expect(dr.status).toBe("ok");
    const row = uploadsRow(dr.rows);
    expect(row.latestAt).toBe(objectAt.toISOString());
    expect(row.stale).toBe(true); // > 3h — exactly the July 17 false-alarm reading
  });

  it("is fresh when the heartbeat is recent even though no file changed for 15h — the false-alarm class", async () => {
    const heartbeatAt = new Date(now - 30 * 60_000); // last sync ran 30 min ago
    const objectAt = new Date(now - 15.3 * HOUR); // last actual upload 15.3h ago
    routeSend({ objects: { "uploads/": [objectAt] }, heartbeat: heartbeatAt });
    const dr = await fetchDr();
    const row = uploadsRow(dr.rows);
    expect(row.latestAt).toBe(heartbeatAt.toISOString());
    expect(row.stale).toBe(false);
    expect(row.ageHours).toBeLessThan(1);
  });

  it("still detects a genuinely dead cron: heartbeat AND objects both old → stale", async () => {
    routeSend({
      objects: { "uploads/": [new Date(now - 20 * HOUR)] },
      heartbeat: new Date(now - 6 * HOUR),
    });
    const dr = await fetchDr();
    const row = uploadsRow(dr.rows);
    expect(row.stale).toBe(true);
    // Uses the newer of the two (the heartbeat) as the honest timestamp.
    expect(row.ageHours).toBeGreaterThan(5.9);
    expect(row.ageHours).toBeLessThan(6.1);
  });

  it("degrades to the newest-object fallback when the heartbeat read errors (never fails the card)", async () => {
    const boom = new Error("KMS.DisabledException") as Error & { name: string };
    boom.name = "KMSDisabledException";
    const objectAt = new Date(now - 1 * HOUR);
    routeSend({ objects: { "uploads/": [objectAt] }, heartbeat: boom });
    const dr = await fetchDr();
    expect(dr.status).toBe("ok");
    const row = uploadsRow(dr.rows);
    expect(row.latestAt).toBe(objectAt.toISOString());
    expect(row.stale).toBe(false);
    expect(warnMock).toHaveBeenCalledWith(expect.anything(), "infra:dr-heartbeat-failed");
  });

  it("only the uploads stream issues a HeadObject — db/ and env/ stay newest-object based", async () => {
    routeSend({
      objects: {
        "db/": [new Date(now - 1 * HOUR)],
        "uploads/": [new Date(now - 1 * HOUR)],
        "env/": [new Date(now - 1 * HOUR)],
      },
      heartbeat: new Date(now - 30 * 60_000),
    });
    await fetchDr();
    const headCalls = sendMock.mock.calls.filter(([cmd]) => (cmd as FakeCommand).kind === "head");
    expect(headCalls).toHaveLength(1);
    expect((headCalls[0][0] as FakeCommand).input.Key).toBe("heartbeats/uploads-mirror");
  });

  it("marks a stream with no objects and no heartbeat as stale with null timestamps", async () => {
    routeSend({ objects: {}, heartbeat: "missing" });
    const dr = await fetchDr();
    const row = uploadsRow(dr.rows);
    expect(row.latestAt).toBeNull();
    expect(row.ageHours).toBeNull();
    expect(row.stale).toBe(true);
  });
});
