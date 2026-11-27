"use client";

/**
 * The pieces of the event Settings Badge card (Nov 27, 2026): a titled group,
 * a short number field with its unit beside it, and the live preview.
 *
 * The preview is the REAL sample badge: the PDF the card's preview route
 * renders through the print pipeline, drawn on a canvas with pdf.js (the same
 * self-hosted worker the certificate editor uses). It is never a second
 * drawing of the badge in HTML, which would drift from what prints.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export function BadgeSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 border-t pt-5 first:border-t-0 first:pt-0">
      <div className="space-y-0.5">
        <h4 className="text-sm font-semibold">{title}</h4>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/** A short number box with its unit beside it: a badge is four digits wide, not a full row. */
export function UnitField({
  id,
  label,
  unit,
  className,
  ...input
}: { id: string; label: string; unit: string } & React.ComponentProps<typeof Input>) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <Input id={id} type="number" className={cn("w-24", className)} {...input} />
        <span className="text-sm text-muted-foreground">{unit}</span>
      </div>
    </div>
  );
}

/** A4 in points, as the badge PDF is laid out. */
const SHEET_W = 595.28;
const SHEET_H = 841.89;
/** How wide the preview draws, in CSS pixels. */
const PREVIEW_W = 304;
/** Sheet shown around the badge in the close view, in points. */
const AROUND = 10;
/** A very small badge is not blown up past this. */
const MAX_ZOOM = 2;
/** Wait for typing to pause before asking for another render. */
const SETTLE_MS = 500;

type PreviewState = "drawing" | "shown" | "paused" | "denied" | "failed";

function previewMessage(state: PreviewState): string | null {
  if (state === "paused") return "Too many previews in the last hour, so this one is paused. Your settings are not affected; it draws again when you change a value, once the hour has passed.";
  if (state === "denied") return "Your role cannot preview badges: that needs badge printing. Your settings are not affected.";
  if (state === "failed") return "The preview could not be drawn. Open the PDF below to check the badge.";
  return null;
}

/** What a refused or failed draw becomes, from the status pdf.js reports. */
function failedState(err: unknown): PreviewState {
  const status = (err as { status?: number })?.status;
  if (status === 429) return "paused";
  if (status === 403) return "denied";
  return "failed";
}

type Framing = { badge: { x: number; y: number; w: number; h: number }; zoom: number };

/**
 * The sample badge as it will print, redrawn when the values on the card
 * change. "Badge" shows it close up; "Sheet" shows where it sits on the A4.
 */
export function BadgeLivePreview({
  url,
  exhibitorUrl,
  badge,
}: {
  /** The preview route with the values on screen. */
  url: string;
  /** The same for an exhibitor's badge, when exhibitors print differently. */
  exhibitorUrl?: string;
  /** Where the badge sits on the sheet, in points. */
  badge: { x: number; y: number; w: number; h: number };
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState<"badge" | "sheet">("badge");
  const [who, setWho] = useState<"delegate" | "exhibitor">("delegate");
  const [state, setState] = useState<PreviewState>("drawing");
  // The badge the canvas holds: the frame follows what is DRAWN, so it does
  // not jump to the new position half a second before the picture does.
  const [drawn, setDrawn] = useState<Framing | null>(null);
  // A role without badge printing is refused every time: asked once, not on every change.
  const deniedRef = useRef(false);

  const shownUrl = who === "exhibitor" && exhibitorUrl ? exhibitorUrl : url;
  const zoom = Math.min(PREVIEW_W / (badge.w + AROUND * 2), MAX_ZOOM);
  const { x, y, w, h } = badge;

  useEffect(() => {
    if (deniedRef.current) return;
    let cancelled = false;
    // Each draw starts a pdf.js worker; destroying its task ends the worker
    // and, when a newer value arrives first, the request too.
    let task: { destroy: () => Promise<void> } | null = null;
    const timer = setTimeout(async () => {
      setState("drawing");
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
        const loading = pdfjs.getDocument(shownUrl);
        task = loading;
        const pdf = await loading.promise;
        const page = await pdf.getPage(1);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: zoom * dpr });
        // Drawn off screen and copied over whole, so the last badge stays up
        // until the next one is ready.
        const sheet = document.createElement("canvas");
        sheet.width = viewport.width;
        sheet.height = viewport.height;
        const context = sheet.getContext("2d");
        if (!context) throw new Error("no 2d context");
        await page.render({ canvasContext: context, viewport }).promise;
        const shown = canvasRef.current;
        if (cancelled || !shown) return;
        shown.width = sheet.width;
        shown.height = sheet.height;
        shown.getContext("2d")?.drawImage(sheet, 0, 0);
        setDrawn({ badge: { x, y, w, h }, zoom });
        setState("shown");
      } catch (err) {
        if (cancelled) return;
        const next = failedState(err);
        deniedRef.current = next === "denied";
        if (next === "failed") console.error("badge-preview:draw-failed", err);
        setState(next);
      } finally {
        void task?.destroy();
      }
    }, SETTLE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      void task?.destroy();
    };
  }, [shownUrl, zoom, x, y, w, h]);

  const framing = drawn ?? { badge, zoom };
  const scale = view === "badge" ? framing.zoom : PREVIEW_W / SHEET_W;
  const frame =
    view === "badge"
      ? { width: (framing.badge.w + AROUND * 2) * framing.zoom, height: (framing.badge.h + AROUND * 2) * framing.zoom }
      : { width: PREVIEW_W, height: PREVIEW_W * (SHEET_H / SHEET_W) };
  const shift =
    view === "badge"
      ? { left: -(framing.badge.x - AROUND) * framing.zoom, top: -(framing.badge.y - AROUND) * framing.zoom }
      : { left: 0, top: 0 };
  const message = previewMessage(state);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Preview</h4>
        <div className="flex gap-1">
          {(["badge", "sheet"] as const).map((v) => (
            <Button key={v} type="button" size="sm" aria-pressed={view === v} variant={view === v ? "default" : "outline"} onClick={() => setView(v)}>
              {v === "badge" ? "Badge" : "Sheet"}
            </Button>
          ))}
        </div>
      </div>
      {exhibitorUrl && (
        <div className="flex gap-1">
          {(["delegate", "exhibitor"] as const).map((p) => (
            <Button key={p} type="button" size="sm" aria-pressed={who === p} variant={who === p ? "secondary" : "ghost"} onClick={() => setWho(p)}>
              {p === "delegate" ? "Delegate" : "Exhibitor"}
            </Button>
          ))}
        </div>
      )}
      <div
        className={cn("relative mx-auto overflow-hidden rounded-md border bg-white shadow-sm transition-opacity", state === "drawing" && "opacity-70")}
        style={frame}
        aria-label="A sample badge drawn with the values on this card"
        role="img"
      >
        <canvas
          ref={canvasRef}
          className="absolute max-w-none"
          style={{ ...shift, width: SHEET_W * scale, height: SHEET_H * scale }}
        />
      </div>
      {message && <p className="text-xs text-amber-700 dark:text-amber-300">{message}</p>}
      <p className="text-xs text-muted-foreground">
        A sample, drawn as it will print, with what is on this card before you save. Print the PDF on your own
        stock to check the alignment.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" asChild>
          <a href={url} target="_blank" rel="noopener noreferrer">
            Preview one badge
          </a>
        </Button>
        {exhibitorUrl && (
          <Button type="button" variant="outline" size="sm" asChild>
            <a href={exhibitorUrl} target="_blank" rel="noopener noreferrer">
              Preview an exhibitor badge
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}
