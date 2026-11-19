"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, Download, FileVideo, Loader2, Presentation, RefreshCw, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  PRESENTATION_ACCEPT,
  PRESENTATION_MAX_BYTES,
  PRESENTATION_MAX_FILES_PER_TALK,
  PRESENTATION_TYPES_TEXT,
  formatPresentationSize,
  presentationFileProblem,
  type PresentationSlot,
  type PresentationView,
} from "@/lib/speaker-presentations";

/**
 * A speaker's presentations, up to three files per talk (Nov 19, 2026;
 * docs/SPEAKER_PRESENTATIONS_PLAN.md). ONE component for both doors: the
 * speaker's own form link and the staff's speaker page. `apiBase` is the
 * door; the flow is the same on each:
 *
 *   1. ask the server to allow the upload (type, size, the talk),
 *   2. send the file where it says: straight to storage by a signed form, or
 *      on a development server to the door's own file route,
 *   3. tell the server it has arrived, which is when it is checked.
 */

type UploadTarget = { via: "s3"; url: string; fields: Record<string, string> } | { via: "app"; url: string };

interface Props {
  /** `/api/events/{id}/speakers/{id}/presentations`, or the speaker form's `.../presentations`. */
  apiBase: string;
  canUpload: boolean;
  /**
   * Staff door: says who uploaded a file, and may remove any. On the
   * speaker's own door a file staff uploaded can be replaced, not removed.
   */
  staff?: boolean;
  /** Staff holding the files permission: the download link. Never the speaker. */
  canDownload?: boolean;
  /** Told after a file is received or removed (the staff page refreshes its counts). */
  onChange?: () => void;
  /**
   * The card or section around the list. Given as a function so that where
   * presentations are switched off on this deployment NOTHING renders, not an
   * empty card with a title.
   */
  shell: (content: ReactNode) => ReactNode;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const json = await res.json().catch(() => null);
  return (json as { error?: string } | null)?.error ?? fallback;
}

/** POST a form with a progress callback. `fetch` cannot report upload progress. */
function sendForm(url: string, form: FormData, onProgress: (fraction: number) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => resolve(xhr.status);
    // A dropped connection, or storage that cannot be reached at all.
    xhr.onerror = () => reject(new Error("The upload did not go through. Check your connection and try again; if it keeps failing, contact the organisers."));
    xhr.send(form);
  });
}

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function PresentationUploads({ apiBase, canUpload, staff = false, canDownload = false, onChange, shell }: Props) {
  const [slots, setSlots] = useState<PresentationSlot[]>([]);
  const [files, setFiles] = useState<PresentationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ slotKey: string; fraction: number; stage: "sending" | "checking" } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // What the file chooser is for: the talk, and the file being replaced (none: add one).
  const pending = useRef<{ slotKey: string; replaces: string | null } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(apiBase);
      if (!res.ok) {
        setLoadError(await readError(res, "The presentations could not be loaded."));
        return;
      }
      const json = (await res.json()) as { enabled: boolean; slots: PresentationSlot[]; presentations: PresentationView[] };
      setEnabled(json.enabled);
      setSlots(json.slots);
      setFiles(json.presentations);
      setLoadError(null);
    } catch (err) {
      console.error("[presentations] load failed", err);
      setLoadError("The presentations could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    void load();
  }, [load]);

  // Leaving mid-upload loses it: the browser asks first.
  const uploading = busy !== null;
  useEffect(() => {
    if (!uploading) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploading]);

  const upload = async (slotKey: string, replaces: string | null, file: File) => {
    const problem = presentationFileProblem(file.name, file.size);
    if (problem) {
      toast.error(problem.message);
      return;
    }
    setBusy({ slotKey, fraction: 0, stage: "sending" });
    // Set once the server has allowed the upload, cleared once it is received:
    // anything in between that fails is told to the server, so the try stops
    // holding the speaker's quota.
    let startedId: string | null = null;
    try {
      const start = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slotKey, filename: file.name, size: file.size, ...(replaces ? { replaces } : {}) }),
      });
      if (!start.ok) {
        toast.error(await readError(start, "The upload could not be started."));
        return;
      }
      const { presentationId, upload: target, contentType } = (await start.json()) as {
        presentationId: string;
        upload: UploadTarget;
        contentType: string;
      };
      startedId = presentationId;

      const form = new FormData();
      if (target.via === "s3") {
        // The signed fields first and the file LAST: the storage service
        // ignores every field after the file. The type is the server's, which
        // is what the signature covers.
        for (const [name, value] of Object.entries(target.fields)) form.append(name, value);
        form.append("file", new File([file], file.name, { type: contentType }));
      } else {
        form.append("file", file);
      }
      const status = await sendForm(target.url, form, (fraction) => setBusy({ slotKey, fraction, stage: "sending" }));
      if (status < 200 || status >= 300) {
        console.error("[presentations] storage refused the upload", status);
        toast.error("The upload was refused. Check the file type and size, then try again.");
        return;
      }

      setBusy({ slotKey, fraction: 1, stage: "checking" });
      const done = await fetch(`${apiBase}/${presentationId}/complete`, { method: "POST" });
      if (!done.ok) {
        // A server error is not a refusal: the file has arrived, so it is
        // not abandoned (that would remove it); it is cleared in time if the
        // upload is not tried again.
        if (done.status >= 500) startedId = null;
        toast.error(await readError(done, "The file could not be checked. Please try again."));
        return;
      }
      startedId = null;
      toast.success("Presentation received");
      await load();
      onChange?.();
    } catch (err) {
      console.error("[presentations] upload failed", err);
      toast.error(err instanceof Error ? err.message : "The upload failed. Please try again.");
    } finally {
      if (startedId) {
        // Best effort: the server clears an unfinished upload itself in time.
        fetch(`${apiBase}/${startedId}?abandon=1`, { method: "DELETE" }).catch((err) => console.error("[presentations] abandon failed", err));
      }
      setBusy(null);
    }
  };

  const remove = async (file: PresentationView) => {
    if (!window.confirm(`Remove "${file.filename}"? This cannot be undone.`)) return;
    setRemoving(file.id);
    try {
      const res = await fetch(`${apiBase}/${file.id}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error(await readError(res, "The file could not be removed."));
        return;
      }
      toast.success("Presentation removed");
      await load();
      onChange?.();
    } catch (err) {
      console.error("[presentations] remove failed", err);
      toast.error("The file could not be removed.");
    } finally {
      setRemoving(null);
    }
  };

  const pick = (slotKey: string, replaces: string | null = null) => {
    pending.current = { slotKey, replaces };
    inputRef.current?.click();
  };

  // Nothing at all while loading (no flash of a card that then disappears)
  // or where presentations are switched off on this deployment.
  if (loading || !enabled) return null;
  if (loadError) {
    return shell(
      <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
        <p className="text-sm text-destructive">{loadError}</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          Try again
        </Button>
      </div>,
    );
  }

  const slotKeys = new Set(slots.map((s) => s.key));
  // A file not tied to a talk on the agenda now (the talk was removed, or it
  // was sent before the speaker had one): still shown, never lost.
  const orphans = files.filter((f) => !slotKeys.has(f.slotKey));

  const iconButton = "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md disabled:opacity-50";
  const fileRow = (file: PresentationView, slotKey: string | null) => (
    <div className="flex items-start gap-1 text-sm">
      {file.kind === "video" ? (
        <FileVideo className="mt-0.5 mr-1 h-4 w-4 shrink-0 text-muted-foreground" />
      ) : (
        <Presentation className="mt-0.5 mr-1 h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block break-words font-medium">{file.filename}</span>
        <span className="block text-xs text-muted-foreground">
          {formatPresentationSize(file.size)} · received {formatWhen(file.readyAt)}
          {staff && file.uploadedVia === "staff" ? " · uploaded by staff" : ""}
        </span>
      </span>
      {canDownload && (
        <a
          href={`${apiBase}/${file.id}`}
          className={`${iconButton} text-muted-foreground hover:bg-muted hover:text-foreground`}
          title={`Download ${file.filename}`}
          aria-label={`Download ${file.filename}`}
        >
          <Download className="h-4 w-4" />
        </a>
      )}
      {canUpload && slotKey && (
        <button
          type="button"
          className={`${iconButton} text-muted-foreground hover:bg-muted hover:text-foreground`}
          title={`Replace ${file.filename}`}
          aria-label={`Replace ${file.filename}`}
          disabled={busy !== null || removing !== null}
          onClick={() => pick(slotKey, file.id)}
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      )}
      {canUpload && (staff || file.uploadedVia === "speaker-form") && (
        <button
          type="button"
          className={`${iconButton} ml-1 text-destructive hover:bg-destructive/10`}
          title={`Remove ${file.filename}`}
          aria-label={`Remove ${file.filename}`}
          disabled={removing !== null || busy !== null}
          onClick={() => void remove(file)}
        >
          {removing === file.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        </button>
      )}
    </div>
  );

  return shell(
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        accept={PRESENTATION_ACCEPT}
        className="hidden"
        aria-label="Choose a presentation file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          const target = pending.current;
          e.target.value = "";
          if (file && target) void upload(target.slotKey, target.replaces, file);
        }}
      />
      <ul className="space-y-3">
        {slots.map((slot) => {
          const current = files.filter((f) => f.slotKey === slot.key);
          const working = busy?.slotKey === slot.key ? busy : null;
          const room = current.length < PRESENTATION_MAX_FILES_PER_TALK;
          return (
            <li key={slot.key} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{slot.title}</p>
                  {slot.sessionName && slot.sessionName !== slot.title && (
                    <p className="text-xs text-muted-foreground">
                      {slot.sessionName}
                      {slot.startTime ? ` · ${formatWhen(slot.startTime)}` : ""}
                    </p>
                  )}
                  {slot.sessionName === slot.title && slot.startTime && (
                    <p className="text-xs text-muted-foreground">{formatWhen(slot.startTime)}</p>
                  )}
                </div>
                {current.length > 0 ? (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Received
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">Not received yet</span>
                )}
              </div>

              {current.length > 0 && (
                <ul className="mt-2 space-y-2">
                  {current.map((f) => (
                    <li key={f.id}>{fileRow(f, slot.key)}</li>
                  ))}
                </ul>
              )}

              {working ? (
                <div className="mt-3">
                  <div
                    className="h-2 w-full overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-label={`Uploading for ${slot.title}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(working.fraction * 100)}
                  >
                    <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.round(working.fraction * 100)}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {working.stage === "checking" ? "Checking the file…" : `Uploading… ${Math.round(working.fraction * 100)}%. Keep this page open.`}
                  </p>
                </div>
              ) : (
                canUpload &&
                (room ? (
                  <Button type="button" variant="outline" size="sm" className="mt-3" disabled={busy !== null} onClick={() => pick(slot.key)}>
                    <Upload className="mr-2 h-4 w-4" />
                    {current.length > 0 ? "Add another file" : "Upload file"}
                  </Button>
                ) : (
                  <p className="mt-3 text-xs text-muted-foreground">
                    This talk has its {PRESENTATION_MAX_FILES_PER_TALK} files. Replace or remove one to send another.
                  </p>
                ))
              )}
            </li>
          );
        })}
      </ul>

      {orphans.length > 0 && (
        <div className="rounded-lg border border-dashed p-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Other files</p>
          <div className="space-y-2">{orphans.map((f) => <div key={f.id}>{fileRow(f, null)}</div>)}</div>
        </div>
      )}

      {canUpload && (
        <p className="text-xs text-muted-foreground">
          {PRESENTATION_TYPES_TEXT}. Slides up to {formatPresentationSize(PRESENTATION_MAX_BYTES.slides)}, a video up to{" "}
          {formatPresentationSize(PRESENTATION_MAX_BYTES.video)}. Up to {PRESENTATION_MAX_FILES_PER_TALK} files for each talk.
        </p>
      )}
    </div>,
  );
}
