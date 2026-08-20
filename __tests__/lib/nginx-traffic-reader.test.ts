/**
 * Reader for the nginx traffic snapshot.
 *
 * The file is written by our own host script, but it is read by a privileged
 * page, so the parse is defensive. The cases that matter are the ones where
 * being wrong is invisible: a missing file must read as "not set up yet" rather
 * than an error somebody ignores, and a failed read must NEVER surface as an
 * empty chart, because an empty traffic chart reads as "no traffic" and an
 * operator could plan a maintenance window around it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { fetchNginxTraffic } from "@/lib/infra/nginx-traffic";

let dir: string;
let file: string;

function bucket(h: string, over: Record<string, unknown> = {}) {
  return {
    h, total: 10, bot: 4, s2: 9, s3: 0, s4: 1, s5: 0,
    page: [3, 1], api: [2, 0], asset: [1, 0], health: [0, 3], other: [0, 0],
    ...over,
  };
}

function write(payload: unknown) {
  writeFileSync(file, typeof payload === "string" ? payload : JSON.stringify(payload));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nginx-traffic-"));
  file = join(dir, "nginx-traffic.json");
  vi.stubEnv("NGINX_TRAFFIC_FILE", file);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("fetchNginxTraffic", () => {
  it("reports a missing file as unconfigured, not an error", async () => {
    // A fresh box has no snapshot until the cron is installed. Calling that an
    // error trains an operator to ignore the card's amber state.
    const r = await fetchNginxTraffic();
    expect(r.status).toBe("unconfigured");
    expect(r.info).toBeNull();
    expect(r.error).toMatch(/cron/i);
  });

  it("reports unparseable JSON as an error, never as empty data", async () => {
    write("{ not json");
    const r = await fetchNginxTraffic();
    expect(r.status).toBe("error");
    expect(r.info).toBeNull();
  });

  it("refuses a snapshot with no usable timestamp", async () => {
    // Without generatedAt there is no way to know whether the numbers are from
    // this hour or last month, which is the one thing the card must not fake.
    write({ generatedAt: "not-a-date", buckets: [bucket("2026-08-20T08")] });
    const r = await fetchNginxTraffic();
    expect(r.status).toBe("error");
  });

  it("parses a valid snapshot and sorts buckets ascending", async () => {
    write({
      generatedAt: new Date().toISOString(),
      windowDays: 16, archiveDays: 400,
      oldestBucket: "2026-08-19T00", newestBucket: "2026-08-20T09",
      buckets: [bucket("2026-08-20T09"), bucket("2026-08-19T00")],
      topPaths: [{ path: "/e/x/register", count: 12 }],
      topReferrers: [{ host: "linkedin.com", count: 4 }],
    });
    const r = await fetchNginxTraffic();
    expect(r.status).toBe("ok");
    expect(r.info!.buckets.map((b) => b.h)).toEqual(["2026-08-19T00", "2026-08-20T09"]);
    expect(r.info!.topPaths[0].path).toBe("/e/x/register");
    expect(r.info!.buckets[0].page).toEqual([3, 1]);
  });

  it("drops a bucket whose hour key is malformed rather than rendering a gap", async () => {
    // An unparseable hour becomes an "Invalid Date" column in the chart, which
    // looks like a real data point. Dropping the row is the honest answer.
    write({
      generatedAt: new Date().toISOString(),
      buckets: [bucket("2026-08-20T08"), bucket("nonsense"), bucket("2026-08-20")],
    });
    const r = await fetchNginxTraffic();
    expect(r.info!.buckets).toHaveLength(1);
    expect(r.info!.buckets[0].h).toBe("2026-08-20T08");
  });

  it("coerces hostile field types instead of trusting them", async () => {
    write({
      generatedAt: new Date().toISOString(),
      buckets: [bucket("2026-08-20T08", { total: "999", bot: -5, page: "nope" })],
    });
    const r = await fetchNginxTraffic();
    expect(r.info!.buckets[0].total).toBe(0); // a string is not a count
    expect(r.info!.buckets[0].bot).toBe(0); // negatives are floored
    expect(r.info!.buckets[0].page).toEqual([0, 0]);
  });

  it("flags a snapshot older than the hourly cadence as stale", async () => {
    // The cron runs hourly; past ~2.5h it has stopped. Showing last week's
    // numbers as current is worse than showing nothing.
    write({
      generatedAt: new Date(Date.now() - 5 * 3600_000).toISOString(),
      buckets: [bucket("2026-08-20T08")],
    });
    const r = await fetchNginxTraffic();
    expect(r.info!.stale).toBe(true);
    expect(r.info!.ageMinutes).toBeGreaterThan(150);
  });

  it("does not flag a fresh snapshot as stale", async () => {
    write({
      generatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      buckets: [bucket("2026-08-20T08")],
    });
    const r = await fetchNginxTraffic();
    expect(r.info!.stale).toBe(false);
  });
});
