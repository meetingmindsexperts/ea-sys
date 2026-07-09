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
import { apiLogger } from "@/lib/logger";

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

// ── Types ──────────────────────────────────────────────────────────
type SourceStatus = "ok" | "error" | "unconfigured";

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

export interface InfraSnapshot {
  generatedAt: string;
  region: string;
  deploys: { status: SourceStatus; error?: string; runs: DeployRun[] };
  ses: { status: SourceStatus; error?: string; info: SesInfo | null };
  alarms: { status: SourceStatus; error?: string; inAlarm: AlarmRow[] };
  metrics: { status: SourceStatus; error?: string; instanceId: string | null; values: MetricValue[] };
}

let cache: { at: number; snap: InfraSnapshot } | null = null;

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
          { Id: "cpu", MetricStat: { Metric: { Namespace: "AWS/EC2", MetricName: "CPUUtilization", Dimensions: dim }, Period: 300, Stat: "Average" }, ReturnData: true },
          { Id: "credit", MetricStat: { Metric: { Namespace: "AWS/EC2", MetricName: "CPUCreditBalance", Dimensions: dim }, Period: 300, Stat: "Average" }, ReturnData: true },
          // CWAgent mem/disk if published — SEARCH tolerates the extra dimensions.
          { Id: "mem", Expression: `SEARCH('{CWAgent} MetricName="mem_used_percent" InstanceId="${instanceId}"', 'Average', 300)`, ReturnData: true },
          { Id: "disk", Expression: `SEARCH('{CWAgent} MetricName="disk_used_percent" InstanceId="${instanceId}"', 'Average', 300)`, ReturnData: true },
        ],
      }),
    );
    const byId = new Map((out.MetricDataResults || []).map((r) => [r.Id, r.Values]));
    const values: MetricValue[] = [
      { label: "CPU", value: latest(byId.get("cpu")), unit: "%" },
      { label: "CPU credits", value: latest(byId.get("credit")), unit: "" },
      { label: "Memory", value: latest(byId.get("mem")), unit: "%" },
      { label: "Disk", value: latest(byId.get("disk")), unit: "%" },
    ];
    return { status: "ok", instanceId, values };
  } catch (err) {
    apiLogger.warn({ err }, "infra:metrics-failed");
    return { status: "error", error: friendlyAwsError(err), instanceId, values: [] };
  }
}

// ── Public ─────────────────────────────────────────────────────────

export async function getInfraSnapshot(force = false): Promise<InfraSnapshot> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.snap;

  const instanceId = await getInstanceId();
  const [deploys, alarms, ses, metrics] = await Promise.all([
    fetchDeploys(),
    fetchAlarms(),
    fetchSes(),
    fetchMetrics(instanceId),
  ]);
  const snap: InfraSnapshot = {
    generatedAt: new Date().toISOString(),
    region: REGION,
    deploys,
    alarms,
    ses,
    metrics,
  };
  cache = { at: Date.now(), snap };
  return snap;
}
