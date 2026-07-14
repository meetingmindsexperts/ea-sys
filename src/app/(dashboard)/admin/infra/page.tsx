"use client";

/**
 * Infra / Ops panel — ADMIN + SUPER_ADMIN. On-demand read-only view of the
 * signals that actually bite us: deploys, email (SES) health, CloudWatch
 * alarms, and host metrics. Data + 60s cache come from /api/admin/infra
 * (→ src/lib/infra/aws-ops.ts). Docs: docs/INFRA_OPS.md.
 */

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import {
  RefreshCw, Rocket, Mail, BellRing, Cpu, Loader2, AlertTriangle, CheckCircle2, ExternalLink, Timer, ScrollText, MailWarning,
  Database, Server, Layers, Archive, BellOff, GitCommit, ShieldCheck, ShieldAlert, Radio,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Snapshot {
  generatedAt: string;
  region: string;
  build: { gitSha: string; gitShaShort: string; builtAt: string | null; slot: string | null; hostname: string };
  database: { status: string; error?: string; info: null | { connected: boolean; latencyMs: number | null } };
  worker: { status: string; error?: string; info: null | { reachable: boolean; uptimeSeconds: number | null; gitSha: string | null; jobs: { name: string; schedule: string; lastTickAt: string | null; stale: boolean }[]; staleJobs: string[] } };
  queues: { status: string; error?: string; rows: { label: string; value: number; warnAbove: number; hint: string }[] };
  backup: { status: string; error?: string; info: null | { latestKey: string | null; latestAt: string | null; ageHours: number | null; stale: boolean; bucket: string } };
  alerts: { status: string; error?: string; info: null | { silencedUntil: string | null } };
  deploys: { status: string; error?: string; runs: { title: string; status: string; conclusion: string | null; event: string; createdAt: string; url: string }[] };
  ses: { status: string; error?: string; info: null | { sendingEnabled: boolean; sandbox: boolean; max24Hour: number | null; sentLast24Hours: number | null; maxSendRate: number | null; bounceRate: number | null; complaintRate: number | null; send24h: number | null; bounce24h: number | null; complaint24h: number | null } };
  alarms: { status: string; error?: string; inAlarm: { name: string; metric: string; reason: string; since: string | null }[] };
  metrics: { status: string; error?: string; instanceId: string | null; values: { label: string; value: number | null; unit: string }[] };
  jobs: { status: string; error?: string; workerLastSeen: string | null; rows: { job: string; cadence: string; lastStatus: string | null; lastRunAt: string | null; lastDurationMs: number | null; lastError: string | null; ok24h: number; failed24h: number }[] };
  recentErrors: { status: string; error?: string; rows: { level: string; module: string; message: string; at: string }[] };
  emailFailures: { status: string; error?: string; rows: { to: string; subject: string; error: string | null; templateSlug: string | null; at: string }[] };
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function num(v: number | null, digits = 0) {
  return v == null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: digits });
}


// ── The verdict ───────────────────────────────────────────────────────────────
// The page used to present nine equal-weight cards and leave the operator to
// read all of them and decide for themselves whether anything was wrong. At 3am
// that is the wrong job to hand a human. Everything below exists to answer ONE
// question in under a second: is anything broken, and what.
//
// Severity is deliberately blunt:
//   critical — production is degraded RIGHT NOW, or a safety net is gone.
//   warn     — something needs a human today, but nothing is on fire.

type Severity = "critical" | "warn";
interface Issue {
  severity: Severity;
  label: string;
  detail: string;
  /** id of the card to jump to. */
  anchor: string;
}

function deriveIssues(s: Snapshot): Issue[] {
  const out: Issue[] = [];

  // ── critical ──
  if (s.database.info && !s.database.info.connected) {
    out.push({ severity: "critical", label: "Database unreachable", detail: s.database.error ?? "The app cannot reach Postgres.", anchor: "system" });
  }
  if (s.worker.info && !s.worker.info.reachable) {
    out.push({ severity: "critical", label: "Worker is down", detail: "No background job is running — no emails, certificates or webinar sync.", anchor: "system" });
  }
  for (const a of s.alarms.inAlarm) {
    out.push({ severity: "critical", label: `Alarm: ${a.name}`, detail: a.reason || a.metric, anchor: "alarms" });
  }
  if (s.backup.info?.stale) {
    out.push({ severity: "critical", label: "Database backup is stale", detail: `Newest dump is ${s.backup.info.ageHours?.toFixed(1)}h old. The backup cron may have stopped — check it BEFORE you need it.`, anchor: "backup" });
  }
  if (s.ses.info && !s.ses.info.sendingEnabled) {
    out.push({ severity: "critical", label: "SES sending is disabled", detail: "No email is going out at all.", anchor: "ses" });
  }
  const statusCheck = s.metrics.values.find((m) => m.label === "Status check");
  if (statusCheck?.value != null && statusCheck.value > 0) {
    out.push({ severity: "critical", label: "EC2 status check failing", detail: "The instance itself is unhealthy.", anchor: "metrics" });
  }

  // ── warn ──
  if (s.alerts.info?.silencedUntil) {
    // Being unable to hear alarms is itself a finding. It must never be quiet.
    out.push({ severity: "warn", label: "Alerts are silenced", detail: `You will not be paged until ${fmtTime(s.alerts.info.silencedUntil)}.`, anchor: "system" });
  }
  if (s.worker.info?.staleJobs.length) {
    out.push({ severity: "warn", label: `${s.worker.info.staleJobs.length} worker job(s) stale`, detail: s.worker.info.staleJobs.join(", "), anchor: "jobs" });
  }
  if (s.worker.info?.gitSha && s.worker.info.gitSha !== s.build.gitSha) {
    out.push({ severity: "warn", label: "Web and worker are on different commits", detail: `Web ${s.build.gitShaShort} · worker ${s.worker.info.gitSha.slice(0, 7)}. A deploy probably half-failed.`, anchor: "system" });
  }
  for (const q of s.queues.rows) {
    if (q.value > q.warnAbove) {
      out.push({ severity: "warn", label: `${q.label}: ${q.value}`, detail: q.hint, anchor: "queues" });
    }
  }
  const failing = s.jobs.rows.filter((j) => j.failed24h > 0);
  if (failing.length) {
    out.push({ severity: "warn", label: `${failing.length} job(s) failing`, detail: failing.map((j) => `${j.job} (${j.failed24h}x)`).join(", "), anchor: "jobs" });
  }
  const lastDeploy = s.deploys.runs[0];
  if (lastDeploy && lastDeploy.status === "completed" && lastDeploy.conclusion === "failure") {
    out.push({ severity: "warn", label: "Last deploy failed", detail: lastDeploy.title, anchor: "deploys" });
  }
  if (s.ses.info?.sandbox) {
    out.push({ severity: "warn", label: "SES is in sandbox mode", detail: "Mail only reaches verified addresses.", anchor: "ses" });
  }
  if (s.ses.info?.bounceRate != null && s.ses.info.bounceRate > 0.05) {
    out.push({ severity: "warn", label: "SES bounce rate is high", detail: `${(s.ses.info.bounceRate * 100).toFixed(2)}% — sending can be suspended above ~5%.`, anchor: "ses" });
  }
  if (s.emailFailures.rows.length > 0) {
    out.push({ severity: "warn", label: `${s.emailFailures.rows.length} recent email failure(s)`, detail: "Someone did not get an email they were promised.", anchor: "email-failures" });
  }
  for (const m of s.metrics.values) {
    const v = m.value;
    if (v == null) continue;
    if (m.label === "Memory" && v > 85) out.push({ severity: "warn", label: `Memory at ${v.toFixed(0)}%`, detail: "INC-001 was an out-of-memory freeze on this box.", anchor: "metrics" });
    if (m.label === "Disk" && v > 80) out.push({ severity: "warn", label: `Disk at ${v.toFixed(0)}%`, detail: "INC-002 was a full disk. Run scripts/docker-prune.sh.", anchor: "metrics" });
    if (m.label === "CPU" && v > 85) out.push({ severity: "warn", label: `CPU at ${v.toFixed(0)}%`, detail: "Sustained high CPU burns t3 credits.", anchor: "metrics" });
    if (m.label === "CPU credits" && v < 40) out.push({ severity: "warn", label: `CPU credits low (${v.toFixed(0)})`, detail: "The box will not crash — it will get SLOW, and it will look like a database problem.", anchor: "metrics" });
  }

  // Critical first, then warnings — the order you want to read them in.
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1));
}

/** Colour a metric by what the number MEANS, not just print it. */
function metricTone(label: string, v: number | null): string {
  if (v == null) return "";
  if (label === "Memory") return v > 85 ? "text-red-600" : v > 70 ? "text-amber-600" : "";
  if (label === "Disk") return v > 80 ? "text-red-600" : v > 65 ? "text-amber-600" : "";
  if (label === "CPU") return v > 85 ? "text-red-600" : v > 60 ? "text-amber-600" : "";
  if (label === "CPU credits") return v < 40 ? "text-amber-600" : "";
  if (label === "Status check") return v > 0 ? "text-red-600" : "";
  return "";
}

function StatusNote({ status, error, unconfiguredHint }: { status: string; error?: string; unconfiguredHint: string }) {
  if (status === "error")
    return <p className="text-sm text-amber-600 flex items-start gap-1.5"><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />{error}</p>;
  if (status === "unconfigured")
    return <p className="text-sm text-muted-foreground">{unconfiguredHint}</p>;
  return null;
}

export default function InfraPage() {
  const { data: session } = useSession();
  const role = session?.user?.role;
  const isAdmin = role === "ADMIN" || role === "SUPER_ADMIN";

  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [silencing, setSilencing] = useState(false);

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    try {
      const res = await fetch(`/api/admin/infra${force ? "?refresh=1" : ""}`);
      const json = await res.json();
      if (!res.ok) {
        console.error("infra:load-failed", res.status, json?.error);
        setError(json.error || "Failed to load infra snapshot");
        return;
      }
      setSnap(json);
      setError(null);
    } catch (err) {
      console.error("infra:load-error", err);
      setError("Failed to load infra snapshot");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Stop paging yourself while you fix the thing that is paging you. Every
  // .error() in the app emails the operator, so an incident IS a burst of
  // alerts — and the person remediating it was getting mailed by their own
  // restarts and replays. Time-boxed on the server (max 4h) on purpose: a
  // silence that never expires is how prod stays broken since Tuesday.
  const setSilence = useCallback(async (minutes: number) => {
    setSilencing(true);
    try {
      const res = await fetch("/api/admin/alerts/silence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minutes, reason: minutes > 0 ? "silenced from /admin/infra" : "unsilenced" }),
      });
      const json = await res.json();
      if (!res.ok) {
        console.error("infra:silence-failed", res.status, json?.error);
        toast.error(json?.error || "Could not change alert silence");
        return;
      }
      toast.success(minutes > 0 ? `Alerts silenced for ${minutes} minutes` : "Alerts resumed");
      await load(true);
    } catch (err) {
      console.error("infra:silence-error", err);
      toast.error("Could not change alert silence");
    } finally {
      setSilencing(false);
    }
  }, [load]);

  useEffect(() => {
    if (isAdmin) load();
    else setLoading(false);
  }, [isAdmin, load]);

  if (!isAdmin) {
    return <div className="p-8 text-sm text-muted-foreground">Not authorized.</div>;
  }

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Cpu className="h-6 w-6 text-primary" /> Infra / Ops</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Deploys, email health, alarms and host metrics{snap ? ` · ${snap.region} · updated ${fmtTime(snap.generatedAt)}` : ""}.
          </p>
          {/* "What is actually running?" — the first question of every incident,
              and one this system could not answer until the SHA was baked into
              the image. */}
          {snap && (
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5 font-mono">
              <GitCommit className="h-3.5 w-3.5" />
              {snap.build.gitShaShort}
              {snap.build.slot && <span className="px-1.5 py-0.5 rounded bg-muted">{snap.build.slot}</span>}
              {snap.build.builtAt && <span className="text-muted-foreground/70">built {fmtTime(snap.build.builtAt)}</span>}
              {snap.worker.info?.gitSha && snap.worker.info.gitSha !== snap.build.gitSha && (
                <span className="text-amber-600" title="The worker is running a different commit from the web tier. A deploy probably half-failed.">
                  ⚠ worker on {snap.worker.info.gitSha.slice(0, 7)}
                </span>
              )}
            </p>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={() => load(true)} disabled={refreshing}>
          {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />} Refresh
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : snap ? (
        <div className="grid lg:grid-cols-2 gap-4">
          {/* ── Is the system alive? ──────────────────────────────────────────
              These four go first because they are what you check before you
              look at anything else. Previously none of them existed: you could
              see that a job RAN, but not whether the database was up, whether
              the worker was actually alive, whether work was piling up behind
              it, or whether a backup had been taken this century. */}

          {/* System status — DB + worker + alerts, one row */}
          <Card className="lg:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Server className="h-4 w-4 text-primary" /> System status
              </CardTitle>
            </CardHeader>
            <CardContent className="grid sm:grid-cols-3 gap-3">
              {/* Database */}
              <div className="rounded border p-3">
                <div className="text-xs text-muted-foreground flex items-center gap-1.5 mb-1"><Database className="h-3.5 w-3.5" /> Database</div>
                {snap.database.info?.connected ? (
                  <div className="text-emerald-600 font-medium flex items-center gap-1.5">
                    <CheckCircle2 className="h-4 w-4" /> Connected
                    <span className="text-xs text-muted-foreground font-normal">{snap.database.info.latencyMs}ms</span>
                  </div>
                ) : (
                  <div className="text-red-600 font-medium flex items-center gap-1.5">
                    <AlertTriangle className="h-4 w-4" /> Unreachable
                  </div>
                )}
                {snap.database.error && <p className="text-xs text-red-600 mt-1 break-all">{snap.database.error}</p>}
              </div>

              {/* Worker — LIVE, not inferred from JobRun rows */}
              <div className="rounded border p-3">
                <div className="text-xs text-muted-foreground flex items-center gap-1.5 mb-1"><Timer className="h-3.5 w-3.5" /> Worker</div>
                {snap.worker.info?.reachable ? (
                  <>
                    <div className="text-emerald-600 font-medium flex items-center gap-1.5">
                      <CheckCircle2 className="h-4 w-4" /> Alive
                      <span className="text-xs text-muted-foreground font-normal">
                        up {Math.floor((snap.worker.info.uptimeSeconds ?? 0) / 60)}m
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {snap.worker.info.jobs.length} jobs registered
                      {snap.worker.info.staleJobs.length > 0 && (
                        <span className="text-amber-600 font-medium"> · {snap.worker.info.staleJobs.length} stale</span>
                      )}
                    </p>
                    {snap.worker.info.staleJobs.length > 0 && (
                      <p className="text-xs text-amber-600 mt-0.5 break-words" title="Registered, but has not ticked within 3x its cadence.">
                        {snap.worker.info.staleJobs.join(", ")}
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <div className="text-red-600 font-medium flex items-center gap-1.5">
                      <AlertTriangle className="h-4 w-4" /> Unreachable
                    </div>
                    <p className="text-xs text-red-600 mt-1">{snap.worker.error}</p>
                  </>
                )}
              </div>

              {/* Alerts — with the silence control */}
              <div className="rounded border p-3">
                <div className="text-xs text-muted-foreground flex items-center gap-1.5 mb-1"><BellRing className="h-3.5 w-3.5" /> Alerts</div>
                {snap.alerts.info?.silencedUntil ? (
                  <>
                    <div className="text-amber-600 font-medium flex items-center gap-1.5">
                      <BellOff className="h-4 w-4" /> Silenced
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">until {fmtTime(snap.alerts.info.silencedUntil)}</p>
                    <Button size="sm" variant="outline" className="mt-2 h-7 text-xs" disabled={silencing} onClick={() => setSilence(0)}>
                      Resume alerts
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="text-emerald-600 font-medium flex items-center gap-1.5">
                      <CheckCircle2 className="h-4 w-4" /> Live
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">Every error emails the operator.</p>
                    <div className="flex gap-1.5 mt-2">
                      <Button size="sm" variant="outline" className="h-7 text-xs" disabled={silencing} onClick={() => setSilence(30)}>
                        Silence 30m
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 text-xs" disabled={silencing} onClick={() => setSilence(120)}>
                        2h
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Queues — "is work piling up?" You could always see that a job ran.
              You could never see that it was falling behind. */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Layers className="h-4 w-4 text-primary" /> Queues</CardTitle></CardHeader>
            <CardContent>
              <StatusNote status={snap.queues.status} error={snap.queues.error} unconfiguredHint="No queue data." />
              {snap.queues.status === "ok" && (
                <div className="space-y-1.5">
                  {snap.queues.rows.map((q) => {
                    const bad = q.value > q.warnAbove;
                    return (
                      <div key={q.label} className="flex items-center justify-between gap-2 text-sm" title={q.hint}>
                        <span className={bad ? "font-medium" : "text-muted-foreground"}>{q.label}</span>
                        <span className={`font-mono ${bad ? "text-red-600 font-bold" : "text-muted-foreground"}`}>{q.value}</span>
                      </div>
                    );
                  })}
                  {snap.queues.rows.every((q) => q.value <= q.warnAbove) && (
                    <p className="text-sm text-emerald-600 flex items-center gap-1.5 pt-1"><CheckCircle2 className="h-4 w-4" /> Nothing backing up.</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Last backup — nothing had EVER read back from the DR bucket. A
              backup nobody verifies is a backup you find out about at restore
              time, which is the worst possible moment. */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Archive className="h-4 w-4 text-primary" /> Last database backup</CardTitle></CardHeader>
            <CardContent>
              <StatusNote status={snap.backup.status} error={snap.backup.error} unconfiguredHint="DR bucket not configured." />
              {snap.backup.status === "ok" && snap.backup.info && (
                <div className="space-y-1">
                  <div className={`text-xl font-bold ${snap.backup.info.stale ? "text-red-600" : "text-emerald-600"}`}>
                    {snap.backup.info.ageHours == null ? "—" : `${snap.backup.info.ageHours.toFixed(1)}h ago`}
                  </div>
                  {snap.backup.info.stale && (
                    <p className="text-sm text-red-600 flex items-start gap-1.5">
                      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                      Stale. The dump cron may have stopped — check it on the box before you need it.
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground break-all">
                    s3://{snap.backup.info.bucket}/{snap.backup.info.latestKey}
                  </p>
                  {snap.backup.info.latestAt && (
                    <p className="text-xs text-muted-foreground">{fmtTime(snap.backup.info.latestAt)}</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Cron / Jobs — full width */}
          <Card className="lg:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Timer className="h-4 w-4 text-primary" /> Cron / Jobs
                {snap.jobs.status === "ok" && (
                  <span className="text-xs font-normal text-muted-foreground ml-auto">
                    worker last seen {ago(snap.jobs.workerLastSeen)}
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <StatusNote status={snap.jobs.status} error={snap.jobs.error} unconfiguredHint="No job runs recorded yet." />
              {snap.jobs.status === "ok" && (snap.jobs.rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No worker runs recorded yet (deploy the worker + wait for the first tick).</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs text-muted-foreground">
                      <tr><th className="p-1.5">Job</th><th className="p-1.5">Schedule</th><th className="p-1.5">Last run</th><th className="p-1.5">Status</th><th className="p-1.5 text-right">Duration</th><th className="p-1.5 text-right">24h OK</th><th className="p-1.5 text-right">24h fail</th></tr>
                    </thead>
                    <tbody>
                      {snap.jobs.rows.map((j) => (
                        <tr key={j.job} className="border-t align-top">
                          <td className="p-1.5 font-medium">{j.job}</td>
                          <td className="p-1.5 text-xs text-muted-foreground whitespace-nowrap">{j.cadence || "—"}</td>
                          <td className="p-1.5 text-muted-foreground whitespace-nowrap">{ago(j.lastRunAt)}</td>
                          <td className="p-1.5">
                            {j.lastStatus === "OK"
                              ? <span className="text-emerald-600 text-xs font-medium">OK</span>
                              : j.lastStatus === "FAILED"
                                ? <span className="text-red-600 text-xs font-medium" title={j.lastError || ""}>FAILED</span>
                                : <span className="text-muted-foreground text-xs">awaiting first run</span>}
                          </td>
                          <td className="p-1.5 text-right text-muted-foreground whitespace-nowrap">{j.lastDurationMs == null ? "—" : `${j.lastDurationMs} ms`}</td>
                          <td className="p-1.5 text-right">{j.ok24h}</td>
                          <td className={`p-1.5 text-right ${j.failed24h > 0 ? "text-red-600 font-medium" : "text-muted-foreground"}`}>{j.failed24h}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Alarms */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><BellRing className="h-4 w-4 text-primary" /> Alarms</CardTitle></CardHeader>
            <CardContent>
              <StatusNote status={snap.alarms.status} error={snap.alarms.error} unconfiguredHint="No alarms configured." />
              {snap.alarms.status === "ok" && (snap.alarms.inAlarm.length === 0 ? (
                <p className="text-sm text-emerald-600 flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4" /> All clear — nothing in ALARM.</p>
              ) : (
                <div className="space-y-2">
                  {snap.alarms.inAlarm.map((a) => (
                    <div key={a.name} className="rounded border border-red-200 bg-red-50 p-2 text-sm">
                      <div className="font-medium text-red-700">{a.name}</div>
                      <div className="text-xs text-red-600">{a.metric}{a.since ? ` · since ${fmtTime(a.since)}` : ""}</div>
                      {a.reason && <div className="text-xs text-muted-foreground mt-0.5">{a.reason}</div>}
                    </div>
                  ))}
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Host metrics */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Cpu className="h-4 w-4 text-primary" /> Host metrics</CardTitle></CardHeader>
            <CardContent>
              <StatusNote status={snap.metrics.status} error={snap.metrics.error} unconfiguredHint="Instance metrics unavailable (no instance id / not on EC2)." />
              {snap.metrics.status === "ok" && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    {snap.metrics.values.map((m) => (
                      <div key={m.label} className="rounded border p-3">
                        <div className="text-xs text-muted-foreground">{m.label}</div>
                        <div className="text-xl font-bold">{num(m.value, 1)}<span className="text-sm font-normal text-muted-foreground">{m.unit}</span></div>
                      </div>
                    ))}
                  </div>
                  {snap.metrics.instanceId && <p className="text-xs text-muted-foreground mt-2">{snap.metrics.instanceId}</p>}
                </>
              )}
            </CardContent>
          </Card>

          {/* Email / SES */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Mail className="h-4 w-4 text-primary" /> Email (SES)</CardTitle></CardHeader>
            <CardContent>
              <StatusNote status={snap.ses.status} error={snap.ses.error} unconfiguredHint="SES not configured." />
              {snap.ses.status === "ok" && snap.ses.info && (
                <div className="space-y-2 text-sm">
                  <div className="flex flex-wrap gap-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${snap.ses.info.sendingEnabled ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                      {snap.ses.info.sendingEnabled ? "Sending enabled" : "Sending DISABLED"}
                    </span>
                    {snap.ses.info.sandbox && <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">Sandbox mode</span>}
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    <span className="text-muted-foreground">24h quota</span>
                    <span>{num(snap.ses.info.sentLast24Hours)} / {num(snap.ses.info.max24Hour)}</span>
                    <span className="text-muted-foreground">Max rate</span>
                    <span>{num(snap.ses.info.maxSendRate, 1)}/s</span>
                    <span className="text-muted-foreground">Bounce rate</span>
                    <span className={snap.ses.info.bounceRate != null && snap.ses.info.bounceRate > 0.05 ? "text-red-600 font-medium" : ""}>{snap.ses.info.bounceRate == null ? "—" : `${(snap.ses.info.bounceRate * 100).toFixed(2)}%`}</span>
                    <span className="text-muted-foreground">Complaint rate</span>
                    <span className={snap.ses.info.complaintRate != null && snap.ses.info.complaintRate > 0.001 ? "text-red-600 font-medium" : ""}>{snap.ses.info.complaintRate == null ? "—" : `${(snap.ses.info.complaintRate * 100).toFixed(3)}%`}</span>
                    <span className="text-muted-foreground">24h send / bounce / complaint</span>
                    <span>{num(snap.ses.info.send24h)} / {num(snap.ses.info.bounce24h)} / {num(snap.ses.info.complaint24h)}</span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Deploys */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Rocket className="h-4 w-4 text-primary" /> Deploys</CardTitle></CardHeader>
            <CardContent>
              <StatusNote status={snap.deploys.status} error={snap.deploys.error} unconfiguredHint="Set GITHUB_OPS_TOKEN (read-only Actions) to show GitHub deploy runs." />
              {snap.deploys.status === "ok" && (
                <div className="space-y-1.5">
                  {snap.deploys.runs.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No recent runs.</p>
                  ) : snap.deploys.runs.map((r, i) => {
                    const state = r.status !== "completed" ? r.status : (r.conclusion || "");
                    const color = state === "success" ? "text-emerald-600" : state === "failure" ? "text-red-600" : state === "cancelled" ? "text-muted-foreground" : "text-amber-600";
                    return (
                      <a key={i} href={r.url} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between gap-2 py-1 hover:bg-muted/40 rounded px-1 text-sm">
                        <span className="truncate flex-1">{r.title}</span>
                        <span className={`text-xs font-medium ${color} whitespace-nowrap`}>{state}</span>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">{fmtTime(r.createdAt)}</span>
                        <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                      </a>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Email failures */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><MailWarning className="h-4 w-4 text-primary" /> Email failures</CardTitle></CardHeader>
            <CardContent>
              <StatusNote status={snap.emailFailures.status} error={snap.emailFailures.error} unconfiguredHint="No email log." />
              {snap.emailFailures.status === "ok" && (snap.emailFailures.rows.length === 0 ? (
                <p className="text-sm text-emerald-600 flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4" /> No recent send failures.</p>
              ) : (
                <div className="space-y-1.5">
                  {snap.emailFailures.rows.map((e, i) => (
                    <div key={i} className="text-sm border-b pb-1.5 last:border-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium truncate">{e.to}</span>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">{ago(e.at)}</span>
                      </div>
                      <div className="text-xs text-muted-foreground truncate">{e.subject}</div>
                      {e.error && <div className="text-xs text-red-600 truncate">{e.error}</div>}
                    </div>
                  ))}
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Recent errors — full width */}
          <Card className="lg:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <ScrollText className="h-4 w-4 text-primary" /> Recent errors &amp; warnings
                <Link href="/logs" className="text-xs font-normal text-primary hover:underline ml-auto">View all in /logs →</Link>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <StatusNote status={snap.recentErrors.status} error={snap.recentErrors.error} unconfiguredHint="No logs." />
              {snap.recentErrors.status === "ok" && (snap.recentErrors.rows.length === 0 ? (
                <p className="text-sm text-emerald-600 flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4" /> No recent errors or warnings.</p>
              ) : (
                <div className="space-y-1 font-mono text-xs max-h-80 overflow-y-auto">
                  {snap.recentErrors.rows.map((l, i) => (
                    <div key={i} className="flex items-start gap-2 border-b border-slate-100 pb-1 last:border-0">
                      <span className={`shrink-0 px-1.5 rounded ${l.level === "error" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>{l.level}</span>
                      <span className="shrink-0 text-muted-foreground">{l.module}</span>
                      <span className="shrink-0 text-muted-foreground">{ago(l.at)}</span>
                      <span className="text-slate-700 break-all">{l.message}</span>
                    </div>
                  ))}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
