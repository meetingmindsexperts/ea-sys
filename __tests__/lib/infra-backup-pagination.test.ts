/**
 * Unit tests for the DR-bucket S3 listing pagination (July 20, 2026).
 *
 * The "Last database backup 21.2h ago" false alarm: fetchBackup() listed
 * db/ with a single MaxKeys:200 call. S3 returns keys lexicographically —
 * oldest-first for our db/{YYYY}/{MM}/{DD-HH} keys — so once the prefix
 * outgrew 200 objects (10 dumps/day under the 30-day lifecycle crossed the
 * threshold on July 20) the newest dumps fell off the truncated page and
 * "newest of what we got" was a 21h-old dump. The backups were healthy the
 * whole time; only the monitor's read was wrong.
 *
 * Fix: listAllObjects() follows ContinuationToken to a full listing, used by
 * BOTH fetchBackup() and fetchDr(). This suite pins:
 *
 * 1. THE regression: newest object on page 2 → fetchBackup reports it, not
 *    the newest of page 1.
 * 2. Single-page listing still works (no IsTruncated → one call).
 * 3. Empty prefix → error status (backups genuinely missing IS an alarm).
 * 4. fetchDr's db/ row paginates too (same bug class, MaxKeys:1000 variant).
 * 5. Runaway pagination is capped and logs infra:s3-list-truncated at warn —
 *    no silent caps.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-s3", () => {
  class ListObjectsV2Command {
    readonly kind = "list";
    constructor(
      public input: { Bucket: string; Prefix: string; MaxKeys?: number; ContinuationToken?: string },
    ) {}
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

vi.mock("@/lib/db", () => ({ db: {} }));
const warnMock = vi.fn();
vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: (...args: unknown[]) => warnMock(...args), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/worker-jobs", () => ({ EXPECTED_JOBS: [] }));
vi.mock("@/lib/build-info", () => ({ getBuildInfo: () => ({}) }));
vi.mock("@/lib/admin-alert", () => ({ getAlertSilence: vi.fn() }));

import { fetchBackup, fetchDr } from "@/lib/infra/aws-ops";

const HOUR = 3600_000;
const now = Date.now();

type ListCmd = {
  kind: "list" | "head";
  input: { Prefix?: string; Key?: string; ContinuationToken?: string };
};

type Page = { keys: [string, Date][]; nextToken?: string };

/**
 * Route list calls by prefix + continuation token. Pages keyed by token
 * ("" = first page). Head calls 404 (no heartbeat in these scenarios).
 */
function routePages(pagesByPrefix: Record<string, Record<string, Page>>) {
  sendMock.mockImplementation(async (cmd: ListCmd) => {
    if (cmd.kind === "head") {
      const err = new Error("NotFound") as Error & { name: string };
      err.name = "NotFound";
      throw err;
    }
    const pages = pagesByPrefix[cmd.input.Prefix as string] ?? {};
    const page = pages[cmd.input.ContinuationToken ?? ""] ?? { keys: [] };
    return {
      Contents: page.keys.map(([Key, LastModified]) => ({ Key, LastModified })),
      IsTruncated: page.nextToken !== undefined,
      NextContinuationToken: page.nextToken,
    };
  });
}

beforeEach(() => {
  sendMock.mockReset();
  warnMock.mockReset();
});

describe("fetchBackup pagination", () => {
  it("THE regression: reports the newest dump from page 2, not the newest of a truncated page 1", async () => {
    routePages({
      "db/": {
        // Page 1: the oldest objects — newest among them is 21h old (the false alarm).
        "": {
          keys: [
            ["db/2026/07/18-08-mumbai.dump", new Date(now - 45 * HOUR)],
            ["db/2026/07/19-08-mumbai.dump", new Date(now - 21.2 * HOUR)],
          ],
          nextToken: "t1",
        },
        // Page 2: the actually-newest dump, 1.2h old.
        t1: { keys: [["db/2026/07/20-04-mumbai.dump", new Date(now - 1.2 * HOUR)]] },
      },
    });
    const backup = await fetchBackup();
    expect(backup.status).toBe("ok");
    expect(backup.info?.latestKey).toBe("db/2026/07/20-04-mumbai.dump");
    expect(backup.info?.stale).toBe(false);
    expect(backup.info?.ageHours).toBeGreaterThan(1.1);
    expect(backup.info?.ageHours).toBeLessThan(1.3);
  });

  it("single un-truncated page: one list call, newest reported", async () => {
    routePages({
      "db/": { "": { keys: [["db/2026/07/20-04-mumbai.dump", new Date(now - 2 * HOUR)]] } },
    });
    const backup = await fetchBackup();
    expect(backup.status).toBe("ok");
    expect(backup.info?.stale).toBe(false);
    expect(sendMock.mock.calls).toHaveLength(1);
  });

  it("a genuinely old newest dump is still flagged stale — the real-alarm path survives", async () => {
    routePages({
      "db/": { "": { keys: [["db/2026/07/19-08-mumbai.dump", new Date(now - 21.2 * HOUR)]] } },
    });
    const backup = await fetchBackup();
    expect(backup.info?.stale).toBe(true);
  });

  it("empty prefix → error status (missing backups ARE an alarm)", async () => {
    routePages({ "db/": { "": { keys: [] } } });
    const backup = await fetchBackup();
    expect(backup.status).toBe("error");
    expect(backup.info?.stale).toBe(true);
  });

  it("caps runaway pagination and logs infra:s3-list-truncated at warn", async () => {
    // Every page claims another follows — the loop must stop and log, not spin.
    sendMock.mockImplementation(async (cmd: ListCmd) => ({
      Contents: [{ Key: `db/obj-${cmd.input.ContinuationToken ?? "start"}`, LastModified: new Date(now - 1 * HOUR) }],
      IsTruncated: true,
      NextContinuationToken: `${cmd.input.ContinuationToken ?? ""}x`,
    }));
    const backup = await fetchBackup();
    expect(backup.status).toBe("ok"); // degrades to what it collected
    expect(sendMock.mock.calls).toHaveLength(10);
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: "db/" }),
      "infra:s3-list-truncated",
    );
  });
});

describe("fetchDr db/ row pagination", () => {
  it("follows ContinuationToken for the DR-card streams too (same bug class)", async () => {
    routePages({
      "db/": {
        "": { keys: [["db/2026/07/19-08-mumbai.dump", new Date(now - 21.2 * HOUR)]], nextToken: "t1" },
        t1: { keys: [["db/2026/07/20-04-mumbai.dump", new Date(now - 1.2 * HOUR)]] },
      },
      "uploads/": { "": { keys: [["uploads/a.jpg", new Date(now - 1 * HOUR)]] } },
      "env/": { "": { keys: [["env/2026-07-19.env", new Date(now - 10 * HOUR)]] } },
    });
    const dr = await fetchDr();
    expect(dr.status).toBe("ok");
    const dbRow = dr.rows.find((r) => r.label === "Database dump");
    expect(dbRow).toBeDefined();
    expect(dbRow!.stale).toBe(false);
    expect(dbRow!.ageHours).toBeLessThan(1.3);
  });
});
