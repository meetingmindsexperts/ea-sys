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

type PreviewState = "drawing" | "shown" | "paused" | "failed";

function previewMessage(state: PreviewState): string | null {
  if (state === "paused") return "Too many previews in the last hour, so this one is paused. Your settings are not affected; it draws again shortly.";
  if (state === "failed") return "The preview could not be drawn. Open the PDF below to check the badge.";
  return null;
}

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

  const shownUrl = who === "exhibitor" && exhibitorUrl ? exhibitorUrl : url;
  const zoom = Math.min(PREVIEW_W / (badge.w + AROUND * 2), MAX_ZOOM);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setState("drawing");
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
        const pdf = await pdfjs.getDocument(shownUrl).promise;
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
        setState("shown");
      } catch (err) {
        if (cancelled) return;
        setState((err as { status?: number })?.status === 429 ? "paused" : "failed");
      }
    }, SETTLE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [shownUrl, zoom]);

  const scale = view === "badge" ? zoom : PREVIEW_W / SHEET_W;
  const frame =
    view === "badge"
      ? { width: (badge.w + AROUND * 2) * zoom, height: (badge.h + AROUND * 2) * zoom }
      : { width: PREVIEW_W, height: PREVIEW_W * (SHEET_H / SHEET_W) };
  const shift = view === "badge" ? { left: -(badge.x - AROUND) * zoom, top: -(badge.y - AROUND) * zoom } : { left: 0, top: 0 };
  const message = previewMessage(state);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Preview</h4>
        <div className="flex gap-1">
          {(["badge", "sheet"] as const).map((v) => (
            <Button key={v} type="button" size="sm" variant={view === v ? "default" : "outline"} onClick={() => setView(v)}>
              {v === "badge" ? "Badge" : "Sheet"}
            </Button>
          ))}
        </div>
      </div>
      {exhibitorUrl && (
        <div className="flex gap-1">
          {(["delegate", "exhibitor"] as const).map((w) => (
            <Button key={w} type="button" size="sm" variant={who === w ? "secondary" : "ghost"} onClick={() => setWho(w)}>
              {w === "delegate" ? "Delegate" : "Exhibitor"}
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
