/**
 * CloudWatch Logs reader for the /logs viewer (W0-3, Nov 9, 2026).
 *
 * Replaces the viewer's old "docker" source, which shelled out to `docker logs`
 * through the host's Docker socket mounted into the web containers. Anything
 * that can reach that socket can start a privileged container and become root
 * on the box, so the socket is gone and raw container output now reaches us the
 * other way round: the CloudWatch agent on the HOST ships every container's
 * json-file log into `ea-sys/docker`, and this module reads it back with a Logs
 * Insights query.
 *
 * Insights, not FilterLogEvents: FilterLogEvents returns the OLDEST matches
 * first, so "the newest 500 lines of the last 24h" would mean paging through
 * the whole day. Insights sorts server-side and stops at the limit.
 *
 * When the app itself is down this page is down too. The laptop-side
 * counterpart for that case is scripts/prod-diagnose.sh, which reads the same
 * groups with the AWS CLI.
 *
 * IAM on the instance role: logs:StartQuery, logs:GetQueryResults and
 * logs:StopQuery on the three groups below. See infra/cloudwatch/README.md.
 */
import {
  CloudWatchLogsClient,
  GetQueryResultsCommand,
  StartQueryCommand,
  StopQueryCommand,
  type ResultField,
} from "@aws-sdk/client-cloudwatch-logs";
import { apiLogger } from "@/lib/logger";

export const CLOUDWATCH_LOG_GROUPS = {
  "cloudwatch-docker": "ea-sys/docker",
  "cloudwatch-app": "ea-sys/app",
  "cloudwatch-nginx": "ea-sys/nginx-error",
} as const;

export type CloudWatchLogSource = keyof typeof CLOUDWATCH_LOG_GROUPS;

export function isCloudWatchLogSource(v: string): v is CloudWatchLogSource {
  return Object.hasOwn(CLOUDWATCH_LOG_GROUPS, v);
}

type LogEntry = { timestamp: string; level: string; message: string };

// "all" is capped: an Insights query is billed per GB scanned, and the groups
// keep 30 days. A week is plenty for the viewer; older lines are a console job.
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 500;
const MAX_WAIT_MS = 15_000;

const REGION = process.env.AWS_CLOUDWATCH_REGION || process.env.AWS_REGION || "ap-south-1";

let client: CloudWatchLogsClient | null = null;
function getClient(): CloudWatchLogsClient {
  if (!client) client = new CloudWatchLogsClient({ region: REGION });
  return client;
}

/** Test seam, mirrors resetInfraClients() in aws-ops.ts. */
export function resetCloudWatchLogsClient(): void {
  client = null;
}

// Pino's level sits in the raw line as `"level":50` (ea-sys/app) or, inside a
// Docker json-file line, escaped as `\"level\":50` (ea-sys/docker). `\\?`
// matches both. nginx writes `[error]`, `[crit]` and so on.
const PINO = (levels: string) => `@message like /level\\\\?":(${levels})[,}]/`;
const LEVEL_FILTERS: Record<string, string> = {
  // Docker's stderr stream is in "error" on purpose: a Node crash trace, an
  // OOM message or a boot failure arrives there as plain text with no pino
  // level, and those are exactly the lines this source exists to show.
  error: `${PINO("50|60")} or @message like /"stream":"stderr"/ or @message like /\\[(error|crit|alert|emerg)\\]/`,
  warn: `${PINO("40")} or @message like /\\[warn\\]/`,
  info: PINO("30"),
  debug: PINO("10|20"),
};

function escapeRegex(s: string): string {
  return s.replace(/[\\/^$.*+?()[\]{}|]/g, "\\$&");
}

export function buildInsightsQuery(level: string, search: string, tail: number): string {
  const parts = ["fields @timestamp, @message"];
  const levelFilter = LEVEL_FILTERS[level];
  if (levelFilter) parts.push(`filter ${levelFilter}`);
  if (search) parts.push(`filter @message like /(?i)${escapeRegex(search)}/`);
  parts.push("sort @timestamp desc", `limit ${tail}`);
  return parts.join(" | ");
}

function pinoLevel(n: unknown): string {
  if (typeof n !== "number") return "info";
  if (n >= 50) return "error";
  if (n >= 40) return "warn";
  if (n >= 30) return "info";
  return "debug";
}

function textLevel(line: string): string {
  if (/\[(error|crit|alert|emerg)\]/.test(line)) return "error";
  if (/\[warn\]/.test(line)) return "warn";
  const lower = line.toLowerCase();
  if (lower.includes("error") || lower.includes("fatal")) return "error";
  if (lower.includes("warn")) return "warn";
  return "info";
}

function tryJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * One raw CloudWatch line → a viewer entry. A Docker json-file line is
 * unwrapped to the container's own output, prefixed with the service label
 * compose puts on it (`ea_sys_service`), so the viewer reads like `docker logs`.
 */
export function toLogEntry(source: CloudWatchLogSource, timestamp: string, raw: string): LogEntry {
  if (source !== "cloudwatch-docker") {
    const pino = tryJson(raw);
    return { timestamp, level: pino ? pinoLevel(pino.level) : textLevel(raw), message: raw };
  }

  const wrapper = tryJson(raw);
  if (!wrapper || typeof wrapper.log !== "string") {
    return { timestamp, level: textLevel(raw), message: raw };
  }
  const line = wrapper.log.trimEnd();
  const attrs = (wrapper.attrs ?? {}) as Record<string, unknown>;
  const service = typeof attrs.ea_sys_service === "string" ? attrs.ea_sys_service : "container";
  const pino = tryJson(line);
  let level = textLevel(line);
  if (pino) level = pinoLevel(pino.level);
  else if (wrapper.stream === "stderr") level = "error";
  return { timestamp, level, message: `[${service}] ${line}` };
}

// Insights answers "2026-11-09 06:12:01.123" in UTC with no zone marker.
function insightsTimeToIso(t: string | undefined): string {
  if (!t) return new Date().toISOString();
  const d = new Date(`${t.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function field(row: ResultField[], name: string): string | undefined {
  return row.find((f) => f.field === name)?.value;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type CloudWatchLogsResult = {
  logs: LogEntry[];
  source: string;
  /** True when the query hit MAX_WAIT_MS and was stopped: a partial answer. */
  partial: boolean;
};

export async function readCloudWatchLogs(
  source: CloudWatchLogSource,
  opts: { level: string; search: string; tail: number; sinceDate: Date | null },
): Promise<CloudWatchLogsResult> {
  const logGroupName = CLOUDWATCH_LOG_GROUPS[source];
  const end = Date.now();
  const capped = !opts.sinceDate || end - opts.sinceDate.getTime() > MAX_WINDOW_MS;
  const start = capped ? end - MAX_WINDOW_MS : opts.sinceDate!.getTime();

  const cw = getClient();
  let queryId: string | undefined;
  try {
    ({ queryId } = await cw.send(
      new StartQueryCommand({
        logGroupName,
        startTime: Math.floor(start / 1000),
        endTime: Math.ceil(end / 1000),
        queryString: buildInsightsQuery(opts.level, opts.search, opts.tail),
        limit: opts.tail,
      }),
    ));
  } catch (err) {
    // The agent creates a group on its first shipped line. Until the config is
    // applied that is a state to explain, not a failure to alarm on.
    if ((err as { name?: string }).name !== "ResourceNotFoundException") throw err;
    apiLogger.warn({ logGroupName }, "logs:cloudwatch-group-missing");
    return { logs: [], source: `cloudwatch (${logGroupName} not created yet: run infra/cloudwatch/setup.sh)`, partial: false };
  }
  if (!queryId) throw new Error("CloudWatch did not return a query id");

  const deadline = Date.now() + MAX_WAIT_MS;
  let status: string | undefined;
  let rows: ResultField[][] = [];
  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    const res = await cw.send(new GetQueryResultsCommand({ queryId }));
    status = res.status;
    rows = res.results ?? [];
    if (status === "Complete") break;
    if (status === "Failed" || status === "Cancelled" || status === "Timeout") {
      throw new Error(`CloudWatch query ${status}`);
    }
    if (Date.now() >= deadline) break;
  }

  const partial = status !== "Complete";
  // A query left running keeps scanning (and billing) after we stop listening.
  if (partial) {
    await cw.send(new StopQueryCommand({ queryId })).catch((err) => {
      apiLogger.warn({ err, queryId, logGroupName }, "logs:cloudwatch-stop-query-failed");
    });
  }

  const logs = rows
    .map((row) => toLogEntry(source, insightsTimeToIso(field(row, "@timestamp")), field(row, "@message") ?? ""))
    .reverse(); // newest-first from Insights → oldest-first like every other source

  const window = capped ? " last 7d" : "";
  return { logs, source: `cloudwatch (${logGroupName}${window}${partial ? ", partial" : ""})`, partial };
}
