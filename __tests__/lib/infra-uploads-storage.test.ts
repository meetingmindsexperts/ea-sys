/**
 * Unit tests for the "Uploads storage" infra section (Sep 7, 2026).
 *
 * The section reads the S3 bucket behind /uploads three ways (our own bounded
 * inventory, CloudWatch storage + request metrics, six configuration checks)
 * plus the access-log delivery state. What these pin:
 *
 * 1. STORAGE_PROVIDER other than s3 is "unconfigured" and touches no AWS API.
 * 2. Inventory aggregates by first path segment, finds the newest object, and
 *    counts what is older than the mirror grace window.
 * 3. A configuration read the role cannot perform degrades THAT check to
 *    ok:null with a "not readable" detail; the rest of the card stands. A
 *    missing IAM action must never render as a pass.
 * 4. Request metrics with no datapoint at all read as "not enabled", never as
 *    zero traffic; with datapoints, only the last 24h are summed.
 * 5. Access logs: disabled means no listing of any log bucket; a simple prefix
 *    lists from two days ago via StartAfter; a partitioned prefix is walked
 *    down to today's and yesterday's folders.
 * 6. A truncated inventory is reported (and logged), not silently capped.
 * 7. An inventory failure is the section's failure, with the IAM hint.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const s3Send = vi.fn();
const cwSend = vi.fn();

vi.mock("@aws-sdk/client-s3", () => {
  const cmd = (kind: string) =>
    class {
      readonly kind = kind;
      constructor(public input: Record<string, unknown>) {}
    };
  return {
    S3Client: class { send = s3Send; },
    ListObjectsV2Command: cmd("list"),
    ListObjectVersionsCommand: cmd("versions"),
    HeadObjectCommand: cmd("head"),
    GetBucketVersioningCommand: cmd("getVersioning"),
    GetBucketEncryptionCommand: cmd("getEncryption"),
    GetPublicAccessBlockCommand: cmd("getPab"),
    GetBucketLifecycleConfigurationCommand: cmd("getLifecycle"),
    GetBucketLoggingCommand: cmd("getLogging"),
    ListBucketMetricsConfigurationsCommand: cmd("listMetricsConfigs"),
  };
});
vi.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: class { send = cwSend; },
  DescribeAlarmsCommand: class { constructor(public input: Record<string, unknown>) {} },
  GetMetricDataCommand: class { readonly kind = "getMetricData"; constructor(public input: Record<string, unknown>) {} },
}));
vi.mock("@/lib/db", () => ({ db: {}, dbOperator: {} }));
const warnMock = vi.fn();
vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: (...args: unknown[]) => warnMock(...args), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/worker-jobs", () => ({ EXPECTED_JOBS: [] }));
vi.mock("@/lib/build-info", () => ({ getBuildInfo: () => ({}) }));
vi.mock("@/lib/admin-alert", () => ({ getAlertSilence: vi.fn() }));

import { fetchUploads, resetInfraClients } from "@/lib/infra/aws-ops";

type Cmd = { kind: string; input: Record<string, unknown> };
const H = 3600_000;
const now = Date.now();
const BUCKET = "ea-sys-uploads";
const LOGS = "ea-sys-uploads-logs";

function accessDenied(): Error {
  const e = new Error("User is not authorized to perform: s3:GetBucketVersioning");
  e.name = "AccessDenied";
  return e;
}

/** The healthy bucket. Tests override single kinds through `overrides`. */
function handler(overrides: Record<string, (c: Cmd) => unknown> = {}) {
  return async (c: Cmd) => {
    if (overrides[c.kind]) return overrides[c.kind](c);
    switch (c.kind) {
      case "list": {
        if (c.input.Delimiter) return { CommonPrefixes: [{ Prefix: `${c.input.Prefix}x/` }] };
        if (c.input.Bucket === LOGS) {
          return {
            Contents: [
              { Key: `${c.input.Prefix}a.log`, Size: 10, LastModified: new Date(now - 1 * H) },
              { Key: `${c.input.Prefix}b.log`, Size: 10, LastModified: new Date(now - 30 * H) },
            ],
          };
        }
        return {
          Contents: [
            { Key: "photos/2026/09/a.jpg", Size: 100, LastModified: new Date(now - 10 * 60_000) },
            { Key: "media/2026/08/x.png", Size: 200, LastModified: new Date(now - 5 * 24 * H) },
            { Key: ".gitkeep", Size: 0, LastModified: new Date(now - 5 * 24 * H) },
          ],
        };
      }
      case "versions":
        return { Versions: [{ IsLatest: true, Size: 100 }, { IsLatest: false, Size: 50 }], DeleteMarkers: [{}] };
      case "getVersioning":
        return { Status: "Enabled" };
      case "getEncryption":
        return {
          ServerSideEncryptionConfiguration: {
            Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms", KMSMasterKeyID: "arn:aws:kms:ap-south-1:1:key/3371fc94-b72a-486e-8b57-bcff57474783" }, BucketKeyEnabled: false }],
          },
        };
      case "getPab":
        return { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } };
      case "getLifecycle": {
        const e = new Error("The lifecycle configuration does not exist");
        e.name = "NoSuchLifecycleConfiguration";
        throw e;
      }
      case "listMetricsConfigs":
        return { MetricsConfigurationList: [{ Id: "EntireBucket" }] };
      case "getLogging":
        return { LoggingEnabled: { TargetBucket: LOGS, TargetPrefix: "uploads-access/", TargetObjectKeyFormat: { PartitionedPrefix: { PartitionDateSource: "EventTime" } } } };
      default:
        throw new Error(`unexpected command ${c.kind}`);
    }
  };
}

const series = (points: [number, number][]) => ({
  Timestamps: points.map(([age]) => new Date(now - age)),
  Values: points.map(([, v]) => v),
});
function cwHealthy() {
  return {
    MetricDataResults: [
      { Id: "size", ...series([[12 * H, 71_000_000]]) },
      { Id: "count", ...series([[12 * H, 537]]) },
      { Id: "reqAll", ...series([[1 * H, 10], [2 * H, 20], [48 * H, 1000]]) },
      { Id: "reqGet", ...series([[1 * H, 9], [2 * H, 18]]) },
      { Id: "reqPut", ...series([[1 * H, 1], [2 * H, 2]]) },
      { Id: "req4xx", ...series([[1 * H, 3]]) },
      { Id: "req5xx", ...series([[1 * H, 0]]) },
      { Id: "reqFbl", ...series([[1 * H, 10], [2 * H, 30]]) },
    ],
  };
}

const ENV = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  resetInfraClients();
  process.env.STORAGE_PROVIDER = "s3";
  process.env.S3_UPLOADS_BUCKET = BUCKET;
  process.env.S3_UPLOADS_REGION = "ap-south-1";
  delete process.env.S3_UPLOADS_METRICS_FILTER_ID;
  s3Send.mockImplementation(handler());
  cwSend.mockResolvedValue(cwHealthy());
});
afterEach(() => {
  process.env = { ...ENV };
});

describe("fetchUploads — provider gate", () => {
  it("is unconfigured, and touches no AWS API, when uploads are on local disk", async () => {
    process.env.STORAGE_PROVIDER = "local";
    const out = await fetchUploads();
    expect(out).toEqual({ status: "unconfigured", info: null });
    expect(s3Send).not.toHaveBeenCalled();
    expect(cwSend).not.toHaveBeenCalled();
  });

  it("is an error (logged) when the provider is s3 but no bucket is named", async () => {
    delete process.env.S3_UPLOADS_BUCKET;
    const out = await fetchUploads();
    expect(out.status).toBe("error");
    expect(out.error).toMatch(/S3_UPLOADS_BUCKET/);
    expect(warnMock).toHaveBeenCalledWith(expect.anything(), "infra:uploads-bucket-unset");
  });
});

describe("fetchUploads — healthy bucket", () => {
  it("aggregates the inventory by first segment, finds the newest object, counts what is old enough to be mirrored", async () => {
    const out = await fetchUploads();
    expect(out.status).toBe("ok");
    const u = out.info!;
    expect(u.bucket).toBe(BUCKET);
    expect(u.objectCount).toBe(3);
    expect(u.totalBytes).toBe(300);
    expect(u.inventoryTruncated).toBe(false);
    expect(u.byPrefix.map((p) => p.prefix)).toEqual(["media", "photos", "(root)"]);
    expect(u.newestKey).toBe("photos/2026/09/a.jpg");
    expect(u.objectsOlderThanGrace).toBe(2);
    expect(u.mirrorGraceHours).toBe(3);
    expect(u.versions).toEqual({ noncurrentCount: 1, noncurrentBytes: 50, deleteMarkers: 1, truncated: false });
  });

  it("reads the daily storage metrics and sums only the last 24h of request metrics", async () => {
    const u = (await fetchUploads()).info!;
    expect(u.cloudwatch.sizeBytes).toBe(71_000_000);
    expect(u.cloudwatch.objectCount).toBe(537);
    expect(u.cloudwatch.asOf).not.toBeNull();
    expect(u.requests.enabled).toBe(true);
    expect(u.requests.filterId).toBe("EntireBucket");
    expect(u.requests.all).toBe(30); // the 48h-old 1000 is outside the window
    expect(u.requests.get).toBe(27);
    expect(u.requests.put).toBe(3);
    expect(u.requests.errors4xx).toBe(3);
    expect(u.requests.errors5xx).toBe(0);
    expect(u.requests.firstByteMs).toBe(20);
  });

  it("runs every configuration check and records the lifecycle gap as a failed warn-level check", async () => {
    const u = (await fetchUploads()).info!;
    const byLabel = Object.fromEntries(u.checks.map((c) => [c.label, c]));
    expect(byLabel["Versioning"]).toMatchObject({ ok: true, severity: "critical" });
    expect(byLabel["Encryption"]).toMatchObject({ ok: true, severity: "critical" });
    expect(byLabel["Encryption"].detail).toContain("bcff57474783".slice(-8));
    expect(byLabel["Bucket Key"]).toMatchObject({ ok: false, severity: "info" });
    expect(byLabel["Block public access"]).toMatchObject({ ok: true, severity: "critical" });
    expect(byLabel["Lifecycle"]).toMatchObject({ ok: false, severity: "warn" });
    expect(byLabel["Request metrics"]).toMatchObject({ ok: true, severity: "info" });
    expect(byLabel["Access logging"]).toMatchObject({ ok: true, severity: "warn" });
    // A configuration gap is not an unreadable check.
    expect(warnMock).not.toHaveBeenCalledWith(expect.anything(), "infra:uploads-check-unreadable");
  });

  it("walks a partitioned access-log prefix to today's and yesterday's folders and counts the last 24h", async () => {
    const u = (await fetchUploads()).info!;
    expect(u.accessLogs).toMatchObject({ enabled: true, targetBucket: LOGS, targetPrefix: "uploads-access/", partitioned: true, logObjects24h: 2 });
    expect(u.accessLogs.newestLogAt).toBe(new Date(now - 1 * H).toISOString());
    const dayLists = s3Send.mock.calls.map((c) => c[0] as Cmd).filter((c) => c.kind === "list" && c.input.Bucket === LOGS && !c.input.Delimiter);
    expect(dayLists).toHaveLength(2);
    const today = new Date(now).toISOString().slice(0, 10).replace(/-/g, "/");
    expect(dayLists.map((c) => c.input.Prefix)).toContain(`uploads-access/x/x/x/${today}/`);
  });
});

describe("fetchUploads — degradation", () => {
  it("a config read the role cannot perform degrades only that check to ok:null, and is logged", async () => {
    s3Send.mockImplementation(handler({ getVersioning: () => { throw accessDenied(); } }));
    const out = await fetchUploads();
    expect(out.status).toBe("ok");
    const versioning = out.info!.checks.find((c) => c.label === "Versioning")!;
    expect(versioning.ok).toBeNull();
    expect(versioning.detail).toMatch(/not readable/);
    expect(out.info!.checks.find((c) => c.label === "Encryption")!.ok).toBe(true);
    expect(warnMock).toHaveBeenCalledWith(expect.objectContaining({ label: "Versioning" }), "infra:uploads-check-unreadable");
  });

  it("request metrics with no datapoint at all read as not enabled, never as zero traffic", async () => {
    cwSend.mockResolvedValue({ MetricDataResults: [{ Id: "size", Timestamps: [], Values: [] }, { Id: "reqAll", Timestamps: [], Values: [] }] });
    const u = (await fetchUploads()).info!;
    expect(u.requests.enabled).toBe(false);
    expect(u.requests.all).toBeNull();
    expect(u.requests.errors5xx).toBeNull();
    expect(u.cloudwatch.sizeBytes).toBeNull();
  });

  it("a CloudWatch failure leaves the inventory standing", async () => {
    cwSend.mockRejectedValue(accessDenied());
    const out = await fetchUploads();
    expect(out.status).toBe("ok");
    expect(out.info!.objectCount).toBe(3);
    expect(out.info!.requests.enabled).toBe(false);
    expect(warnMock).toHaveBeenCalledWith(expect.anything(), "infra:uploads-cloudwatch-failed");
  });

  it("access logging off means no log bucket is listed", async () => {
    s3Send.mockImplementation(handler({ getLogging: () => ({}) }));
    const u = (await fetchUploads()).info!;
    expect(u.accessLogs).toMatchObject({ enabled: false, targetBucket: null, logObjects24h: null });
    expect(u.checks.find((c) => c.label === "Access logging")).toMatchObject({ ok: false, severity: "warn" });
    const logLists = s3Send.mock.calls.map((c) => c[0] as Cmd).filter((c) => c.kind === "list" && c.input.Bucket === LOGS);
    expect(logLists).toHaveLength(0);
  });

  it("a simple access-log prefix lists from two days ago with StartAfter instead of walking the history", async () => {
    s3Send.mockImplementation(handler({ getLogging: () => ({ LoggingEnabled: { TargetBucket: LOGS, TargetPrefix: "logs/" } }) }));
    const u = (await fetchUploads()).info!;
    expect(u.accessLogs.partitioned).toBe(false);
    const logList = s3Send.mock.calls.map((c) => c[0] as Cmd).find((c) => c.kind === "list" && c.input.Bucket === LOGS)!;
    const twoDaysAgo = new Date(now - 2 * 24 * H).toISOString().slice(0, 10);
    expect(logList.input.StartAfter).toBe(`logs/${twoDaysAgo}`);
  });

  it("an unlistable log bucket is reported on the access-logs row, not as the section's failure", async () => {
    s3Send.mockImplementation(handler({ list: (c) => { if (c.input.Bucket === LOGS) throw accessDenied(); return handler()(c); } }));
    const out = await fetchUploads();
    expect(out.status).toBe("ok");
    expect(out.info!.accessLogs.enabled).toBe(true);
    expect(out.info!.accessLogs.error).toMatch(/not readable/);
    expect(out.info!.accessLogs.logObjects24h).toBeNull();
  });

  it("a truncated inventory is reported and logged, not silently capped", async () => {
    let page = 0;
    s3Send.mockImplementation(handler({
      list: (c) => {
        if (c.input.Bucket === LOGS) return { Contents: [] };
        page += 1;
        return { Contents: [{ Key: `photos/${page}.jpg`, Size: 1, LastModified: new Date(now) }], IsTruncated: true, NextContinuationToken: `t${page}` };
      },
    }));
    const u = (await fetchUploads()).info!;
    expect(u.inventoryTruncated).toBe(true);
    expect(u.objectCount).toBe(10);
    expect(warnMock).toHaveBeenCalledWith(expect.objectContaining({ bucket: BUCKET }), "infra:s3-list-truncated");
  });

  it("an inventory the role cannot read is the section's failure, with the IAM hint", async () => {
    s3Send.mockImplementation(handler({ list: (c) => { if (c.input.Bucket === BUCKET && !c.input.Delimiter) throw accessDenied(); return handler()(c); } }));
    const out = await fetchUploads();
    expect(out.status).toBe("error");
    expect(out.error).toMatch(/Missing IAM permission/);
    expect(out.info).toBeNull();
    expect(warnMock).toHaveBeenCalledWith(expect.anything(), "infra:uploads-failed");
  });
});
