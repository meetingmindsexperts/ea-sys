"use client";

/**
 * /admin/backups: a window onto the Singapore DR bucket without the AWS
 * console. The last three days of each stream: the hourly database dumps
 * (downloadable, every download audited), the uploads mirror (list only) and
 * the daily env snapshots (list only: they hold every secret), under a
 * freshness strip for the three streams. "Build archive" asks the worker to
 * zip the WHOLE uploads mirror into the bucket; the finished zip is
 * downloadable here for seven days, audited like a dump. It is deliberately
 * NOT a lever: there is no restore button. A restore is a runbook run by a
 * person on a scratch database.
 *
 * The gate here is UX; /api/admin/backups re-checks the operator boundary
 * server-side and is the authority.
 */

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Archive, DatabaseBackup, Download, Loader2, Lock, RefreshCw, ShieldAlert, BookOpen } from "lucide-react";
import { toast } from "sonner";
import { formatFileSize } from "@/lib/utils";

interface BackupObject {
  key: string;
  sizeBytes: number;
  lastModified: string;
}
interface Listing {
  status: "ok" | "error" | "unconfigured" | "operator-only";
  error?: string;
  bucket: string;
  prefix: string;
  windowHours: number;
  objects: BackupObject[];
  totalObjects: number;
  truncated: boolean;
}
interface HealthRow {
  label: string;
  prefix: string;
  latestAt: string | null;
  ageHours: number | null;
  staleAfterHours: number;
  stale: boolean;
  objectCount: number;
  listingTruncated: boolean;
}
interface Snapshot {
  bucket: string;
  windowHours: number;
  health: { status: string; error?: string; rows: HealthRow[] };
  db: Listing;
  uploads: Listing;
  env: Listing;
}
interface ArchiveRow {
  id: string;
  status: "PENDING" | "RUNNING" | "DONE" | "FAILED" | "EXPIRED";
  key: string | null;
  fileCount: number | null;
  sizeBytes: number | null;
  error: string | null;
  requestedByEmail: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
interface ArchivesResponse {
  archives: ArchiveRow[];
  active: ArchiveRow | null;
  ttlDays: number;
}
/** What the confirm dialog is about to mint a link for. */
type PendingDownload = { obj: BackupObject; kind: "dump" | "archive" };

function takenLabel(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Asia/Dubai",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ageLabel(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function ageHoursLabel(h: number | null): string {
  if (h === null) return "never";
  if (h < 1) return `${Math.round(h * 60)}m ago`;
  if (h < 48) return `${h.toFixed(1)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** The part of the key after the stream prefix, so an upload reads as its stored path. */
function displayName(key: string, prefix: string): string {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

function fileName(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

export default function BackupsPage() {
  const { data: session, status } = useSession();
  const isSuperAdmin = session?.user?.role === "SUPER_ADMIN";

  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingDownload | null>(null);
  const [minting, setMinting] = useState(false);
  const [archives, setArchives] = useState<ArchivesResponse | null>(null);
  const [archivesError, setArchivesError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/admin/backups");
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `Listing failed (${res.status})`);
      setSnap(body as Snapshot);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not load the backups";
      console.error("admin-backups: load failed", err);
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadArchives = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/backups/mirror-archive");
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `Archive list failed (${res.status})`);
      setArchives(body as ArchivesResponse);
      setArchivesError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not load the archives";
      console.error("admin-backups: archives load failed", err);
      setArchivesError(message);
    }
  }, []);

  useEffect(() => {
    if (status === "authenticated" && isSuperAdmin) {
      void load();
      void loadArchives();
    }
  }, [status, isSuperAdmin, load, loadArchives]);

  // While a build is queued or running, poll so the row flips to DONE (with
  // its Download) without a manual refresh. A build takes a few minutes.
  const buildActive = !!archives?.active;
  useEffect(() => {
    if (!buildActive) return;
    const t = setInterval(() => void loadArchives(), 10_000);
    return () => clearInterval(t);
  }, [buildActive, loadArchives]);

  const requestArchive = useCallback(async () => {
    setRequesting(true);
    try {
      const res = await fetch("/api/admin/backups/mirror-archive", { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `Request refused (${res.status})`);
      toast.success("Archive requested. The worker starts within three minutes; this page updates as it builds.");
      await loadArchives();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not request the archive";
      console.error("admin-backups: archive request failed", err);
      toast.error(message);
    } finally {
      setRequesting(false);
    }
  }, [loadArchives]);

  const download = useCallback(async (obj: BackupObject) => {
    setMinting(true);
    try {
      const res = await fetch("/api/admin/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: obj.key }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `Download link refused (${res.status})`);
      // A presigned attachment URL: the browser saves the file without leaving
      // the page. Recorded in the audit trail server-side before this returns.
      window.location.assign(body.url as string);
      toast.success(
        `Downloading ${fileName(obj.key)}. The link is valid for ${Math.round((body.expiresInSeconds as number) / 60)} minutes and this download was recorded.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not create the download link";
      console.error("admin-backups: download failed", err);
      toast.error(message);
    } finally {
      setMinting(false);
      setPending(null);
    }
  }, []);

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center mt-20 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading…
      </div>
    );
  }

  if (!session?.user || !isSuperAdmin) {
    return (
      <div className="max-w-md mx-auto mt-20 rounded-lg border border-amber-300 bg-amber-50 p-6 text-center">
        <Lock className="h-8 w-8 mx-auto text-amber-700 mb-3" />
        <h2 className="font-semibold text-amber-900">Super admin only</h2>
        <p className="text-sm text-amber-800 mt-2">
          A database dump is the whole production database, so the backups page is
          restricted to super admins.
        </p>
      </div>
    );
  }

  const days = snap ? Math.round(snap.windowHours / 24) : 3;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <DatabaseBackup className="h-6 w-6 text-primary" />
            Backups
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            The last {days} days in the Singapore disaster-recovery bucket
            {snap?.bucket ? ` (${snap.bucket})` : ""}: hourly database dumps, the hourly uploads
            mirror, and the daily env snapshots. Older objects stay in the bucket (dumps for 30
            days) and are reachable through the runbook.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/docs/infra/dr/README.md">
              <BookOpen className="h-4 w-4 mr-1.5" />
              Restore runbook
            </Link>
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-4 text-sm text-amber-900 flex gap-3">
        <ShieldAlert className="h-5 w-5 shrink-0 text-amber-700 mt-0.5" />
        <div>
          A dump is the entire production database. Every download is recorded in the audit trail
          with who, when and which file, and the link expires after five minutes. There is no restore
          here on purpose: restoring is a runbook step on a scratch database, never a button.
        </div>
      </div>

      {loadError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{loadError}</div>
      )}

      {snap && <HealthStrip health={snap.health} />}

      <section className="rounded-lg border bg-card">
        <SectionHeader title="Database dumps" listing={snap?.db ?? null} />
        <ListingTable
          listing={snap?.db ?? null}
          loading={loading}
          emptyText={`No dumps in the last ${days} days. The hourly cron may have stopped; check Infra / Ops.`}
          action={(obj) => (
            <Button size="sm" variant="outline" onClick={() => setPending({ obj, kind: "dump" })} disabled={minting}>
              <Download className="h-4 w-4 mr-1.5" />
              Download
            </Button>
          )}
        />
      </section>

      <section className="rounded-lg border bg-card">
        <SectionHeader title="Uploads mirror" listing={snap?.uploads ?? null} badge="list only" />
        <p className="px-4 pt-3 text-xs text-muted-foreground">
          Files the hourly mirror wrote to Singapore in the last {days} days: photos, banners,
          certificates and private documents as they were uploaded or changed. Recovering one is a
          runbook step (Surgical recovery, C and D).
        </p>
        <ListingTable
          listing={snap?.uploads ?? null}
          loading={loading}
          emptyText={`Nothing was uploaded or changed in the last ${days} days, so the mirror had nothing new to write. Its freshness is in the strip above.`}
          showPath
        />
      </section>

      <section className="rounded-lg border bg-card">
        <div className="px-4 py-3 border-b flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Archive className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-semibold">Mirror archive</h2>
          </div>
          <Button size="sm" onClick={() => void requestArchive()} disabled={requesting || buildActive}>
            {requesting || buildActive ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Archive className="h-4 w-4 mr-1.5" />}
            {buildActive ? (archives?.active?.status === "RUNNING" ? "Building…" : "Queued…") : "Build archive"}
          </Button>
        </div>
        <p className="px-4 pt-3 text-xs text-muted-foreground">
          One zip of the whole uploads mirror (every file, not just the last {days} days), built by
          the worker and kept for {archives?.ttlDays ?? 7} days. A build takes a few minutes; the
          Download appears here when it is done, and each download is recorded like a dump.
        </p>
        {archivesError && <div className="px-4 pt-3 text-sm text-red-800">{archivesError}</div>}
        <ArchivesTable
          archives={archives}
          onDownload={(row) =>
            row.key &&
            setPending({
              obj: { key: row.key, sizeBytes: row.sizeBytes ?? 0, lastModified: row.finishedAt ?? row.createdAt },
              kind: "archive",
            })
          }
          disabled={minting}
        />
      </section>

      <section className="rounded-lg border bg-card">
        <SectionHeader title="Env snapshots" listing={snap?.env ?? null} badge="list only" />
        <p className="px-4 pt-3 text-xs text-muted-foreground">
          These hold every secret the platform runs on, so they are listed here but never downloadable
          from a web page. Recovery goes through the runbook on the box.
        </p>
        <ListingTable listing={snap?.env ?? null} loading={loading} emptyText={`No env snapshots in the last ${days} days.`} />
      </section>

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && !minting && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.kind === "archive" ? "Download the mirror archive?" : "Download this database dump?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending
                ? `${fileName(pending.obj.key)} (${formatFileSize(pending.obj.sizeBytes)}, ${pending.kind === "archive" ? "built" : "taken"} ${takenLabel(pending.obj.lastModified)} GST). `
                : ""}
              {pending?.kind === "archive"
                ? "It contains every uploaded file on the platform, private documents included."
                : "It contains every registration, payment and person on the platform."}{" "}
              The download is recorded in the audit trail under your name, and the link expires in five
              minutes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={minting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={minting}
              onClick={(e) => {
                e.preventDefault();
                if (pending) void download(pending.obj);
              }}
            >
              {minting ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Download className="h-4 w-4 mr-1.5" />}
              Download
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const ARCHIVE_STATUS_CLASS: Record<ArchiveRow["status"], string> = {
  PENDING: "bg-slate-50 text-slate-700 border-slate-200",
  RUNNING: "bg-sky-50 text-sky-700 border-sky-200",
  DONE: "bg-emerald-50 text-emerald-700 border-emerald-200",
  FAILED: "bg-red-50 text-red-700 border-red-200",
  EXPIRED: "bg-slate-50 text-slate-500 border-slate-200",
};

function ArchivesTable({
  archives,
  onDownload,
  disabled,
}: {
  archives: ArchivesResponse | null;
  onDownload: (row: ArchiveRow) => void;
  disabled: boolean;
}) {
  if (!archives) return null;
  if (archives.archives.length === 0) {
    return <div className="p-6 text-sm text-muted-foreground">No archive has been built yet.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs uppercase tracking-wide text-muted-foreground">
          <tr className="border-b">
            <th className="text-left font-medium px-4 py-2">Requested (GST)</th>
            <th className="text-left font-medium px-4 py-2">Status</th>
            <th className="text-right font-medium px-4 py-2">Files</th>
            <th className="text-right font-medium px-4 py-2">Size</th>
            <th className="text-left font-medium px-4 py-2">Expires</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          {archives.archives.map((row) => {
            const expiresAt = row.finishedAt ? new Date(new Date(row.finishedAt).getTime() + archives.ttlDays * 86_400_000) : null;
            return (
              <tr key={row.id} className="border-b last:border-b-0 align-top">
                <td className="px-4 py-2 whitespace-nowrap">
                  {takenLabel(row.createdAt)}
                  {row.requestedByEmail && <div className="text-xs text-muted-foreground">{row.requestedByEmail}</div>}
                </td>
                <td className="px-4 py-2">
                  <Badge variant="outline" className={ARCHIVE_STATUS_CLASS[row.status]}>
                    {row.status.toLowerCase()}
                  </Badge>
                  {row.status === "RUNNING" && row.startedAt && (
                    <div className="text-xs text-muted-foreground mt-1">started {ageLabel(row.startedAt)}</div>
                  )}
                  {row.status === "FAILED" && row.error && (
                    <div className="text-xs text-red-700 mt-1 max-w-md">{row.error}</div>
                  )}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{row.fileCount ?? "-"}</td>
                <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">
                  {row.sizeBytes != null ? formatFileSize(row.sizeBytes) : "-"}
                </td>
                <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">
                  {row.status === "DONE" && expiresAt ? takenLabel(expiresAt.toISOString()) : "-"}
                </td>
                <td className="px-4 py-2 text-right">
                  {row.status === "DONE" && row.key && (
                    <Button size="sm" variant="outline" onClick={() => onDownload(row)} disabled={disabled}>
                      <Download className="h-4 w-4 mr-1.5" />
                      Download
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Freshness of the three Singapore streams, the same rows the Infra / Ops DR card reads. */
function HealthStrip({ health }: { health: Snapshot["health"] }) {
  if (health.status !== "ok") {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
        Could not read the streams&apos; freshness: {health.error ?? health.status}
      </div>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {health.rows.map((row) => (
        <div key={row.prefix} className="rounded-lg border bg-card px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{row.label}</span>
            <Badge
              variant="outline"
              className={row.stale ? "bg-red-50 text-red-700 border-red-200" : "bg-emerald-50 text-emerald-700 border-emerald-200"}
            >
              {row.stale ? "stale" : "fresh"}
            </Badge>
          </div>
          <div className="mt-1 text-sm tabular-nums">
            Last written {ageHoursLabel(row.ageHours)}
            {row.latestAt ? <span className="text-muted-foreground"> ({takenLabel(row.latestAt)} GST)</span> : null}
          </div>
          <div className="text-xs text-muted-foreground">
            {row.objectCount.toLocaleString()} object{row.objectCount === 1 ? "" : "s"} in {row.prefix}
            {row.listingTruncated ? " (at least)" : ""}, alarm past {row.staleAfterHours}h
          </div>
        </div>
      ))}
    </div>
  );
}

function SectionHeader({ title, listing, badge }: { title: string; listing: Listing | null; badge?: string }) {
  return (
    <div className="px-4 py-3 border-b flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">{title}</h2>
        {badge && (
          <Badge variant="outline" className="text-xs">
            {badge}
          </Badge>
        )}
      </div>
      {listing && listing.status === "ok" && (
        <span className="text-xs text-muted-foreground">
          {listing.objects.length} of {listing.totalObjects.toLocaleString()} file{listing.totalObjects === 1 ? "" : "s"} in the
          last {Math.round(listing.windowHours / 24)} days
          {listing.truncated ? " (listing capped)" : ""}
        </span>
      )}
    </div>
  );
}

function ListingTable({
  listing,
  loading,
  emptyText,
  showPath,
  action,
}: {
  listing: Listing | null;
  loading: boolean;
  emptyText: string;
  /** Show the key relative to the prefix (uploads carry a meaningful path); else the file name. */
  showPath?: boolean;
  action?: (obj: BackupObject) => React.ReactNode;
}) {
  if (!listing && loading) {
    return (
      <div className="p-6 text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Reading the bucket…
      </div>
    );
  }
  if (!listing) return null;
  if (listing.status !== "ok") {
    return (
      <div className="p-4 text-sm text-red-800">
        Could not list {listing.prefix}: {listing.error ?? listing.status}
      </div>
    );
  }
  if (listing.objects.length === 0) {
    return <div className="p-6 text-sm text-muted-foreground">{emptyText}</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs uppercase tracking-wide text-muted-foreground">
          <tr className="border-b">
            <th className="text-left font-medium px-4 py-2">File</th>
            <th className="text-left font-medium px-4 py-2">Written (GST)</th>
            <th className="text-left font-medium px-4 py-2">Age</th>
            <th className="text-right font-medium px-4 py-2">Size</th>
            {action && <th className="px-4 py-2" />}
          </tr>
        </thead>
        <tbody>
          {listing.objects.map((obj) => (
            <tr key={obj.key} className="border-b last:border-b-0">
              <td className="px-4 py-2 font-mono text-xs break-all">
                {showPath ? displayName(obj.key, listing.prefix) : fileName(obj.key)}
              </td>
              <td className="px-4 py-2 whitespace-nowrap">{takenLabel(obj.lastModified)}</td>
              <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">{ageLabel(obj.lastModified)}</td>
              <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">{formatFileSize(obj.sizeBytes)}</td>
              {action && <td className="px-4 py-2 text-right">{action(obj)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
