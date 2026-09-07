"use client";

/**
 * Body of the "Uploads storage" card on /admin/infra (Sep 7, 2026). Extracted
 * from the page so it can be RENDERED in a unit test: the page is a dynamic
 * client component that neither the build nor the suite ever renders, and a
 * card that throws takes the whole page down (the Aug 25, 2026 lesson).
 */
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { DrArtifact, UploadsStorage } from "@/lib/infra/aws-ops";
import { ago, bytesFmt, fmtTime, num } from "./format";

export function UploadsStorageBody({ u, mirror }: { u: UploadsStorage; mirror: DrArtifact | null }) {
  // The mirror never deletes, so it must hold every source object old enough to
  // have been synced; fewer than that is missing data, not lag.
  const mirrorShort = mirror != null && !mirror.listingTruncated && !u.inventoryTruncated && mirror.objectCount < u.objectsOlderThanGrace;
  const tiles: { label: string; value: string; tone?: string; hint?: string }[] = [
    { label: "Objects", value: u.inventoryTruncated ? `${num(u.objectCount)}+` : num(u.objectCount), hint: u.inventoryTruncated ? "Listing capped; CloudWatch has the full count" : undefined },
    { label: "Size", value: bytesFmt(u.totalBytes) },
    { label: "Newest upload", value: ago(u.newestAt), hint: u.newestKey ?? undefined },
    {
      label: "Mirror (Singapore)",
      value: mirror ? `${num(mirror.objectCount)} objects` : "—",
      tone: mirrorShort ? "text-red-600" : "",
      hint: mirrorShort ? `Short of the ${num(u.objectsOlderThanGrace)} source objects older than ${u.mirrorGraceHours}h` : "Holds deleted files too, so it can exceed the source",
    },
  ];
  const r = u.requests;
  const a = u.accessLogs;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-muted-foreground font-mono">{u.bucket} · {u.region}</p>
      <div className="grid grid-cols-2 gap-3">
        {tiles.map((t) => (
          <div key={t.label} className="rounded border p-3" title={t.hint}>
            <div className="text-xs text-muted-foreground">{t.label}</div>
            <div className={`text-xl font-bold tabular-nums ${t.tone ?? ""}`}>{t.value}</div>
          </div>
        ))}
      </div>
      <div className="space-y-0.5">
        {u.byPrefix.slice(0, 6).map((p) => (
          <div key={p.prefix} className="flex items-center justify-between gap-2 text-xs">
            <span className="font-mono text-muted-foreground">{p.prefix}/</span>
            <span className="tabular-nums">{num(p.objects)} · {bytesFmt(p.bytes)}</span>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {u.versions
          ? `${num(u.versions.noncurrentCount)} noncurrent version(s), ${bytesFmt(u.versions.noncurrentBytes)} · ${num(u.versions.deleteMarkers)} delete marker(s)`
          : "Version history not readable"}
        {" · "}
        {u.cloudwatch.sizeBytes == null
          ? "CloudWatch storage metrics: no datapoint yet (daily, first one lands 24 to 48h after creation)"
          : `CloudWatch: ${bytesFmt(u.cloudwatch.sizeBytes)} / ${num(u.cloudwatch.objectCount)} objects as of ${u.cloudwatch.asOf ? fmtTime(u.cloudwatch.asOf) : "—"}`}
      </p>

      <div>
        <div className="text-xs font-medium mb-1">Requests (24h)</div>
        {r.enabled ? (
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: "All", value: num(r.all) },
              { label: "GET", value: num(r.get) },
              { label: "PUT", value: num(r.put) },
              { label: "4xx", value: num(r.errors4xx), tone: (r.errors4xx ?? 0) > 0 ? "text-amber-600" : "" },
              { label: "5xx", value: num(r.errors5xx), tone: (r.errors5xx ?? 0) > 0 ? "text-red-600" : "" },
              { label: "First byte", value: r.firstByteMs == null ? "—" : `${num(r.firstByteMs)} ms` },
            ].map((t) => (
              <div key={t.label} className="rounded border p-2">
                <div className="text-xs text-muted-foreground">{t.label}</div>
                <div className={`font-bold tabular-nums ${t.tone ?? ""}`}>{t.value}</div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Request metrics are not enabled on the bucket (a paid per-bucket toggle, about 5 dollars a month). Enable with id{" "}
            <code className="font-mono">{r.filterId}</code>; docs/INFRA_OPS.md has the command.
          </p>
        )}
      </div>

      <div>
        <div className="text-xs font-medium mb-1">Configuration</div>
        <div className="space-y-1">
          {u.checks.map((c) => {
            const icon =
              c.ok === true ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
              : c.ok === false ? <AlertTriangle className={`h-3.5 w-3.5 shrink-0 ${c.severity === "critical" ? "text-red-600" : c.severity === "warn" ? "text-amber-600" : "text-muted-foreground"}`} />
              : <span className="inline-block h-3.5 w-3.5 text-center text-xs leading-none text-muted-foreground shrink-0">?</span>;
            return (
              <div key={c.label} className="flex items-start gap-1.5 text-xs">
                <span className="mt-0.5">{icon}</span>
                <span className={c.ok === false && c.severity !== "info" ? "font-medium" : ""}>{c.label}</span>
                <span className="text-muted-foreground">{c.detail}</span>
              </div>
            );
          })}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {a.enabled === null
          ? `Access logs: ${a.error ?? "not readable"}`
          : !a.enabled
            ? "Access logs: off. Per-request records of who fetched which file are not being kept."
            : a.error
              ? `Access logs: on, to ${a.targetBucket}/${a.targetPrefix}, but the log bucket is ${a.error}`
              : `Access logs: on, to ${a.targetBucket}/${a.targetPrefix} · newest ${ago(a.newestLogAt)} · ${num(a.logObjects24h)} file(s) in 24h`}
      </p>
    </div>
  );
}
