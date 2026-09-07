/**
 * Render test for the "Uploads storage" card body (Sep 7, 2026).
 *
 * /admin/infra is a dynamic client page: the build never renders it and no
 * route test reads it, so a card that throws on a real snapshot shape shows up
 * only in production, as a white page (Aug 25, 2026). The body is therefore a
 * component of its own and is rendered here, on the healthy shape and on every
 * degraded shape the fetcher can produce.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UploadsStorageBody } from "@/components/infra/uploads-storage-body";
import type { DrArtifact, UploadsStorage } from "@/lib/infra/aws-ops";

function healthy(): UploadsStorage {
  return {
    provider: "s3",
    bucket: "ea-sys-uploads",
    region: "ap-south-1",
    objectCount: 537,
    totalBytes: 71_239_235,
    objectsOlderThanGrace: 530,
    mirrorGraceHours: 3,
    inventoryTruncated: false,
    newestKey: "photos/2026/09/x.jpg",
    newestAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    byPrefix: [
      { prefix: "photos", objects: 422, bytes: 30_270_000 },
      { prefix: "media", objects: 69, bytes: 26_450_000 },
    ],
    versions: { noncurrentCount: 1, noncurrentBytes: 5, deleteMarkers: 1, truncated: false },
    cloudwatch: { sizeBytes: null, objectCount: null, asOf: null },
    requests: { enabled: true, filterId: "EntireBucket", all: 1200, get: 1100, put: 40, errors4xx: 3, errors5xx: 0, firstByteMs: 18 },
    checks: [
      { label: "Versioning", severity: "critical", ok: true, detail: "Enabled" },
      { label: "Bucket Key", severity: "info", ok: false, detail: "Off" },
      { label: "Block public access", severity: "critical", ok: true, detail: "All four settings on" },
      { label: "Lifecycle", severity: "warn", ok: false, detail: "No lifecycle rule" },
    ],
    accessLogs: { enabled: true, targetBucket: "ea-sys-uploads-logs", targetPrefix: "uploads-access/", partitioned: true, newestLogAt: new Date(Date.now() - 3600_000).toISOString(), logObjects24h: 20 },
  };
}
const mirror = (objectCount: number, listingTruncated = false): DrArtifact => ({
  label: "Uploads mirror", prefix: "uploads/", latestAt: "x", ageHours: 0.5, staleAfterHours: 3, stale: false, objectCount, listingTruncated,
});
const render = (u: UploadsStorage, m: DrArtifact | null = mirror(542)) =>
  renderToStaticMarkup(createElement(UploadsStorageBody, { u, mirror: m }));

describe("UploadsStorageBody", () => {
  it("renders the healthy shape: bucket, tiles, prefixes, requests, checks, access logs", () => {
    const html = render(healthy());
    expect(html).toContain("ea-sys-uploads · ap-south-1");
    expect(html).toContain("71.2 MB");
    expect(html).toContain("photos/");
    expect(html).toContain("Requests (24h)");
    expect(html).toMatch(/1[,.]?200/);
    expect(html).toContain("All four settings on");
    expect(html).toContain("No lifecycle rule");
    expect(html).toContain("542");
    expect(html).toContain("Access logs: on, to ea-sys-uploads-logs/uploads-access/");
    expect(html).toContain("20 file(s) in 24h");
    expect(html).toContain("CloudWatch storage metrics: no datapoint yet");
    expect(html).not.toContain("text-red-600");
  });

  it("marks a mirror that is short of the syncable source objects in red, and says by how much it is judged", () => {
    const html = render(healthy(), mirror(500));
    expect(html).toContain("text-red-600");
    expect(html).toContain("Short of the 530 source objects older than 3h");
  });

  it("does not judge a mirror whose listing was capped, and renders a dash with no mirror row", () => {
    expect(render(healthy(), mirror(500, true))).not.toContain("Short of the");
    expect(render(healthy(), null)).toContain("—");
  });

  it("says request metrics are not enabled (with the filter id) rather than showing zeros", () => {
    const u = healthy();
    u.requests = { enabled: false, filterId: "EntireBucket", all: null, get: null, put: null, errors4xx: null, errors5xx: null, firstByteMs: null };
    const html = render(u);
    expect(html).toContain("not enabled");
    expect(html).toContain("EntireBucket");
    expect(html).not.toContain("Requests (24h)</div><div class=\"grid");
  });

  it("renders every degraded shape without throwing", () => {
    const u = healthy();
    u.versions = null;
    u.inventoryTruncated = true;
    u.cloudwatch = { sizeBytes: 71_000_000, objectCount: 537, asOf: "2026-09-08T00:00:00.000Z" };
    u.checks.push({ label: "Access logging", severity: "warn", ok: null, detail: "not readable: the instance role lacks this read action" });
    const truncated = render(u);
    expect(truncated).toContain("537+");
    expect(truncated).toContain("Version history not readable");
    expect(truncated).toContain("CloudWatch: 71.0 MB / 537 objects");
    expect(truncated).toContain("not readable: the instance role lacks");

    const off = healthy();
    off.accessLogs = { enabled: false, targetBucket: null, targetPrefix: null, partitioned: false, newestLogAt: null, logObjects24h: null };
    expect(render(off)).toContain("Access logs: off");

    const unreadable = healthy();
    unreadable.accessLogs = { enabled: null, targetBucket: null, targetPrefix: null, partitioned: false, newestLogAt: null, logObjects24h: null, error: "not readable: denied" };
    expect(render(unreadable)).toContain("Access logs: not readable: denied");

    const unlistable = healthy();
    unlistable.accessLogs = { ...unlistable.accessLogs, newestLogAt: null, logObjects24h: null, error: "not readable: denied" };
    expect(render(unlistable)).toContain("but the log bucket is not readable: denied");
  });
});
