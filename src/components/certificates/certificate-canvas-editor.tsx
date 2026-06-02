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
  Info,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Loader2,
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

// Generate a stable id for a new text box. crypto.randomUUID is fine
// here — runs in modern browsers, no fallback needed.
function newBoxId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `box-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface CertificateCanvasEditorProps {
  /** The uploaded background PDF URL (`/uploads/...` or `/certificates/...`),
   *  or null if the slot has none yet (the upload widget shows). */
  backgroundPdfUrl: string | null;
  /** Current text boxes — controlled, parent owns the array. */
  textBoxes: CertificateTextBox[];
  /** Emitted on any mutation: drag, resize, content edit, add, delete. */
  onChange: (next: {
    backgroundPdfUrl?: string | null;
    textBoxes?: CertificateTextBox[];
  }) => void;
}

export function CertificateCanvasEditor({
  backgroundPdfUrl,
  textBoxes,
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
    async (file: File, eventId?: string) => {
      if (file.size > 5 * 1024 * 1024) {
        toast.error("PDF too large — max 5MB.");
        return;
      }
      setUploading(true);
      try {
        const form = new FormData();
        form.append("file", file);
        if (eventId) form.append("eventId", eventId);
        const res = await fetch("/api/upload/pdf", { method: "POST", body: form });
        const json = (await res.json().catch(() => ({}))) as {
          url?: string;
          size?: number;
          error?: string;
        };
        if (!res.ok || !json.url) {
          const msg = json.error ?? `Upload failed (HTTP ${res.status})`;
          toast.error(msg);
          console.error("[cert-canvas-editor] PDF upload failed", { status: res.status, json });
          return;
        }
        onChange({ backgroundPdfUrl: json.url });
        toast.success("Background PDF uploaded.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Upload network error: ${msg}`);
        console.error("[cert-canvas-editor] PDF upload network error", err);
      } finally {
        setUploading(false);
      }
    },
    [onChange],
  );

  // ── Text box mutators ──────────────────────────────────────────────────

  const selectedBox = useMemo(
    () => textBoxes.find((b) => b.id === selectedId) ?? null,
    [textBoxes, selectedId],
  );

  function addBox() {
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
    onChange({ textBoxes: textBoxes.filter((b) => b.id !== id) });
    if (selectedId === id) setSelectedId(null);
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
          <p className="font-medium mb-2">Upload the background certificate PDF</p>
          <p className="text-sm text-muted-foreground mb-4">
            Your designer&apos;s finished cert PDF — banner, borders,
            signatures, footer logos all baked in. We&apos;ll overlay
            text boxes with{" "}
            <code className="bg-background px-1 rounded">{`{{tokens}}`}</code>{" "}
            on top.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
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
            {uploading ? "Uploading…" : "Choose PDF"}
          </Button>
          <p className="text-xs text-muted-foreground mt-3">
            Single page, max 5MB. PNG/JPG-only designs should be exported
            to PDF in your designer tool first.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
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
          Replace PDF
        </Button>
        <Button size="sm" onClick={addBox}>
          <Plus className="h-4 w-4 mr-1" />
          Add text box
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          {textBoxes.length} text {textBoxes.length === 1 ? "box" : "boxes"} ·{" "}
          page {Math.round(pageWidthPt)} × {Math.round(pageHeightPt)} pt
        </span>
      </div>

      {/* Canvas + side panel */}
      <div className="grid gap-4 lg:grid-cols-[auto_320px]">
        {/* Canvas with text-box overlays */}
        <div className="relative overflow-auto rounded-md border bg-white">
          <div
            className="relative mx-auto"
            style={{ width: CANVAS_DISPLAY_WIDTH_PX, height: canvasHeightPx }}
            // Click on empty canvas area deselects.
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setSelectedId(null);
            }}
          >
            <canvas ref={canvasRef} className="block" />
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
                    updateBox(box.id, {
                      x: Math.max(0, pxToPt(d.x)),
                      y: Math.max(0, pxToPt(d.y)),
                    });
                  }}
                  onResizeStop={(_e, _dir, ref, _delta, position) => {
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
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => deleteBox(selectedBox.id)}
                  aria-label="Delete text box"
                >
                  <Trash2 className="h-4 w-4 text-red-500" />
                </Button>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="box-content" className="text-xs">
                  Content (use {`{{tokens}}`})
                </Label>
                <Textarea
                  id="box-content"
                  rows={3}
                  value={selectedBox.content}
                  onChange={(e) => updateBox(selectedBox.id, { content: e.target.value })}
                  className="font-mono text-sm"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Font</Label>
                  <Select
                    value={selectedBox.font}
                    onValueChange={(v) =>
                      updateBox(selectedBox.id, { font: v as CertificateFontName })
                    }
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
                          onClick={() => updateBox(selectedBox.id, { align: a })}
                          aria-label={`Align ${a}`}
                        >
                          <Icon className="h-4 w-4" />
                        </Button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-4 gap-2 text-xs">
                <div>
                  <Label className="text-xs text-muted-foreground">X (pt)</Label>
                  <Input
                    type="number"
                    value={Math.round(selectedBox.x)}
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
                    onChange={(e) =>
                      updateBox(selectedBox.id, {
                        height: Math.max(1, Number(e.target.value) || 1),
                      })
                    }
                  />
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
