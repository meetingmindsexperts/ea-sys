/**
 * Infra / Ops snapshot — read-only signals for the admin panel.
 *
 * Pulls a small set of high-value infra signals ON DEMAND (never polled) and
 * caches the result for 60s so hammering the refresh button can't run up AWS
 * cost. Every source is wrapped independently: one failing (e.g. IAM not yet
 * granted) degrades that card to an error state, never the whole panel.
 *
 *   - Deploys : GitHub Actions "Deploy to EC2" runs (needs GITHUB_OPS_TOKEN).
 *   - SES     : sending enabled / sandbox / 24h quota + 24h send-bounce-
 *               complaint counts + latest reputation rates.
 *   - Alarms  : any CloudWatch alarm currently in ALARM.
 *   - Metrics : EC2 CPU %, CPU credit balance (t3 throttle), memory, disk.
 *
 * Server-only. Region + credentials come from the same chain as SES (env →
 * instance role). IAM needed on the instance role: cloudwatch:DescribeAlarms,
 * cloudwatch:GetMetricData, ses:GetAccount. See docs/INFRA_OPS.md.
 */
import {
  CloudWatchClient,
  DescribeAlarmsCommand,
  GetMetricDataCommand,
  type MetricDataQuery,
} from "@aws-sdk/client-cloudwatch";
import { SESv2Client, GetAccountCommand } from "@aws-sdk/client-sesv2";
import { S3Client, ListObjectsV2Command, HeadObjectCommand } from "@aws-sdk/client-s3";
import { apiLogger } from "@/lib/logger";
// Tenancy (item 5, Aug 11 2026): the snapshot is SCOPE-AWARE. Reads that touch
// RLS-policied tables (Registration, Payment, EmailLog, ScheduledEmail,
// CertificateIssueRun, Abstract) go through the privileged lane ONLY for the
// platform view; an org view runs them on the normal client inside that org's
// tenant lane, with an organizationId filter so it is correct on master too.
// Un-policied infra tables (SystemLog, JobRun, Event) stay on the normal
// client throughout, keeping the privileged surface as narrow as it can be.
// See InfraScope below.
import { db, dbOperator } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { EXPECTED_JOBS } from "@/lib/worker-jobs";
import { getBuildInfo } from "@/lib/build-info";
import { getAlertSilence } from "@/lib/admin-alert";

const REGION = process.env.AWS_CLOUDWATCH_REGION || process.env.AWS_REGION || "ap-south-1";
const SES_REGION = process.env.AWS_SES_REGION || process.env.AWS_REGION || "ap-south-1";
const CACHE_MS = 60_000;

let cwClient: CloudWatchClient | null = null;
function getCw(): CloudWatchClient {
  if (!cwClient) cwClient = new CloudWatchClient({ region: REGION });
  return cwClient;
}
let sesClient: SESv2Client | null = null;
function getSes(): SESv2Client {
  if (!sesClient) sesClient = new SESv2Client({ region: SES_REGION });
  return sesClient;
}
let s3Client: S3Client | null = null;
function getS3(): S3Client {
  if (!s3Client) s3Client = new S3Client({ region: DR_REGION });
  return s3Client;
}

// Disaster-recovery bucket (Singapore). scripts/dr-pg-dump.sh writes
// db/{YYYY}/{MM}/{DD-HH}-mumbai.dump here on a cron — and until now NOTHING
// ever read it back. Backups could have silently stopped weeks ago and the
// first anyone would know is a restore that finds nothing there. Reading the
// newest object's age is the cheapest possible "is the backup alive" check.
const DR_BUCKET = process.env.DR_BUCKET || "ea-sys-dr-singapore";
const DR_REGION = process.env.DR_REGION || "ap-southeast-1";
const DR_PREFIX = "db/";
/** Dumps run 10×/day (2-hourly, 4h night gap); older than this is a red flag. */
const BACKUP_STALE_HOURS = 18;

/**
 * Complete listing of a DR-bucket prefix — follows ContinuationToken so the
 * newest object can never fall off a truncated first page. S3 returns keys in
 * lexicographic order, which for our date-shaped keys means OLDEST first — so
 * a single capped page silently hides the newest objects once the prefix
 * outgrows it. That was the July 20, 2026 "backup stale" false alarm: db/
 * crossed 200 objects (10 dumps/day under the 30-day lifecycle) and the old
 * MaxKeys:200 single call reported a 21h-old dump as "newest".
 */
const LIST_MAX_PAGES = 10; // 10k objects — far above any expected prefix size
async function listAllObjects(prefix: string): Promise<{ Key?: string; LastModified?: Date }[]> {
  const all: { Key?: string; LastModified?: Date }[] = [];
  let token: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const out = await getS3().send(
      new ListObjectsV2Command({
        Bucket: DR_BUCKET,
        Prefix: prefix,
        MaxKeys: 1000,
        ContinuationToken: token,
      }),
    );
    all.push(...(out.Contents ?? []));
    if (!out.IsTruncated || !out.NextContinuationToken) return all;
    token = out.NextContinuationToken;
  }
  // No silent caps: a prefix past LIST_MAX_PAGES pages logs loudly instead of
  // quietly reporting a wrong "newest" again.
  apiLogger.warn({ prefix, pages: LIST_MAX_PAGES }, "infra:s3-list-truncated");
  return all;
}

// ── Types ──────────────────────────────────────────────────────────
/**
 * `operator-only` (Aug 11, 2026): the panel exists but this AUDIENCE may not
 * see it. Distinct from `unconfigured` (nothing to show) and `error`
 * (something broke), because both of those would misdescribe a deliberate
 * boundary, and a panel that quietly renders empty is how a tenant concludes
 * their logs are clean when they are simply not being shown.
 */
type SourceStatus = "ok" | "error" | "unconfigured" | "operator-only";

export interface DeployRun {
  title: string;
  status: string;
  conclusion: string | null;
  event: string;
  createdAt: string;
  url: string;
}
export interface AlarmRow {
  name: string;
  metric: string;
  reason: string;
  since: string | null;
}
export interface MetricValue {
  label: string;
  value: number | null;
  unit: string;
}
export interface SesInfo {
  sendingEnabled: boolean;
  sandbox: boolean;
  max24Hour: number | null;
  sentLast24Hours: number | null;
  maxSendRate: number | null;
  bounceRate: number | null; // 0..1
  complaintRate: number | null; // 0..1
  send24h: number | null;
  bounce24h: number | null;
  complaint24h: number | null;
}

export interface JobStatus {
  job: string;
  cadence: string; // human-readable schedule (or "" for an unexpected/unknown job)
  lastStatus: string | null; // "OK" | "FAILED" | null (never run)
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  ok24h: number;
  failed24h: number;
}

export interface LogRow {
  level: string;
  module: string;
  message: string;
  at: string;
}
export interface EmailFailRow {
  to: string;
  subject: string;
  error: string | null;
  templateSlug: string | null;
  at: string;
}

export interface BuildIdentity {
  gitSha: string;
  gitShaShort: string;
  builtAt: string | null;
  slot: string | null;
  hostname: string;
}
export interface DbStatus {
  connected: boolean;
  latencyMs: number | null;
}
export interface WorkerJobLive {
  name: string;
  schedule: string;
  lastTickAt: string | null;
  stale: boolean;
}
export interface WorkerLive {
  reachable: boolean;
  uptimeSeconds: number | null;
  gitSha: string | null;
  jobs: WorkerJobLive[];
  staleJobs: string[];
}
export interface QueueDepth {
  label: string;
  value: number;
  /** Above this, the number is a problem rather than a fact. */
  warnAbove: number;
  hint: string;
}
export interface BackupStatus {
  latestKey: string | null;
  latestAt: string | null;
  ageHours: number | null;
  stale: boolean;
  bucket: string;
}
export interface AlertStatus {
  silencedUntil: string | null;
}
export interface Heartbeat {
  registrations24h: number;
  registrations7d: number;
  payments24h: number;
  checkIns24h: number;
  abstracts24h: number;
  emailsSent24h: number;
  liveEvents: number;
  nextEventName: string | null;
  nextEventStartsAt: string | null;
}
export interface ErrorTrendBucket {
  hour: string;
  errors: number;
  warns: number;
}
export interface AbuseStat {
  label: string;
  value: number;
  hint: string;
}
export interface DrArtifact {
  label: string;
  prefix: string;
  latestAt: string | null;
  ageHours: number | null;
  staleAfterHours: number;
  stale: boolean;
}

export interface InfraSnapshot {
  generatedAt: string;
  region: string;
  build: BuildIdentity;
  database: { status: SourceStatus; error?: string; info: DbStatus | null };
  worker: { status: SourceStatus; error?: string; info: WorkerLive | null };
  queues: { status: SourceStatus; error?: string; rows: QueueDepth[] };
  heartbeat: { status: SourceStatus; error?: string; info: Heartbeat | null };
  errorTrend: { status: SourceStatus; error?: string; buckets: ErrorTrendBucket[] };
  abuse: { status: SourceStatus; error?: string; rows: AbuseStat[] };
  dr: { status: SourceStatus; error?: string; rows: DrArtifact[] };
  backup: { status: SourceStatus; error?: string; info: BackupStatus | null };
  alerts: { status: SourceStatus; error?: string; info: AlertStatus | null };
  deploys: { status: SourceStatus; error?: string; runs: DeployRun[] };
  ses: { status: SourceStatus; error?: string; info: SesInfo | null };
  alarms: { status: SourceStatus; error?: string; inAlarm: AlarmRow[] };
  metrics: { status: SourceStatus; error?: string; instanceId: string | null; values: MetricValue[] };
  jobs: { status: SourceStatus; error?: string; workerLastSeen: string | null; rows: JobStatus[] };
  recentErrors: { status: SourceStatus; error?: string; rows: LogRow[] };
  emailFailures: { status: SourceStatus; error?: string; rows: EmailFailRow[] };
}

/**
 * Who is this snapshot for (multi-tenancy item 5, owner decision Aug 11 2026)?
 *
 * The infra cards (CPU, disk, alarms, SES, deploys) are the same for everyone.
 * The BUSINESS counters are not: the platform operator wants the totals across
 * every tenant, while a tenant's own ADMIN must see only their org. Rather
 * than narrow the page to operators, the snapshot takes the audience as a
 * parameter.
 *
 * The scope decides two things together, and they must agree:
 *   - which client (privileged lane for platform, normal client for an org),
 *   - and the org filter on each counted query.
 * On master there is no RLS, so the FILTER is what actually scopes an org
 * view; on the platform the lane enforces it as well. Belt and braces, and it
 * means the org view is already correct today rather than only after RLS.
 */
export type InfraScope = { kind: "platform" } | { kind: "org"; orgId: string };

/**
 * Cache key. Keyed on the scope because the whole point of the scope is that
 * two audiences get DIFFERENT numbers; a single shared cache entry would serve
 * one audience's totals to the other, which is the exact leak the scope exists
 * to prevent. Bounded by the number of orgs on the instance, and entries are
 * tiny.
 */
function cacheKey(scope: InfraScope): string {
  return scope.kind === "platform" ? "platform" : `org:${scope.orgId}`;
}

const cache = new Map<string, { at: number; snap: InfraSnapshot }>();

/** Privileged lane for the platform view; the normal client for an org view. */
function scopedClient(scope: InfraScope) {
  return scope.kind === "platform" ? dbOperator : db;
}
/**
 * Org filter for a model whose `organizationId` is NOT NULL (ScheduledEmail,
 * Event). Plain equality is exact here: there is no null pool to miss.
 */
function scopeWhere(scope: InfraScope) {
  return scope.kind === "org" ? { organizationId: scope.orgId } : {};
}

/**
 * Org filter for a model whose `organizationId` is NULLABLE: Registration,
 * Payment, Abstract, EmailLog, CertificateIssueRun. Matches the tenant's rows
 * OR rows with no org at all, and the OR is load-bearing (added Aug 11, 2026
 * after review).
 *
 * An equality filter drops NULL, and auth emails (password reset, team
 * invitation, reviewer invitation) are written from unwrapped auth routes and
 * are exactly that null population. Filtering them out gave the "recent email
 * failures" card a silent blind spot on the one class of mail whose failure
 * nobody would otherwise notice: an ADMIN sees an empty card and concludes
 * mail is healthy.
 *
 * Including NULL is safe on the platform because the LANE already excludes it:
 * every policy matches `organizationId = current_setting('app.current_org')`,
 * which NULL never satisfies, and the asymmetric policies say so explicitly.
 * The filter restores the correct master view; the lane keeps the tenant
 * boundary. Each layer does its own job.
 *
 * ⚠ Spreads an `OR`, so never add it to a `where` that already has one: the
 * later key wins and would silently drop the org scope.
 */
function scopeWhereWithNullPool(scope: InfraScope) {
  return scope.kind === "org"
    ? { OR: [{ organizationId: scope.orgId }, { organizationId: null }] }
    : {};
}

/** Run an org-scoped read inside its tenant lane; platform reads need none. */
function inScope<T>(scope: InfraScope, fn: () => Promise<T>): Promise<T> {
  return scope.kind === "org" ? runWithTenant(scope.orgId, fn) : fn();
}

// ── Helpers ────────────────────────────────────────────────────────

/** Discover the instance id via IMDSv2, falling back to EC2_INSTANCE_ID. */
async function getInstanceId(): Promise<string | null> {
  if (process.env.EC2_INSTANCE_ID) return process.env.EC2_INSTANCE_ID;
  try {
    const tokenRes = await fetch("http://169.254.169.254/latest/api/token", {
      method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
      signal: AbortSignal.timeout(800),
    });
    if (!tokenRes.ok) return null;
    const token = await tokenRes.text();
    const idRes = await fetch("http://169.254.169.254/latest/meta-data/instance-id", {
      headers: { "X-aws-ec2-metadata-token": token },
      signal: AbortSignal.timeout(800),
    });
    if (!idRes.ok) return null;
    return (await idRes.text()).trim() || null;
  } catch {
    return null; // not on EC2 (local dev) — metrics card shows "unconfigured"
  }
}

function friendlyAwsError(err: unknown): string {
  const name = (err as { name?: string })?.name || "";
  const msg = (err as { message?: string })?.message || String(err);
  if (name === "AccessDeniedException" || /not authorized|AccessDenied/i.test(msg)) {
    return "Missing IAM permission — add the read-only policy to the instance role (see docs/INFRA_OPS.md).";
  }
  return msg;
}

/** Latest non-null value of a GetMetricData result id. */
function latest(values: (number | undefined)[] | undefined): number | null {
  if (!values) return null;
  for (const v of values) if (v != null && !Number.isNaN(v)) return v;
  return null;
}

// ── Sources ────────────────────────────────────────────────────────

async function fetchDeploys(): Promise<InfraSnapshot["deploys"]> {
  const token = process.env.GITHUB_OPS_TOKEN;
  const repo = process.env.GITHUB_OPS_REPO || "meetingmindsexperts/ea-sys";
  if (!token) return { status: "unconfigured", runs: [] };
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=10`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { status: "error", error: `GitHub API ${res.status}`, runs: [] };
    const data = (await res.json()) as {
      workflow_runs?: Array<{
        display_title: string;
        status: string;
        conclusion: string | null;
        event: string;
        created_at: string;
        html_url: string;
      }>;
    };
    const runs: DeployRun[] = (data.workflow_runs || []).slice(0, 10).map((r) => ({
      title: r.display_title,
      status: r.status,
      conclusion: r.conclusion,
      event: r.event,
      createdAt: r.created_at,
      url: r.html_url,
    }));
    return { status: "ok", runs };
  } catch (err) {
    apiLogger.warn({ err }, "infra:deploys-failed");
    return { status: "error", error: (err as Error).message, runs: [] };
  }
}

async function fetchAlarms(): Promise<InfraSnapshot["alarms"]> {
  try {
    const out = await getCw().send(
      new DescribeAlarmsCommand({ StateValue: "ALARM", MaxRecords: 50 }),
    );
    const inAlarm: AlarmRow[] = (out.MetricAlarms || []).map((a) => ({
      name: a.AlarmName || "(unnamed)",
      metric: [a.Namespace, a.MetricName].filter(Boolean).join(" · ") || "—",
      reason: a.StateReason || "",
      since: a.StateUpdatedTimestamp ? a.StateUpdatedTimestamp.toISOString() : null,
    }));
    return { status: "ok", inAlarm };
  } catch (err) {
    apiLogger.warn({ err }, "infra:alarms-failed");
    return { status: "error", error: friendlyAwsError(err), inAlarm: [] };
  }
}

async function fetchSes(): Promise<InfraSnapshot["ses"]> {
  try {
    const [account, metrics] = await Promise.all([
      getSes().send(new GetAccountCommand({})),
      // 24h SES counts + latest reputation rates.
      getCw()
        .send(
          new GetMetricDataCommand({
            StartTime: new Date(Date.now() - 24 * 3600_000),
            EndTime: new Date(),
            ScanBy: "TimestampDescending",
            MetricDataQueries: [
              sesMetric("send", "Send", 86_400, "Sum"),
              sesMetric("bounce", "Bounce", 86_400, "Sum"),
              sesMetric("complaint", "Complaint", 86_400, "Sum"),
              sesMetric("brate", "Reputation.BounceRate", 300, "Average"),
              sesMetric("crate", "Reputation.ComplaintRate", 300, "Average"),
            ],
          }),
        )
        .catch(() => null), // reputation/count metrics are best-effort
    ]);
    const byId = new Map((metrics?.MetricDataResults || []).map((r) => [r.Id, r.Values]));
    const info: SesInfo = {
      sendingEnabled: account.SendingEnabled ?? false,
      sandbox: account.ProductionAccessEnabled === false,
      max24Hour: account.SendQuota?.Max24HourSend ?? null,
      sentLast24Hours: account.SendQuota?.SentLast24Hours ?? null,
      maxSendRate: account.SendQuota?.MaxSendRate ?? null,
      bounceRate: latest(byId.get("brate")),
      complaintRate: latest(byId.get("crate")),
      send24h: latest(byId.get("send")),
      bounce24h: latest(byId.get("bounce")),
      complaint24h: latest(byId.get("complaint")),
    };
    return { status: "ok", info };
  } catch (err) {
    apiLogger.warn({ err }, "infra:ses-failed");
    return { status: "error", error: friendlyAwsError(err), info: null };
  }
}

function sesMetric(id: string, name: string, period: number, stat: string): MetricDataQuery {
  return {
    Id: id,
    MetricStat: { Metric: { Namespace: "AWS/SES", MetricName: name }, Period: period, Stat: stat },
    ReturnData: true,
  };
}

async function fetchMetrics(instanceId: string | null): Promise<InfraSnapshot["metrics"]> {
  if (!instanceId) {
    return { status: "unconfigured", instanceId: null, values: [] };
  }
  try {
    const dim = [{ Name: "InstanceId", Value: instanceId }];
    const out = await getCw().send(
      new GetMetricDataCommand({
        StartTime: new Date(Date.now() - 3 * 3600_000),
        EndTime: new Date(),
        ScanBy: "TimestampDescending",
        MetricDataQueries: [
          // All standard EC2 metrics (no detailed-monitoring needed) + CWAgent
          // mem/disk if published. Adding these to the ONE GetMetricData call is
          // ~free (billed per metric, $0.01/1000).
          { Id: "cpu", MetricStat: { Metric: { Namespace: "AWS/EC2", MetricName: "CPUUtilization", Dimensions: dim }, Period: 300, Stat: "Average" }, ReturnData: true },
          { Id: "credit", MetricStat: { Metric: { Namespace: "AWS/EC2", MetricName: "CPUCreditBalance", Dimensions: dim }, Period: 300, Stat: "Average" }, ReturnData: true },
          { Id: "netin", MetricStat: { Metric: { Namespace: "AWS/EC2", MetricName: "NetworkIn", Dimensions: dim }, Period: 300, Stat: "Sum" }, ReturnData: true },
          { Id: "netout", MetricStat: { Metric: { Namespace: "AWS/EC2", MetricName: "NetworkOut", Dimensions: dim }, Period: 300, Stat: "Sum" }, ReturnData: true },
          { Id: "status", MetricStat: { Metric: { Namespace: "AWS/EC2", MetricName: "StatusCheckFailed", Dimensions: dim }, Period: 300, Stat: "Maximum" }, ReturnData: true },
          // CWAgent mem/disk if published. The SEARCH schema must name the
          // dimension keys — '{CWAgent}' alone matches only dimensionless
          // metrics, and ours carry InstanceId (that mismatch rendered "—%").
          // '{CWAgent,InstanceId}' matches exactly the InstanceId-aggregated
          // series (aggregation_dimensions [["InstanceId"]] in the agent config).
          { Id: "mem", Expression: `SEARCH('{CWAgent,InstanceId} MetricName="mem_used_percent" InstanceId="${instanceId}"', 'Average', 300)`, ReturnData: true },
          { Id: "disk", Expression: `SEARCH('{CWAgent,InstanceId} MetricName="disk_used_percent" InstanceId="${instanceId}"', 'Average', 300)`, ReturnData: true },
        ],
      }),
    );
    const byId = new Map((out.MetricDataResults || []).map((r) => [r.Id, r.Values]));
    const mb = (v: number | null): number | null => (v == null ? null : v / 1_000_000);
    const values: MetricValue[] = [
      { label: "CPU", value: latest(byId.get("cpu")), unit: "%" },
      { label: "CPU credits", value: latest(byId.get("credit")), unit: "" },
      { label: "Memory", value: latest(byId.get("mem")), unit: "%" },
      { label: "Disk", value: latest(byId.get("disk")), unit: "%" },
      { label: "Net in", value: mb(latest(byId.get("netin"))), unit: " MB/5m" },
      { label: "Net out", value: mb(latest(byId.get("netout"))), unit: " MB/5m" },
      { label: "Status check", value: latest(byId.get("status")), unit: "" },
    ];
    return { status: "ok", instanceId, values };
  } catch (err) {
    apiLogger.warn({ err }, "infra:metrics-failed");
    return { status: "error", error: friendlyAwsError(err), instanceId, values: [] };
  }
}

async function fetchJobs(): Promise<InfraSnapshot["jobs"]> {
  try {
    // Latest tick per job (DISTINCT ON) + 24h OK/FAILED counts. This is our
    // own Postgres — no AWS cost. Successful ticks live here (not in the
    // debug-skipped SystemLog), so this is the reliable "last good run".
    const latest = await db.$queryRaw<
      Array<{ job: string; startedAt: Date; status: string; durationMs: number; error: string | null }>
    >`SELECT DISTINCT ON (job) job, "startedAt", status::text AS status, "durationMs", error
      FROM "JobRun" ORDER BY job, "startedAt" DESC`;

    const since = new Date(Date.now() - 24 * 3600_000);
    const counts = await db.jobRun.groupBy({
      by: ["job", "status"],
      where: { startedAt: { gte: since } },
      _count: { _all: true },
    });
    const ok = new Map<string, number>();
    const failed = new Map<string, number>();
    for (const c of counts) {
      (c.status === "OK" ? ok : failed).set(c.job, c._count._all);
    }
    const latestByJob = new Map(latest.map((r) => [r.job, r]));

    // Show the FULL expected roster (every configured job), merged with the
    // recorded runs — so a job that's never ticked shows up as "never" rather
    // than being invisible. Any recorded job NOT in the roster is appended
    // (defensive: a job added to the worker but not yet listed).
    const cadence = new Map(EXPECTED_JOBS.map((j) => [j.name, j.cadence]));
    const names = new Set<string>([...cadence.keys(), ...latestByJob.keys()]);
    const rows: JobStatus[] = [...names]
      .map((job) => {
        const r = latestByJob.get(job);
        return {
          job,
          cadence: cadence.get(job) ?? "",
          lastStatus: r ? r.status : null,
          lastRunAt: r ? r.startedAt.toISOString() : null,
          lastDurationMs: r ? r.durationMs : null,
          lastError: r ? r.error : null,
          ok24h: ok.get(job) ?? 0,
          failed24h: failed.get(job) ?? 0,
        };
      })
      .sort((a, b) => a.job.localeCompare(b.job));

    const workerLastSeen = rows.reduce<string | null>(
      (max, r) => (r.lastRunAt && (max == null || r.lastRunAt > max) ? r.lastRunAt : max),
      null,
    );
    return { status: "ok", workerLastSeen, rows };
  } catch (err) {
    apiLogger.warn({ err }, "infra:jobs-failed");
    return { status: "error", error: (err as Error).message, workerLastSeen: null, rows: [] };
  }
}

async function fetchRecentErrors(scope: InfraScope): Promise<InfraSnapshot["recentErrors"]> {
  // SystemLog is NOT policied and has NO organizationId column, so neither the
  // lane nor a filter can scope it, and `SystemLog.message` stores the ENTIRE
  // raw pino line, meaning userId, email, subject, registrationId and error
  // text. On the platform that makes this panel cross-tenant by construction,
  // so a tenant audience gets the boundary stated rather than a silently empty
  // card. Giving SystemLog an org column would let this be scoped properly.
  if (scope.kind === "org") return { status: "operator-only", rows: [] };
  try {
    // Latest error/warn lines across app + worker — our own SystemLog (the
    // same source the /logs page reads). Zero AWS cost.
    const rows = await db.systemLog.findMany({
      where: { level: { in: ["error", "warn"] } },
      orderBy: { timestamp: "desc" },
      take: 15,
      select: { level: true, module: true, message: true, timestamp: true },
    });
    return {
      status: "ok",
      rows: rows.map((r) => ({
        level: r.level,
        module: r.module,
        message: r.message.slice(0, 400),
        at: r.timestamp.toISOString(),
      })),
    };
  } catch (err) {
    apiLogger.warn({ err }, "infra:recent-errors-failed");
    return { status: "error", error: (err as Error).message, rows: [] };
  }
}

// The failures card is an at-3am operational signal, not an archive — only
// failures inside this window surface. Older FAILED rows stay in EmailLog
// (they're audit history on the per-person Email History timelines) but age
// off this dashboard. Added July 22, 2026 after months-old test-era failures
// sat on the card forever.
const EMAIL_FAILURE_WINDOW_DAYS = 7;

async function fetchEmailFailures(scope: InfraScope): Promise<InfraSnapshot["emailFailures"]> {
  try {
    // Recent failed sends — complements the SES aggregate rates with the
    // actual "which email didn't go and why". Our own EmailLog.
    const rows = await inScope(scope, () =>
      scopedClient(scope).emailLog.findMany({
      where: {
        ...scopeWhereWithNullPool(scope),
        status: "FAILED",
        createdAt: { gte: new Date(Date.now() - EMAIL_FAILURE_WINDOW_DAYS * 24 * 60 * 60 * 1000) },
      },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: { to: true, subject: true, errorMessage: true, templateSlug: true, createdAt: true },
      }),
    );
    return {
      status: "ok",
      rows: rows.map((r) => ({
        to: r.to,
        subject: r.subject,
        error: r.errorMessage,
        templateSlug: r.templateSlug,
        at: r.createdAt.toISOString(),
      })),
    };
  } catch (err) {
    apiLogger.warn({ err }, "infra:email-failures-failed");
    return { status: "error", error: (err as Error).message, rows: [] };
  }
}


// ── The four things an operator wants at 3am and could not get ─────────────
// Deploys / SES / alarms / metrics were already here. What was missing was the
// stuff that tells you whether the SYSTEM is actually working: is the database
// up, is the worker alive (as opposed to "did a JobRun row appear at some
// point"), is anything backing up behind a queue, and does a backup exist.

async function fetchDatabase(): Promise<InfraSnapshot["database"]> {
  const start = Date.now();
  try {
    await db.$queryRaw`SELECT 1`;
    return { status: "ok", info: { connected: true, latencyMs: Date.now() - start } };
  } catch (err) {
    apiLogger.error({ err }, "infra:db-ping-failed");
    return {
      status: "error",
      error: (err as Error).message,
      info: { connected: false, latencyMs: null },
    };
  }
}

/**
 * LIVE worker liveness — asks the worker container itself.
 *
 * The existing Jobs card infers the worker's health from JobRun rows, which
 * cannot distinguish "the worker is dead" from "that job isn't due yet". A
 * worker that crashed before the first tick of a slow job looks identical to a
 * healthy one. /worker/health knows the difference: it reports real uptime, and
 * (since the roster fix) EVERY registered job, including the ones that have
 * never ticked.
 */
const WORKER_PROBE_RETRY_DELAY_MS = 2500;

async function probeWorkerOnce(
  url: string,
): Promise<{ ok: true; info: WorkerLive } | { ok: false; error: string; err?: unknown }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500), cache: "no-store" });
    if (!res.ok) return { ok: false, error: `Worker health returned ${res.status}` };
    const body = (await res.json()) as {
      uptimeSeconds?: number;
      gitSha?: string;
      jobs?: WorkerJobLive[];
      staleJobs?: string[];
    };
    return {
      ok: true,
      info: {
        reachable: true,
        uptimeSeconds: body.uptimeSeconds ?? null,
        gitSha: body.gitSha ?? null,
        jobs: body.jobs ?? [],
        staleJobs: body.staleJobs ?? [],
      },
    };
  } catch (err) {
    return { ok: false, error: "Worker unreachable", err };
  }
}

/**
 * Is the background worker alive?
 *
 * Probed TWICE with a short gap, because the single most common cause of a
 * refused connection here is not a dead worker but a deploy: `scripts/deploy.sh`
 * restarts `ea-sys-worker`, and for a couple of seconds port 3099 refuses
 * connections. A one-shot probe landing in that window reported a healthy system
 * as down — noise on the dashboard, and worse, a false CRITICAL in the daily
 * digest, which treats an unreachable worker as the most serious finding there
 * is (nothing background runs without it).
 *
 * A genuinely dead worker fails both probes and is still reported within a few
 * seconds; the retry costs nothing on the happy path (it only runs after a
 * failure) and buys the digest immunity from deploy timing.
 */
async function fetchWorker(): Promise<InfraSnapshot["worker"]> {
  const url = process.env.WORKER_HEALTH_URL || "http://ea-sys-worker:3099/health";

  const first = await probeWorkerOnce(url);
  if (first.ok) return { status: "ok", info: first.info };

  await new Promise((r) => setTimeout(r, WORKER_PROBE_RETRY_DELAY_MS));
  const second = await probeWorkerOnce(url);
  if (second.ok) {
    // Recovered on the retry — almost certainly a restart window. Worth an info
    // line (so a worker that flaps repeatedly is still visible in /logs) but NOT
    // a warn, which would page-adjacent-noise on every single deploy.
    apiLogger.info({ url, firstError: first.error }, "infra:worker-probe-recovered-on-retry");
    return { status: "ok", info: second.info };
  }

  // Failed twice — a real finding, not a config gap. The worker drains every
  // queue in the system.
  apiLogger.warn({ err: second.err, url, attempts: 2 }, "infra:worker-unreachable");
  return {
    status: "error",
    error:
      "Worker unreachable (two attempts) — no background job is running (emails, certificates, webinar sync).",
    info: { reachable: false, uptimeSeconds: null, gitSha: null, jobs: [], staleJobs: [] },
  };
}

/**
 * Queue depths — "is work piling up?".
 *
 * You could always see that a job RAN. You could never see that it was falling
 * behind. A scheduled-emails job that ticks happily every minute while 400
 * emails sit due-and-unsent is green on every existing card.
 *
 * Tenancy (Domain #18): these counts (and fetchEmailFailures/emailsSent24h
 * above) are deliberately ORG-BLIND — this is the SUPER_ADMIN ops view over
 * the whole system. ScheduledEmail + EmailLog are now RLS-swept, so under
 * platform RLS as the app role these reads all go to ZERO — which is the
 * WORST failure mode for this card: a fully stalled queue would report
 * "due 0 / stuck 0 / failed 0", i.e. green. The platform MUST run this
 * surface (like the workers' candidate scans and the email-log-prune job) on
 * a privileged maintenance lane. Documented cross-sweep precondition,
 * MULTI_TENANCY.md §13. No-op concern on master (RLS never enabled there).
 */
async function fetchQueues(scope: InfraScope): Promise<InfraSnapshot["queues"]> {
  try {
    const now = new Date();
    const dayAgo = new Date(Date.now() - 24 * 3600_000);
    const c = scopedClient(scope);
    // ScheduledEmail.organizationId is NOT NULL; CertificateIssueRun's IS
    // nullable, so the two counters take different filters deliberately.
    const org = scopeWhere(scope);
    const orgOrNull = scopeWhereWithNullPool(scope);
    const [emailsDue, emailsStuck, emailsFailed24h, certRunsActive, certRunsFailed24h] =
      await inScope(scope, () =>
        Promise.all([
          c.scheduledEmail.count({ where: { ...org, status: "PENDING", scheduledFor: { lte: now } } }),
          c.scheduledEmail.count({ where: { ...org, status: "PROCESSING" } }),
          c.scheduledEmail.count({ where: { ...org, status: "FAILED", updatedAt: { gte: dayAgo } } }),
          c.certificateIssueRun.count({
            where: { ...orgOrNull, status: { in: ["PENDING", "RENDERING", "SENDING"] } },
          }),
          c.certificateIssueRun.count({ where: { ...orgOrNull, status: "FAILED", triggeredAt: { gte: dayAgo } } }),
        ]),
      );

    const rows: QueueDepth[] = [
      {
        label: "Emails due, unsent",
        value: emailsDue,
        warnAbove: 0,
        hint: "PENDING and past their send time. The worker drains these every minute — anything here means it is not keeping up, or not running.",
      },
      {
        label: "Emails mid-send",
        value: emailsStuck,
        warnAbove: 3,
        hint: "PROCESSING. A couple is normal. A pile means sends are wedging.",
      },
      {
        label: "Email sends failed (24h)",
        value: emailsFailed24h,
        warnAbove: 0,
        hint: "Bulk-email jobs that gave up in the last day.",
      },
      {
        label: "Certificate runs in flight",
        value: certRunsActive,
        warnAbove: 5,
        hint: "Rendering or sending. These are slow by nature; a standing pile is not.",
      },
      {
        label: "Certificate runs failed (24h)",
        value: certRunsFailed24h,
        warnAbove: 0,
        hint: "Attendees who were promised a certificate and did not get one.",
      },
    ];
    return { status: "ok", rows };
  } catch (err) {
    apiLogger.warn({ err }, "infra:queues-failed");
    return { status: "error", error: (err as Error).message, rows: [] };
  }
}

/**
 * Last DR backup — the classic "the backup that wasn't".
 *
 * dr-pg-dump.sh emails on failure, but that only fires if the script RUNS and
 * fails. If the crontab is lost (box rebuild, user change, the DR failover the
 * whole thing exists for), backups stop silently and you discover it at restore
 * time, which is the worst possible moment. Reading the newest object's age
 * turns "no news" into an actual signal.
 *
 * Exported for tests only — production callers go through getInfraSnapshot().
 */
export async function fetchBackup(): Promise<InfraSnapshot["backup"]> {
  try {
    // The keys are db/{YYYY}/{MM}/{DD-HH}-mumbai.dump — date-shaped, so the
    // FULL paginated listing matters (see listAllObjects).
    const objects = (await listAllObjects(DR_PREFIX)).filter((o) => o.Key && o.LastModified);
    if (objects.length === 0) {
      return {
        status: "error",
        error: `No database backups found in s3://${DR_BUCKET}/${DR_PREFIX}`,
        info: { latestKey: null, latestAt: null, ageHours: null, stale: true, bucket: DR_BUCKET },
      };
    }
    const newest = objects.reduce((a, b) =>
      (a.LastModified as Date) > (b.LastModified as Date) ? a : b,
    );
    const at = newest.LastModified as Date;
    const ageHours = (Date.now() - at.getTime()) / 3600_000;
    return {
      status: "ok",
      info: {
        latestKey: newest.Key ?? null,
        latestAt: at.toISOString(),
        ageHours,
        stale: ageHours > BACKUP_STALE_HOURS,
        bucket: DR_BUCKET,
      },
    };
  } catch (err) {
    apiLogger.warn({ err }, "infra:backup-check-failed");
    return { status: "error", error: friendlyAwsError(err), info: null };
  }
}

async function fetchAlerts(): Promise<InfraSnapshot["alerts"]> {
  try {
    const silencedUntil = await getAlertSilence();
    return { status: "ok", info: { silencedUntil: silencedUntil?.toISOString() ?? null } };
  } catch (err) {
    apiLogger.warn({ err }, "infra:alert-silence-failed");
    return { status: "error", error: (err as Error).message, info: null };
  }
}


/**
 * Product heartbeat — "is the system doing its JOB?"
 *
 * Everything else on this page measures the machine. None of it would notice the
 * failure mode that actually matters: the box is green, the worker is ticking,
 * CPU is 4% — and nobody has been able to register for eleven hours because a
 * Stripe key expired. Zero registrations during a live event is an outage that
 * no infra metric can see.
 */
async function fetchHeartbeat(scope: InfraScope): Promise<InfraSnapshot["heartbeat"]> {
  try {
    const now = new Date();
    const dayAgo = new Date(Date.now() - 24 * 3600_000);
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000);
    const weekAhead = new Date(Date.now() + 7 * 24 * 3600_000);

    const c = scopedClient(scope);
    // Everything counted here except Event has a NULLABLE organizationId.
    const orgOrNull = scopeWhereWithNullPool(scope);
    const org = scopeWhere(scope);
    const [registrations24h, registrations7d, payments24h, checkIns24h, abstracts24h, emailsSent24h, liveEvents, nextEvent] =
      await inScope(scope, () =>
        Promise.all([
          c.registration.count({ where: { ...orgOrNull, createdAt: { gte: dayAgo } } }),
          c.registration.count({ where: { ...orgOrNull, createdAt: { gte: weekAgo } } }),
          c.payment.count({ where: { ...orgOrNull, createdAt: { gte: dayAgo }, status: "PAID" } }),
          c.registration.count({ where: { ...orgOrNull, checkedInAt: { gte: dayAgo } } }),
          c.abstract.count({ where: { ...orgOrNull, createdAt: { gte: dayAgo } } }),
          c.emailLog.count({ where: { ...orgOrNull, createdAt: { gte: dayAgo }, status: "SENT" } }),
          // An event running RIGHT NOW is the difference between "fix it tomorrow"
          // and "fix it in the next ten minutes". Event carries no RLS policy, so
          // the org filter alone scopes it in both views.
          db.event.count({
            where: { ...org, startDate: { lte: now }, endDate: { gte: now }, status: "PUBLISHED" },
          }),
          db.event.findFirst({
            where: { ...org, startDate: { gte: now, lte: weekAhead }, status: "PUBLISHED" },
            orderBy: { startDate: "asc" },
            select: { name: true, startDate: true },
          }),
        ]),
      );

    return {
      status: "ok",
      info: {
        registrations24h,
        registrations7d,
        payments24h,
        checkIns24h,
        abstracts24h,
        emailsSent24h,
        liveEvents,
        nextEventName: nextEvent?.name ?? null,
        nextEventStartsAt: nextEvent?.startDate.toISOString() ?? null,
      },
    };
  } catch (err) {
    apiLogger.warn({ err }, "infra:heartbeat-failed");
    return { status: "error", error: (err as Error).message, info: null };
  }
}

/**
 * Error rate over the last 24h, bucketed hourly.
 *
 * A list of the 15 most recent errors tells you what is broken. It does not tell
 * you whether this is normal. A shape does: a flat line with a cliff at 14:00 is
 * a deploy; a rising ramp is a leak; a spike at 02:00 is a cron.
 */
async function fetchErrorTrend(scope: InfraScope): Promise<InfraSnapshot["errorTrend"]> {
  // Same reason as fetchRecentErrors: SystemLog cannot be scoped.
  if (scope.kind === "org") return { status: "operator-only", buckets: [] };
  try {
    const rows = await db.$queryRaw<Array<{ hour: Date; level: string; count: bigint }>>`
      SELECT date_trunc('hour', "timestamp") AS hour, level, COUNT(*) AS count
        FROM "SystemLog"
       WHERE "timestamp" >= now() - interval '24 hours'
         AND level IN ('error', 'warn')
       GROUP BY 1, 2
       ORDER BY 1
    `;
    const byHour = new Map<string, ErrorTrendBucket>();
    // Seed all 24 hours so a gap reads as "zero", not as "missing".
    for (let i = 23; i >= 0; i--) {
      const d = new Date(Date.now() - i * 3600_000);
      d.setMinutes(0, 0, 0);
      byHour.set(d.toISOString(), { hour: d.toISOString(), errors: 0, warns: 0 });
    }
    for (const r of rows) {
      const key = new Date(r.hour).toISOString();
      const b = byHour.get(key);
      if (!b) continue;
      if (r.level === "error") b.errors = Number(r.count);
      else b.warns = Number(r.count);
    }
    return { status: "ok", buckets: [...byHour.values()] };
  } catch (err) {
    apiLogger.warn({ err }, "infra:error-trend-failed");
    return { status: "error", error: (err as Error).message, buckets: [] };
  }
}

/**
 * Abuse / auth signals. Cheap, and the only place a brute-force attempt or a
 * client hammering the API would ever surface on this page.
 */
async function fetchAbuse(scope: InfraScope): Promise<InfraSnapshot["abuse"]> {
  // Same reason as fetchRecentErrors: SystemLog cannot be scoped.
  if (scope.kind === "org") return { status: "operator-only", rows: [] };
  try {
    const dayAgo = new Date(Date.now() - 24 * 3600_000);
    // Substrings match the codebase's REAL log-message taxonomy (Aug 4, 2026
    // — the originals counted "invalid-credentials"/"forbidden", strings our
    // messages never contain, so two of three counters were structurally 0):
    //  - every rate-limit rejection logs `<route>:rate-limited` (the
    //    rateLimited() helper + the hand-rolled sites);
    //  - failed logins log `auth:login-bad-password` / `auth:login-unknown-email`
    //    / `auth:login-throttled` (src/lib/auth.ts authorize());
    //  - 403s log with `-denied` / `-refused` suffixes (auth-guard:write-denied,
    //    *:event-access-denied, *:role-refused, …).
    const [rateLimited, authFailures, forbidden] = await Promise.all([
      db.systemLog.count({ where: { timestamp: { gte: dayAgo }, message: { contains: "rate-limited", mode: "insensitive" } } }),
      db.systemLog.count({
        where: {
          timestamp: { gte: dayAgo },
          OR: [
            { message: { contains: "auth:login-bad-password" } },
            { message: { contains: "auth:login-unknown-email" } },
            { message: { contains: "auth:login-throttled" } },
          ],
        },
      }),
      db.systemLog.count({
        where: {
          timestamp: { gte: dayAgo },
          OR: [
            { message: { contains: "-denied", mode: "insensitive" } },
            { message: { contains: "-refused", mode: "insensitive" } },
            { message: { contains: "forbidden", mode: "insensitive" } },
          ],
        },
      }),
    ]);
    return {
      status: "ok",
      rows: [
        { label: "Rate-limited requests", value: rateLimited, hint: "Someone (or something) is hitting a limit. A few is normal; hundreds is a client in a retry loop or an attack." },
        { label: "Failed logins", value: authFailures, hint: "A spike is a brute-force attempt." },
        { label: "Forbidden (403)", value: forbidden, hint: "Someone is reaching for things they are not allowed to have." },
      ],
    };
  } catch (err) {
    apiLogger.warn({ err }, "infra:abuse-failed");
    return { status: "error", error: (err as Error).message, rows: [] };
  }
}

/**
 * The FULL disaster-recovery picture, not just the database.
 *
 * Three independent streams land in the Singapore bucket — the Postgres dump,
 * the uploads mirror, and the .env. A restore needs all three. Checking only the
 * database dump would let you believe you were covered while the uploads mirror
 * had been dead for a month, and you would discover it while restoring.
 *
 * Freshness is the newest object's LastModified under the prefix — correct for
 * db/ and env/ whose crons write a NEW object every run. The uploads mirror is
 * an hourly `aws s3 sync`, which only writes when a local file actually
 * CHANGED — so its newest object measures "time since someone last uploaded",
 * not "time since the sync last ran", and a quiet stretch > staleAfterHours
 * false-alarmed while the cron was healthy (2026-07-17). The cron therefore
 * also writes a heartbeat object after every successful sync, and the uploads
 * row uses whichever is newer: heartbeat (post-crontab-change) or newest
 * uploads/ object (pre-change fallback = exactly the old behavior). Triage
 * runbook: infra/dr/README.md §"Triage: Uploads mirror stale".
 *
 * Exported for tests only — production callers go through getInfraSnapshot().
 */
export async function fetchDr(): Promise<InfraSnapshot["dr"]> {
  const streams: { label: string; prefix: string; staleAfterHours: number; heartbeatKey?: string }[] = [
    { label: "Database dump", prefix: "db/", staleAfterHours: 18 },
    { label: "Uploads mirror", prefix: "uploads/", staleAfterHours: 3, heartbeatKey: "heartbeats/uploads-mirror" },
    { label: "Env file", prefix: "env/", staleAfterHours: 30 },
  ];
  try {
    const rows = await Promise.all(
      streams.map(async (st) => {
        const [contents, heartbeatAt] = await Promise.all([
          listAllObjects(st.prefix),
          st.heartbeatKey ? fetchDrHeartbeat(st.heartbeatKey) : Promise.resolve(null),
        ]);
        const objects = contents.filter((o) => o.LastModified);
        const newestObjectAt = objects.length
          ? (objects.reduce((a, b) => ((a.LastModified as Date) > (b.LastModified as Date) ? a : b)).LastModified as Date)
          : null;
        const at = [newestObjectAt, heartbeatAt]
          .filter((d): d is Date => d !== null)
          .reduce<Date | null>((a, b) => (a === null || b > a ? b : a), null);
        if (!at) {
          return { label: st.label, prefix: st.prefix, latestAt: null, ageHours: null, staleAfterHours: st.staleAfterHours, stale: true };
        }
        const ageHours = (Date.now() - at.getTime()) / 3600_000;
        return {
          label: st.label,
          prefix: st.prefix,
          latestAt: at.toISOString(),
          ageHours,
          staleAfterHours: st.staleAfterHours,
          stale: ageHours > st.staleAfterHours,
        };
      }),
    );
    return { status: "ok", rows };
  } catch (err) {
    apiLogger.warn({ err }, "infra:dr-failed");
    return { status: "error", error: friendlyAwsError(err), rows: [] };
  }
}

/**
 * LastModified of a DR heartbeat object, or null when it doesn't exist yet —
 * a missing heartbeat is the expected state until the crontab change that
 * writes it lands, so 404 is not an error (the caller falls back to the
 * newest-object age). Anything else (IAM, KMS, network) logs and degrades to
 * null rather than failing the whole DR card.
 *
 * Exported for tests only.
 */
export async function fetchDrHeartbeat(key: string): Promise<Date | null> {
  try {
    const head = await getS3().send(new HeadObjectCommand({ Bucket: DR_BUCKET, Key: key }));
    return head.LastModified ?? null;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "NotFound" || name === "NoSuchKey" || (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
      return null;
    }
    apiLogger.warn({ err, key }, "infra:dr-heartbeat-failed");
    return null;
  }
}

// ── Public ─────────────────────────────────────────────────────────

export async function getInfraSnapshot(
  force = false,
  scope: InfraScope = { kind: "platform" },
): Promise<InfraSnapshot> {
  const key = cacheKey(scope);
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.snap;

  const instanceId = await getInstanceId();
  const [deploys, alarms, ses, metrics, jobs, recentErrors, emailFailures, database, worker, queues, backup, alerts, heartbeat, errorTrend, abuse, dr] =
    await Promise.all([
      fetchDeploys(),
      fetchAlarms(),
      fetchSes(),
      fetchMetrics(instanceId),
      fetchJobs(),
      fetchRecentErrors(scope),
      fetchEmailFailures(scope),
      fetchDatabase(),
      fetchWorker(),
      fetchQueues(scope),
      fetchBackup(),
      fetchAlerts(),
      fetchHeartbeat(scope),
      fetchErrorTrend(scope),
      fetchAbuse(scope),
      fetchDr(),
    ]);
  const snap: InfraSnapshot = {
    generatedAt: new Date().toISOString(),
    region: REGION,
    build: getBuildInfo(),
    database,
    worker,
    queues,
    heartbeat,
    errorTrend,
    abuse,
    dr,
    backup,
    alerts,
    deploys,
    alarms,
    ses,
    metrics,
    jobs,
    recentErrors,
    emailFailures,
  };
  cache.set(key, { at: Date.now(), snap });
  return snap;
}
