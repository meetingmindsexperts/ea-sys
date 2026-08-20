/**
 * nginx traffic snapshot reader for the /admin/infra Traffic card.
 *
 * The data is produced on the HOST by scripts/nginx-traffic-snapshot.sh (hourly
 * cron) and dropped into ./logs, which is already mounted into both web
 * containers. The app never reads /var/log/nginx directly: those files are
 * www-data:adm mode 640 and outside every container mount, so the alternative
 * was a new bind mount plus an ACL, which widens what the web container can
 * read for a read-only reporting feature. See the header of that script.
 *
 * WHAT THIS MEASURES, AND WHAT IT DOES NOT
 * ----------------------------------------
 * Every HTTP request nginx served, including bots, monitoring and static
 * assets. That makes it a LOAD signal: capacity, abuse, error rate. It is NOT
 * a visitor count and must not be presented as one. Human visitor numbers come
 * from the analytics beacon (docs/ANALYTICS_PLAN.md), which measures real
 * browsers doing real things. The two answer different questions, which is why
 * one lives on the infra page and the other on the event Analytics page.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { apiLogger } from "@/lib/logger";

export type TrafficStatus = "ok" | "error" | "unconfigured";

/** [human, bot] pair. Kept as a tuple to keep the on-disk JSON small. */
export type SplitCount = [number, number];

export interface TrafficBucket {
  /** UTC hour, "YYYY-MM-DDTHH". */
  h: string;
  total: number;
  bot: number;
  /** Response status classes. */
  s2: number;
  s3: number;
  s4: number;
  s5: number;
  page: SplitCount;
  api: SplitCount;
  asset: SplitCount;
  health: SplitCount;
  other: SplitCount;
}

export interface NginxTraffic {
  generatedAt: string;
  /** Days of nginx log re-parsed on the last run (the LIVE window). */
  windowDays: number;
  /** How much accumulated history the archive keeps. */
  archiveDays: number;
  cutoff: string;
  /** Full extent of the merged archive, which outlives logrotate. */
  oldestBucket: string;
  newestBucket: string;
  parsed: number;
  skipped: number;
  malformed: number;
  offsetSkew: number;
  buckets: TrafficBucket[];
  topPaths: { path: string; count: number }[];
  topReferrers: { host: string; count: number }[];
  /** Derived at read time so the card does not have to trust a stored value. */
  ageMinutes: number;
  stale: boolean;
}

/**
 * The snapshot runs hourly, so anything past two and a half hours means the
 * cron has stopped. Reported as stale rather than rendered silently: showing
 * last week's traffic as if it were current is worse than showing nothing,
 * because an operator would plan a maintenance window around it.
 */
const STALE_AFTER_MINUTES = 150;

/** Defensive: the file is ours, but it is parsed by a privileged page. */
const MAX_BUCKETS = 24 * 31;
const MAX_TOP = 50;

function toInt(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
}

function toSplit(v: unknown): SplitCount {
  return Array.isArray(v) ? [toInt(v[0]), toInt(v[1])] : [0, 0];
}

function parseBucket(raw: unknown): TrafficBucket | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  // The hour key is the only field that is a string, and it is what every
  // downstream calculation is keyed on. A malformed one would silently produce
  // an "Invalid Date" column, so reject the row rather than render a gap.
  if (typeof r.h !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(r.h)) return null;
  return {
    h: r.h,
    total: toInt(r.total),
    bot: toInt(r.bot),
    s2: toInt(r.s2),
    s3: toInt(r.s3),
    s4: toInt(r.s4),
    s5: toInt(r.s5),
    page: toSplit(r.page),
    api: toSplit(r.api),
    asset: toSplit(r.asset),
    health: toSplit(r.health),
    other: toSplit(r.other),
  };
}

export function snapshotPath(): string {
  return process.env.NGINX_TRAFFIC_FILE || join(process.cwd(), "logs", "nginx-traffic.json");
}

export async function fetchNginxTraffic(): Promise<{
  status: TrafficStatus;
  error?: string;
  info: NginxTraffic | null;
}> {
  const file = snapshotPath();
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    // ENOENT is the ordinary "cron not installed yet" case and is a normal
    // state on a fresh box, so it is unconfigured rather than an error. Every
    // other read failure is a genuine problem and logs.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return {
        status: "unconfigured",
        info: null,
        error:
          "No traffic snapshot yet. Add the hourly cron for scripts/nginx-traffic-snapshot.sh (see the script header).",
      };
    }
    apiLogger.error({ err, file }, "infra:nginx-traffic-read-failed");
    return { status: "error", info: null, error: "Could not read the traffic snapshot." };
  }

  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const generatedAt = typeof raw.generatedAt === "string" ? raw.generatedAt : null;
    if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) {
      apiLogger.warn({ file }, "infra:nginx-traffic-missing-timestamp");
      return { status: "error", info: null, error: "Traffic snapshot has no valid timestamp." };
    }

    const buckets = (Array.isArray(raw.buckets) ? raw.buckets : [])
      .slice(0, MAX_BUCKETS)
      .map(parseBucket)
      .filter((b): b is TrafficBucket => b !== null)
      .sort((a, b) => a.h.localeCompare(b.h));

    const topPaths = (Array.isArray(raw.topPaths) ? raw.topPaths : [])
      .slice(0, MAX_TOP)
      .map((p) => {
        const r = (p ?? {}) as Record<string, unknown>;
        return { path: typeof r.path === "string" ? r.path : "", count: toInt(r.count) };
      })
      .filter((p) => p.path !== "");

    const topReferrers = (Array.isArray(raw.topReferrers) ? raw.topReferrers : [])
      .slice(0, MAX_TOP)
      .map((p) => {
        const r = (p ?? {}) as Record<string, unknown>;
        return { host: typeof r.host === "string" ? r.host : "", count: toInt(r.count) };
      })
      .filter((p) => p.host !== "");

    const ageMinutes = Math.max(0, Math.round((Date.now() - Date.parse(generatedAt)) / 60_000));

    return {
      status: "ok",
      info: {
        generatedAt,
        windowDays: toInt(raw.windowDays) || 16,
        archiveDays: toInt(raw.archiveDays) || 400,
        cutoff: typeof raw.cutoff === "string" ? raw.cutoff : "",
        oldestBucket: typeof raw.oldestBucket === "string" ? raw.oldestBucket : "",
        newestBucket: typeof raw.newestBucket === "string" ? raw.newestBucket : "",
        parsed: toInt(raw.parsed),
        skipped: toInt(raw.skipped),
        malformed: toInt(raw.malformed),
        offsetSkew: toInt(raw.offsetSkew),
        buckets,
        topPaths,
        topReferrers,
        ageMinutes,
        stale: ageMinutes > STALE_AFTER_MINUTES,
      },
    };
  } catch (err) {
    apiLogger.error({ err, file }, "infra:nginx-traffic-parse-failed");
    return { status: "error", info: null, error: "Traffic snapshot is not valid JSON." };
  }
}
