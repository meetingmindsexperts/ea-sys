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
  RefreshCw, Rocket, Mail, BellRing, Cpu, Loader2, AlertTriangle, CheckCircle2, ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Snapshot {
  generatedAt: string;
  region: string;
  deploys: { status: string; error?: string; runs: { title: string; status: string; conclusion: string | null; event: string; createdAt: string; url: string }[] };
  ses: { status: string; error?: string; info: null | { sendingEnabled: boolean; sandbox: boolean; max24Hour: number | null; sentLast24Hours: number | null; maxSendRate: number | null; bounceRate: number | null; complaintRate: number | null; send24h: number | null; bounce24h: number | null; complaint24h: number | null } };
  alarms: { status: string; error?: string; inAlarm: { name: string; metric: string; reason: string; since: string | null }[] };
  metrics: { status: string; error?: string; instanceId: string | null; values: { label: string; value: number | null; unit: string }[] };
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function num(v: number | null, digits = 0) {
  return v == null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: digits });
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
        </div>
      ) : null}
    </div>
  );
}
