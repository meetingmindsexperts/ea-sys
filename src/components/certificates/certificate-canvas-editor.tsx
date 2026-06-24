"use client";

/**
 * Drag-and-drop canvas editor for the v3 PDF-overlay certificate template
 * (Commit 3 of the 2026-06-02 architecture flip).
 *
 * What it does:
 *   1. Rasterizes page 1 of the uploaded background PDF into a <canvas>
 *      using pdfjs-dist (self-hosted worker at /pdfjs/pdf.worker.min.mjs).
 *   2. Overlays draggable + resizable text boxes positioned in pdf-lib
 *      points (1pt = 1/72") relative to the page's PDF dimensions.
 *      Editor display scale converts pixels↔points so the same coords
 *      land identically on the server-side pdf-lib renderer.
 *   3. Side panel for the selected box: content (with token inserter),
 *      font, size, color, alignment, plus a delete button.
 *   4. Toolbar: upload/replace PDF + add box + token reference.
 *
 * Coordinate contract — matches src/lib/certificates/types.ts +
 * src/lib/certificates/render.ts:
 *   - Stored coords are in pdf-lib points, origin TOP-LEFT (browser DOM
 *     convention; renderer converts to bottom-left at draw time).
 *   - The editor's display canvas is a CSS-scaled version of the PDF
 *     page; we keep `displayScale = canvasWidthPx / pageWidthPt`.
 *
 * Why pdfjs-dist for rasterization rather than pdf-lib:
 *   pdf-lib doesn't render — it only edits. pdfjs-dist is Mozilla's
 *   in-browser PDF renderer, ships a Web Worker for the heavy lifting,
 *   and lets us paint the page on a <canvas>. Self-hosted worker at
 *   /pdfjs/pdf.worker.min.mjs avoids the third-party CDN load.
 *
 * Save model — uncontrolled-with-onChange. The parent owns the
 * authoritative boxes array and the backgroundPdfUrl; this component
 * emits onChange on every mutation. Save / dirty tracking lives in the
 * certificates page.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Rnd } from "react-rnd";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Upload,
  Plus,
  Trash2,
  Copy,
  Info,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignHorizontalJustifyCenter,
  AlignVerticalJustifyCenter,
  Crosshair,
  Loader2,
  Undo2,
  Redo2,
} from "lucide-react";
import { toast } from "sonner";

// ── Types — mirror src/lib/certificates/types.ts ─────────────────────────────

export type CertificateFontName =
  | "Helvetica" | "Helvetica-Bold" | "Helvetica-Oblique" | "Helvetica-BoldOblique"
  | "Times-Roman" | "Times-Bold" | "Times-Italic" | "Times-BoldItalic"
  | "Courier" | "Courier-Bold" | "Courier-Oblique" | "Courier-BoldOblique";

export type TextBoxAlign = "left" | "center" | "right";

export interface CertificateTextBox {
  id: string;
  content: string;
  x: number;       // pdf-lib points, top-left origin
  y: number;
  width: number;
  height: number;
  font: CertificateFontName;
  size: number;    // points
  color: string;   // hex
  align: TextBoxAlign;
}

const FONTS: CertificateFontName[] = [
  "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
  "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic",
  "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique",
];

const AVAILABLE_TOKENS: Array<{ token: string; description: string }> = [
  { token: "{{recipientName}}", description: "Full attendee/speaker name (with title prefix)" },
  { token: "{{eventName}}", description: "Event name" },
  { token: "{{eventDateRange}}", description: "Event date range (e.g. 5th - 7th December 2025)" },
  { token: "{{venueLine}}", description: "Venue + city + country, prefixed with 'at'" },
  { token: "{{accreditationBody}}", description: "Accreditor's friendly name (e.g. DHA)" },
  { token: "{{accreditationReference}}", description: "Accreditor's reference number" },
  { token: "{{cmeHours}}", description: "CME hours awarded" },
];

// Display canvas width — wider than the page so the operator can drop
// boxes in the margin and slide them in. The browser scales pixels via
// `displayScale = canvasWidthPx / pageWidthPt`.
const CANVAS_DISPLAY_WIDTH_PX = 800;

// Alignment rulers (top + left edges of the canvas). Thickness in px; tick
// cadence in pdf-lib points. A minor tick every 10pt; a labeled major tick
// every 50pt — readable without crowding at A4/Letter sizes.
const RULER_SIZE_PX = 22;
const RULER_MINOR_PT = 10;
const RULER_MAJOR_PT = 50;
// Guide line colour — magenta, deliberately distinct from the cerulean
// selection outline so the page-center guides read as a separate aid.
const GUIDE_COLOR = "rgba(217, 70, 160, 0.65)";

// Generate a stable id for a new text box. crypto.randomUUID is fine
// here — runs in modern browsers, no fallback needed.
function newBoxId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `box-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Tick marks for a ruler spanning `lengthPt` points: one every RULER_MINOR_PT,
// flagged `major` (longer + labeled) at RULER_MAJOR_PT multiples.
function rulerTicks(lengthPt: number): Array<{ pt: number; major: boolean }> {
  const ticks: Array<{ pt: number; major: boolean }> = [];
  for (let pt = 0; pt <= lengthPt + 0.5; pt += RULER_MINOR_PT) {
    ticks.push({ pt, major: Math.round(pt) % RULER_MAJOR_PT === 0 });
  }
  return ticks;
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface CertificateCanvasEditorProps {
  /** The uploaded background PDF URL (`/uploads/...` or `/certificates/...`),
   *  or null if the slot has none yet (the upload widget shows). */
  backgroundPdfUrl: string | null;
  /** Current text boxes — controlled, parent owns the array. */
  textBoxes: CertificateTextBox[];
  /** Required for the upload route — verifies the user belongs to this
   *  event's org before writing to the filesystem. */
  eventId: string;
  /** Emitted on any mutation: drag, resize, content edit, add, delete. */
  onChange: (next: {
    backgroundPdfUrl?: string | null;
    textBoxes?: CertificateTextBox[];
  }) => void;
}

export function CertificateCanvasEditor({
  backgroundPdfUrl,
  textBoxes,
  eventId,
  onChange,
}: CertificateCanvasEditorProps) {
  // PDF page dimensions in pdf-lib points — set after rasterization.
  // Default to A4 portrait so the empty-state UI has stable dimensions
  // (the canvas isn't drawn until the PDF loads anyway).
  const [pageWidthPt, setPageWidthPt] = useState(595);
  const [pageHeightPt, setPageHeightPt] = useState(842);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Dashed page-center guide lines (horizontal + vertical). Default on — the
  // common cert alignment need is centering names/titles on the page.
  const [showGuides, setShowGuides] = useState(true);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Display scale: canvas pixels per pdf-lib point. Used to convert
  // react-rnd's pixel-space drag/resize back to point-space storage.
  const displayScale = CANVAS_DISPLAY_WIDTH_PX / pageWidthPt;
  const canvasHeightPx = pageHeightPt * displayScale;

  // ── Rasterize the background PDF whenever the URL changes ──────────────
  useEffect(() => {
    if (!backgroundPdfUrl) return;
    let cancelled = false;
    setPdfLoading(true);
    setPdfError(null);

    (async () => {
      try {
        // pdfjs-dist is browser-only; dynamic-import keeps it out of
        // the SSR bundle. Worker is self-hosted at /pdfjs/.
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";

        const loadingTask = pdfjs.getDocument(backgroundPdfUrl);
        const pdf = await loadingTask.promise;
        if (cancelled) return;

        // Single-page support per v1 scope — render page 1.
        const page = await pdf.getPage(1);
        // Default viewport at scale 1.0 gives us the page's native
        // dimensions in points (pdf.js uses CSS pixels at 96 DPI, but
        // viewport.width/height at scale 1 are points × 1).
        const baseViewport = page.getViewport({ scale: 1 });
        const widthPt = baseViewport.width;
        const heightPt = baseViewport.height;
        if (cancelled) return;
        setPageWidthPt(widthPt);
        setPageHeightPt(heightPt);

        // Render at our display scale × devicePixelRatio for crisp output
        // on high-DPI screens. The <canvas> CSS width stays at display
        // pixels; the backing buffer is DPR×.
        const dpr = window.devicePixelRatio || 1;
        const scale = (CANVAS_DISPLAY_WIDTH_PX / widthPt) * dpr;
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${CANVAS_DISPLAY_WIDTH_PX}px`;
        canvas.style.height = `${heightPt * (CANVAS_DISPLAY_WIDTH_PX / widthPt)}px`;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        // pdfjs v4 RenderParameters takes `canvasContext` + `viewport`.
        // The canvas element itself isn't on the type — pdf.js draws via
        // the 2D context we passed.
        await page.render({ canvasContext: ctx, viewport }).promise;
        if (cancelled) return;
        setPdfLoading(false);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setPdfError(msg);
        setPdfLoading(false);
        // Logged for /logs; toast surfaces user-visible failure.
        console.error("[cert-canvas-editor] PDF rasterization failed", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [backgroundPdfUrl]);

  // ── Upload PDF — POSTs to /api/upload/pdf and stores the returned URL
  const handleUpload = useCallback(
    async (file: File) => {
      if (file.size > 10 * 1024 * 1024) {
        toast.error("File too large — max 10MB.");
        return;
      }
      setUploading(true);
      try {
        const form = new FormData();
        form.append("file", file);
        form.append("eventId", eventId);
        const res = await fetch("/api/upload/pdf", { method: "POST", body: form });
        const json = (await res.json().catch(() => ({}))) as {
          url?: string;
          size?: number;
          convertedFrom?: "png" | "jpeg" | null;
          error?: string;
        };
        if (!res.ok || !json.url) {
          const msg = json.error ?? `Upload failed (HTTP ${res.status})`;
          toast.error(msg);
          console.error("[cert-canvas-editor] cert background upload failed", { status: res.status, json });
          return;
        }
        onChange({ backgroundPdfUrl: json.url });
        toast.success(
          json.convertedFrom
            ? `${json.convertedFrom.toUpperCase()} converted and uploaded as PDF background.`
            : "Background PDF uploaded.",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Upload network error: ${msg}`);
        console.error("[cert-canvas-editor] PDF upload network error", err);
      } finally {
        setUploading(false);
      }
    },
    [onChange, eventId],
  );

  // ── Text box mutators ──────────────────────────────────────────────────

  const selectedBox = useMemo(
    () => textBoxes.find((b) => b.id === selectedId) ?? null,
    [textBoxes, selectedId],
  );

  function addBox() {
    pushUndoSnapshot();
    // Drop the new box near the top of the page, centered horizontally.
    // 200pt wide × 32pt tall is a comfortable single-line default at
    // 16pt body text. Coords are top-left origin in pdf-lib points.
    const newBox: CertificateTextBox = {
      id: newBoxId(),
      content: "Sample text",
      x: Math.max(0, pageWidthPt / 2 - 100),
      y: 80,
      width: 200,
      height: 32,
      font: "Helvetica",
      size: 16,
      color: "#1a2e5a",
      align: "center",
    };
    onChange({ textBoxes: [...textBoxes, newBox] });
    setSelectedId(newBox.id);
  }

  function updateBox(id: string, patch: Partial<CertificateTextBox>) {
    onChange({
      textBoxes: textBoxes.map((b) => (b.id === id ? { ...b, ...patch } : b)),
    });
  }

  function deleteBox(id: string) {
    pushUndoSnapshot();
    onChange({ textBoxes: textBoxes.filter((b) => b.id !== id) });
    if (selectedId === id) setSelectedId(null);
  }

  // One-click centering on the page axis. "Center H" puts the box's own centre
  // on the page's vertical centre line; "Center V" on the horizontal one.
  function centerBoxH(id: string) {
    const box = textBoxes.find((b) => b.id === id);
    if (!box) return;
    pushUndoSnapshot();
    updateBox(id, { x: Math.max(0, (pageWidthPt - box.width) / 2) });
  }
  function centerBoxV(id: string) {
    const box = textBoxes.find((b) => b.id === id);
    if (!box) return;
    pushUndoSnapshot();
    updateBox(id, { y: Math.max(0, (pageHeightPt - box.height) / 2) });
  }

  // ── Undo / Redo ───────────────────────────────────────────────────────
  // Commit-point granularity (decided in the operator-feedback planning
  // round): one undo step per drag-end, resize-end, add, delete,
  // duplicate, side-panel input commit, or coalesced arrow-nudge burst.
  // Stack depth capped at 30 — covers every realistic "I just did
  // something wrong, take it back" workflow without unbounded memory.
  //
  // Snapshots store the BEFORE state of textBoxes (i.e., what to
  // restore TO on undo). Redo stack stores AFTER states pushed during
  // an undo operation, so a redo replays the action.
  //
  // textBoxes is a prop, so the snapshot captures the value at the
  // moment of the call — that's why the helpers are called BEFORE the
  // onChange that applies the new value.
  const UNDO_STACK_MAX = 30;
  const [undoStack, setUndoStack] = useState<CertificateTextBox[][]>([]);
  const [redoStack, setRedoStack] = useState<CertificateTextBox[][]>([]);

  const pushUndoSnapshot = useCallback(() => {
    setUndoStack((stack) => {
      const next = [...stack, textBoxes];
      return next.length > UNDO_STACK_MAX ? next.slice(next.length - UNDO_STACK_MAX) : next;
    });
    setRedoStack([]);
  }, [textBoxes]);

  // H3 fix (review round): setState updaters MUST be pure. The earlier
  // shape `setUndoStack(stack => { setRedoStack(...); onChange(...); ... })`
  // mutated other state + called the parent's onChange inside the
  // updater, which React 18+ StrictMode (default in Next 16) double-
  // invokes — so under dev's StrictMode the side effects ran twice
  // per undo, intermittently mis-synchronizing the redo stack and
  // double-applying onChange in the parent. Restructured to: read
  // synchronously → set both stacks → call onChange, all in the same
  // render tick (React batches the two setStates into one re-render).
  const undo = useCallback(() => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack(undoStack.slice(0, -1));
    setRedoStack([...redoStack, textBoxes]);
    onChange({ textBoxes: prev });
  }, [undoStack, redoStack, textBoxes, onChange]);

  const redo = useCallback(() => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack(redoStack.slice(0, -1));
    setUndoStack([...undoStack, textBoxes]);
    onChange({ textBoxes: next });
  }, [undoStack, redoStack, textBoxes, onChange]);

  // Arrow nudge: 1pt per press, Shift+arrow = 10pt. Consecutive presses
  // within 500ms coalesce into a single undo step (holding the key
  // shouldn't burn through 30 snapshots). Y-axis only per the
  // organizer's request — Left/Right intentionally do nothing.
  const lastNudgeAtRef = useRef(0);
  const handleNudgeY = useCallback(
    (direction: -1 | 1, big: boolean) => {
      if (!selectedId) return;
      const box = textBoxes.find((b) => b.id === selectedId);
      if (!box) return;
      const delta = (big ? 10 : 1) * direction;
      const minY = 0;
      const maxY = Math.max(0, pageHeightPt - box.height);
      const newY = Math.max(minY, Math.min(maxY, box.y + delta));
      if (newY === box.y) return; // already at boundary
      const now = Date.now();
      if (now - lastNudgeAtRef.current > 500) {
        // New nudge burst — start a fresh undo step.
        pushUndoSnapshot();
      }
      lastNudgeAtRef.current = now;
      onChange({
        textBoxes: textBoxes.map((b) => (b.id === box.id ? { ...b, y: newY } : b)),
      });
    },
    [selectedId, textBoxes, pageHeightPt, pushUndoSnapshot, onChange],
  );

  // Keyboard handler — attached to the editor wrapper div, so arrow
  // keys / shortcuts only fire when focus is inside the editor (not
  // anywhere else in the dashboard). Bails out if focus is inside a
  // textarea / input so typing in the side panel keeps working.
  const handleEditorKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      const editable = target.isContentEditable;
      const inField = tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" || editable;

      const isMeta = e.metaKey || e.ctrlKey;
      // Cmd/Ctrl+Z = undo. Cmd/Ctrl+Shift+Z OR Cmd/Ctrl+Y = redo.
      // Allow these even in textareas? No — would conflict with the
      // browser's built-in textarea undo. Editor-level undo is for
      // canvas mutations; textarea has its own.
      if (!inField && isMeta && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        undo();
        return;
      }
      if (
        !inField
        && isMeta
        && ((e.shiftKey && (e.key === "z" || e.key === "Z")) || e.key === "y" || e.key === "Y")
      ) {
        e.preventDefault();
        redo();
        return;
      }

      // Arrow nudge — only when a box is selected, focus is on the
      // canvas (not a text input), and there's no meta modifier (so
      // Cmd+ArrowUp browser navigation isn't hijacked).
      if (!inField && !isMeta && selectedId) {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          handleNudgeY(-1, e.shiftKey);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          handleNudgeY(1, e.shiftKey);
        }
      }
    },
    [undo, redo, selectedId, handleNudgeY],
  );

  // Clone the box and offset by +20pt diagonally so the duplicate is
  // visibly separate from the original. The new id is generated so
  // pdf-lib's renderer treats it as a distinct draw call. We also
  // re-select the clone — matches the user's mental model of "I just
  // made this, let me edit it" and is consistent with addBox().
  function duplicateBox(id: string) {
    const src = textBoxes.find((b) => b.id === id);
    if (!src) return;
    pushUndoSnapshot();
    const clone: CertificateTextBox = {
      ...src,
      id: newBoxId(),
      x: Math.min(src.x + 20, Math.max(0, pageWidthPt - src.width)),
      y: Math.min(src.y + 20, Math.max(0, pageHeightPt - src.height)),
    };
    onChange({ textBoxes: [...textBoxes, clone] });
    setSelectedId(clone.id);
  }

  // Insert a token into the selected box's content at the end (cursor
  // position tracking inside Rnd-wrapped Textareas is fiddly; appending
  // is the simple-good-enough UX, organizer can rearrange).
  function insertToken(token: string) {
    if (!selectedBox) return;
    updateBox(selectedBox.id, {
      content: `${selectedBox.content}${selectedBox.content.endsWith(" ") || selectedBox.content === "" ? "" : " "}${token}`,
    });
  }

  // Conversion helpers — pdf-lib points ↔ display pixels.
  const ptToPx = (pt: number) => pt * displayScale;
  const pxToPt = (px: number) => px / displayScale;

  // ── Render ─────────────────────────────────────────────────────────────

  if (!backgroundPdfUrl) {
    // Empty state — upload widget only. The page-level placeholder card
    // wraps this in the "no PDF uploaded" path so this branch is the
    // canvas-editor's own empty-state UI.
    return (
      <div className="space-y-4">
        <div className="rounded-md border-2 border-dashed border-primary/40 bg-primary/5 p-10 text-center">
          <Upload className="h-10 w-10 mx-auto mb-3 text-primary/70" />
          <p className="font-medium mb-2">Upload the certificate background</p>
          <p className="text-sm text-muted-foreground mb-4">
            Your designer&apos;s finished cert visual — banner, borders,
            signatures, footer logos all baked in. We&apos;ll overlay
            text boxes with{" "}
            <code className="bg-background px-1 rounded">{`{{tokens}}`}</code>{" "}
            on top. <strong>PDF, JPG, or PNG</strong> all accepted —
            images get wrapped into a single-page PDF automatically.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,image/jpeg,image/png"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleUpload(f);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          />
          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Upload className="h-4 w-4 mr-1" />
            )}
            {uploading ? "Uploading…" : "Choose file"}
          </Button>
          <p className="text-xs text-muted-foreground mt-3">
            Single page (or single image), max 10MB. Aspect ratio is
            preserved — design at A4 / Letter for the cleanest result.
          </p>
        </div>
      </div>
    );
  }

  return (
    // tabIndex makes the wrapper focusable so arrow keys / Cmd+Z fire
    // even when no input is focused. outline-none keeps the focus ring
    // off the whole editor — react-rnd boxes show their own selected
    // outline, which is the real focus affordance.
    <div
      className="space-y-4 outline-none"
      tabIndex={0}
      onKeyDown={handleEditorKeyDown}
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
        <input
          ref={fileInputRef}
          type="file"
          // Same accept set as the empty-state upload — PDF/JPG/PNG.
          // Images get server-converted to PDF in /api/upload/pdf.
          // Without this, the "Replace background" toolbar button only
          // showed PDFs in the file picker even though the server
          // route accepts all three.
          accept="application/pdf,image/jpeg,image/png"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleUpload(f);
            if (fileInputRef.current) fileInputRef.current.value = "";
          }}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          ) : (
            <Upload className="h-4 w-4 mr-1" />
          )}
          Replace background
        </Button>
        <Button size="sm" onClick={addBox}>
          <Plus className="h-4 w-4 mr-1" />
          Add text box
        </Button>
        {/* Undo / redo — buttons mirror the Cmd/Ctrl+Z + Cmd/Ctrl+Shift+Z
            shortcuts that work on the canvas wrapper. Both disable
            when their stack is empty so the operator gets visual
            feedback that there's nothing to undo/redo. */}
        <Button
          size="sm"
          variant="outline"
          onClick={undo}
          disabled={undoStack.length === 0}
          title="Undo (Cmd/Ctrl+Z)"
        >
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={redo}
          disabled={redoStack.length === 0}
          title="Redo (Cmd/Ctrl+Shift+Z)"
        >
          <Redo2 className="h-4 w-4" />
        </Button>
        {/* Toggle the dashed page-center guide lines. Rulers are always on. */}
        <Button
          size="sm"
          variant={showGuides ? "default" : "outline"}
          onClick={() => setShowGuides((v) => !v)}
          title="Toggle page-center guides"
        >
          <Crosshair className="h-4 w-4" />
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          {textBoxes.length} text {textBoxes.length === 1 ? "box" : "boxes"} ·{" "}
          page {Math.round(pageWidthPt)} × {Math.round(pageHeightPt)} pt
        </span>
      </div>

      {/* Canvas + side panel */}
      <div className="grid gap-4 lg:grid-cols-[auto_320px]">
        {/* Canvas framed by top + left rulers, with text-box overlays */}
        <div className="relative overflow-auto rounded-md border bg-white">
          <div className="relative w-max">
            {/* Top row: corner square + horizontal ruler */}
            <div className="flex">
              <div
                className="shrink-0 border-b border-r bg-muted/30"
                style={{ width: RULER_SIZE_PX, height: RULER_SIZE_PX }}
              />
              <svg
                width={CANVAS_DISPLAY_WIDTH_PX}
                height={RULER_SIZE_PX}
                className="block shrink-0 border-b bg-muted/20 text-slate-500"
                aria-hidden
              >
                {rulerTicks(pageWidthPt).map(({ pt, major }) => {
                  const x = ptToPx(pt);
                  return (
                    <g key={pt}>
                      <line
                        x1={x}
                        x2={x}
                        y1={major ? RULER_SIZE_PX - 9 : RULER_SIZE_PX - 5}
                        y2={RULER_SIZE_PX}
                        stroke="currentColor"
                        strokeOpacity={major ? 0.55 : 0.3}
                      />
                      {major && x < CANVAS_DISPLAY_WIDTH_PX - 16 && (
                        <text x={x + 2} y={9} fontSize={8} fill="currentColor" fillOpacity={0.7}>
                          {Math.round(pt)}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            </div>

            {/* Bottom row: vertical ruler + the canvas */}
            <div className="flex">
              <svg
                width={RULER_SIZE_PX}
                height={canvasHeightPx}
                className="block shrink-0 border-r bg-muted/20 text-slate-500"
                aria-hidden
              >
                {rulerTicks(pageHeightPt).map(({ pt, major }) => {
                  const y = ptToPx(pt);
                  return (
                    <g key={pt}>
                      <line
                        x1={major ? RULER_SIZE_PX - 9 : RULER_SIZE_PX - 5}
                        x2={RULER_SIZE_PX}
                        y1={y}
                        y2={y}
                        stroke="currentColor"
                        strokeOpacity={major ? 0.55 : 0.3}
                      />
                      {major && y > 9 && y < canvasHeightPx - 2 && (
                        <text x={2} y={y - 2} fontSize={8} fill="currentColor" fillOpacity={0.7}>
                          {Math.round(pt)}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>

              {/* Canvas (PDF raster + text-box overlays) */}
              <div
                className="relative shrink-0"
                style={{ width: CANVAS_DISPLAY_WIDTH_PX, height: canvasHeightPx }}
                // Click on empty canvas area deselects.
                onMouseDown={(e) => {
                  if (e.target === e.currentTarget) setSelectedId(null);
                }}
              >
                <canvas ref={canvasRef} className="block" />
                {/* Page-center guides — dashed, magenta, pointer-events:none so
                    they never intercept a drag. Hidden while loading/errored. */}
                {showGuides && !pdfLoading && !pdfError && (
                  <>
                    <div
                      className="pointer-events-none absolute top-0 bottom-0 z-20"
                      style={{ left: ptToPx(pageWidthPt / 2), borderLeft: `1px dashed ${GUIDE_COLOR}` }}
                    />
                    <div
                      className="pointer-events-none absolute left-0 right-0 z-20"
                      style={{ top: ptToPx(pageHeightPt / 2), borderTop: `1px dashed ${GUIDE_COLOR}` }}
                    />
                  </>
                )}
            {pdfLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-white/80">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <span className="ml-2 text-sm">Loading PDF…</span>
              </div>
            )}
            {pdfError && (
              <div className="absolute inset-0 flex items-center justify-center bg-red-50 border-2 border-red-300">
                <div className="text-center p-4">
                  <p className="font-medium text-red-900">Failed to load PDF</p>
                  <p className="text-xs text-red-700 mt-1 break-words">{pdfError}</p>
                  <p className="text-xs text-red-600 mt-2">
                    Try re-uploading. Check that the file is a valid single-page PDF.
                  </p>
                </div>
              </div>
            )}

            {/* Text boxes — react-rnd handles drag + resize */}
            {textBoxes.map((box) => {
              const isSelected = box.id === selectedId;
              return (
                <Rnd
                  key={box.id}
                  size={{
                    width: ptToPx(box.width),
                    height: ptToPx(box.height),
                  }}
                  position={{
                    x: ptToPx(box.x),
                    y: ptToPx(box.y),
                  }}
                  bounds="parent"
                  onMouseDown={() => setSelectedId(box.id)}
                  onDragStop={(_e, d) => {
                    // Snapshot pre-drag state so Cmd+Z restores the box
                    // to where it sat before this drag, not to some
                    // mid-drag pixel position. Drag-stop is the natural
                    // commit point — react-rnd doesn't fire onChange
                    // during the drag itself.
                    pushUndoSnapshot();
                    updateBox(box.id, {
                      x: Math.max(0, pxToPt(d.x)),
                      y: Math.max(0, pxToPt(d.y)),
                    });
                  }}
                  onResizeStop={(_e, _dir, ref, _delta, position) => {
                    pushUndoSnapshot();
                    updateBox(box.id, {
                      width: pxToPt(parseFloat(ref.style.width)),
                      height: pxToPt(parseFloat(ref.style.height)),
                      x: Math.max(0, pxToPt(position.x)),
                      y: Math.max(0, pxToPt(position.y)),
                    });
                  }}
                  className={`group ${
                    isSelected
                      ? "outline outline-2 outline-primary z-10"
                      : "outline outline-1 outline-dashed outline-muted-foreground/50 hover:outline-primary/60"
                  }`}
                >
                  <div
                    className="h-full w-full flex items-center overflow-hidden px-1"
                    style={{
                      fontSize: `${ptToPx(box.size)}px`,
                      // Approximate font mapping — we can't load pdf-lib
                      // standard fonts in the browser, so this is just a
                      // visual hint of family + style. Final glyph
                      // rendering happens server-side.
                      fontFamily: box.font.startsWith("Times")
                        ? "Times, serif"
                        : box.font.startsWith("Courier")
                          ? "Courier, monospace"
                          : "Helvetica, Arial, sans-serif",
                      fontWeight: box.font.includes("Bold") ? 700 : 400,
                      fontStyle:
                        box.font.includes("Oblique") || box.font.includes("Italic")
                          ? "italic"
                          : "normal",
                      color: box.color,
                      textAlign: box.align,
                      justifyContent:
                        box.align === "center"
                          ? "center"
                          : box.align === "right"
                            ? "flex-end"
                            : "flex-start",
                      lineHeight: 1,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {box.content || <span className="text-muted-foreground italic">(empty)</span>}
                  </div>
                </Rnd>
              );
            })}
              </div>
            </div>
          </div>
        </div>

        {/* Side panel — config for selected box */}
        <div className="space-y-4">
          {!selectedBox ? (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              <Info className="h-4 w-4 inline mr-1.5" />
              Click a text box to edit its content, font, size, and color.
              Drag to reposition; pull a corner to resize. New boxes start
              at the top-center of the page.
            </div>
          ) : (
            <div className="space-y-4 rounded-md border p-4">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Text box</Label>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => duplicateBox(selectedBox.id)}
                    aria-label="Duplicate text box"
                    title="Duplicate text box"
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => deleteBox(selectedBox.id)}
                    aria-label="Delete text box"
                    title="Delete text box"
                  >
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="box-content" className="text-xs">
                  Content (use {`{{tokens}}`})
                </Label>
                <Textarea
                  id="box-content"
                  rows={3}
                  value={selectedBox.content}
                  // Snapshot once per edit "session" (focus → blur). Each
                  // keystroke does NOT push a new undo step — that would
                  // be like a code editor where Cmd+Z deletes one
                  // character. The whole edit collapses to one undo step.
                  onFocus={pushUndoSnapshot}
                  onChange={(e) => updateBox(selectedBox.id, { content: e.target.value })}
                  className="font-mono text-sm"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Font</Label>
                  <Select
                    value={selectedBox.font}
                    onValueChange={(v) => {
                      // Select fires once per dropdown commit, so this
                      // is the natural snapshot point.
                      pushUndoSnapshot();
                      updateBox(selectedBox.id, { font: v as CertificateFontName });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FONTS.map((f) => (
                        <SelectItem key={f} value={f}>
                          {f}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="box-size" className="text-xs">
                    Size (pt)
                  </Label>
                  <Input
                    id="box-size"
                    type="number"
                    min={4}
                    max={120}
                    step={1}
                    value={selectedBox.size}
                    onFocus={pushUndoSnapshot}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n) && n >= 4 && n <= 120) {
                        updateBox(selectedBox.id, { size: n });
                      }
                    }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="box-color" className="text-xs">
                    Color
                  </Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={selectedBox.color}
                      // Native <input type=color> can fire onChange many
                      // times in a single picker session (each color
                      // swatch hover/click). onFocus is the cleanest
                      // single-snapshot point per session.
                      onFocus={pushUndoSnapshot}
                      onChange={(e) =>
                        updateBox(selectedBox.id, { color: e.target.value })
                      }
                      className="h-9 w-12 cursor-pointer rounded border"
                      aria-label="Pick color"
                    />
                    <Input
                      id="box-color"
                      className="font-mono text-xs"
                      value={selectedBox.color}
                      onFocus={pushUndoSnapshot}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (/^#[0-9a-fA-F]{6}$/.test(v)) {
                          updateBox(selectedBox.id, { color: v });
                        } else {
                          // Allow intermediate typing — only commit valid hex.
                          // Re-trigger render via local state if needed; for
                          // now we just don't propagate invalid values.
                        }
                      }}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Align</Label>
                  <div className="flex gap-1">
                    {(["left", "center", "right"] as const).map((a) => {
                      const Icon =
                        a === "left" ? AlignLeft : a === "center" ? AlignCenter : AlignRight;
                      return (
                        <Button
                          key={a}
                          type="button"
                          variant={selectedBox.align === a ? "default" : "outline"}
                          size="icon"
                          onClick={() => {
                            pushUndoSnapshot();
                            updateBox(selectedBox.id, { align: a });
                          }}
                          aria-label={`Align ${a}`}
                        >
                          <Icon className="h-4 w-4" />
                        </Button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* X/Y/W/H direct inputs — each snapshot-on-focus so
                  an entire keyboard edit of a number collapses to one
                  undo step. */}
              <div className="grid grid-cols-4 gap-2 text-xs">
                <div>
                  <Label className="text-xs text-muted-foreground">X (pt)</Label>
                  <Input
                    type="number"
                    value={Math.round(selectedBox.x)}
                    onFocus={pushUndoSnapshot}
                    onChange={(e) =>
                      updateBox(selectedBox.id, { x: Number(e.target.value) || 0 })
                    }
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Y (pt)</Label>
                  <Input
                    type="number"
                    value={Math.round(selectedBox.y)}
                    onFocus={pushUndoSnapshot}
                    onChange={(e) =>
                      updateBox(selectedBox.id, { y: Number(e.target.value) || 0 })
                    }
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">W (pt)</Label>
                  <Input
                    type="number"
                    value={Math.round(selectedBox.width)}
                    onFocus={pushUndoSnapshot}
                    onChange={(e) =>
                      updateBox(selectedBox.id, {
                        width: Math.max(1, Number(e.target.value) || 1),
                      })
                    }
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">H (pt)</Label>
                  <Input
                    type="number"
                    value={Math.round(selectedBox.height)}
                    onFocus={pushUndoSnapshot}
                    onChange={(e) =>
                      updateBox(selectedBox.id, {
                        height: Math.max(1, Number(e.target.value) || 1),
                      })
                    }
                  />
                </div>
              </div>

              {/* One-click centering on the page axes (uses the page
                  dimensions; the dashed guides show the same center lines). */}
              <div className="space-y-1.5">
                <Label className="text-xs">Center on page</Label>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => centerBoxH(selectedBox.id)}
                    title="Center this box horizontally on the page"
                  >
                    <AlignHorizontalJustifyCenter className="h-4 w-4 mr-1" /> Center&nbsp;H
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => centerBoxV(selectedBox.id)}
                    title="Center this box vertically on the page"
                  >
                    <AlignVerticalJustifyCenter className="h-4 w-4 mr-1" /> Center&nbsp;V
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Token reference / inserter */}
          <details className="rounded-md border p-3 text-sm">
            <summary className="cursor-pointer font-medium">
              Available tokens ({AVAILABLE_TOKENS.length})
            </summary>
            <p className="text-xs text-muted-foreground mt-2 mb-2">
              {selectedBox
                ? "Click a token to append it to the selected box."
                : "Select a text box first, then click a token to insert."}
            </p>
            <div className="space-y-1">
              {AVAILABLE_TOKENS.map((t) => (
                <button
                  type="button"
                  key={t.token}
                  disabled={!selectedBox}
                  onClick={() => insertToken(t.token)}
                  className="w-full text-left rounded px-2 py-1 hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <code className="text-xs font-mono text-primary">{t.token}</code>
                  <span className="block text-xs text-muted-foreground">
                    {t.description}
                  </span>
                </button>
              ))}
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
