"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { ExternalLink, Loader2, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PlayerTimingSample } from "@/components/zoom/live-player";
import {
  formatDelay,
  median,
  parseClockQr,
  readingFromClock,
  type DelayReading,
} from "@/lib/stream-latency";

const MEASURE_TIMEOUT_MS = 60_000;
const MEASURE_READINGS = 10;
const SCAN_EVERY_MS = 300;

type MeasureState =
  | { kind: "idle" }
  | { kind: "running"; found: number }
  | { kind: "done"; result: DelayReading; count: number; at: number }
  | { kind: "failed"; message: string };

/**
 * The delay readout under the console's stream preview (Oct 2, 2026).
 *
 * "Our delay" runs all the time: the server time now minus the arrival time
 * of the frame on screen. "Measure Zoom delay" reads the /stream-clock QR code
 * out of the preview while the host shares that page in Zoom, and splits the
 * total into Zoom's share and ours. See src/lib/stream-latency.ts.
 */
export function StreamDelay({
  videoBoxRef,
  latestSampleRef,
  sample,
  offsetMs,
  timezone,
  playing,
}: {
  /** The element that contains the preview's <video>. */
  videoBoxRef: RefObject<HTMLDivElement | null>;
  latestSampleRef: RefObject<PlayerTimingSample | null>;
  /** The latest sample, for rendering. */
  sample: PlayerTimingSample | null;
  /** Server time minus local time; null until synced. */
  offsetMs: number | null;
  timezone: string;
  playing: boolean;
}) {
  // The last five readings of our own delay, smoothed with a median.
  const recentRef = useRef<number[]>([]);
  const [ours, setOurs] = useState<number | null>(null);
  useEffect(() => {
    if (!sample || offsetMs === null || sample.playingDateMs === null) return;
    const value = sample.at + offsetMs - sample.playingDateMs;
    recentRef.current = [...recentRef.current.slice(-4), value];
    setOurs(median(recentRef.current));
  }, [sample, offsetMs]);

  const [measure, setMeasure] = useState<MeasureState>({ kind: "idle" });
  const cancelRef = useRef(false);
  useEffect(
    () => () => {
      cancelRef.current = true;
    },
    [],
  );

  const runMeasure = async () => {
    if (offsetMs === null) return;
    cancelRef.current = false;
    setMeasure({ kind: "running", found: 0 });
    let decoder: { decodeAsync(canvas: HTMLCanvasElement): Promise<{ text: string }> };
    try {
      const [{ Html5QrcodeShim }, { Html5QrcodeSupportedFormats }] = await Promise.all([
        import("html5-qrcode/esm/code-decoder"),
        import("html5-qrcode/esm/core"),
      ]);
      const logger = {
        log: () => {},
        warn: (m: string) => console.warn("stream-delay:decoder", m),
        logError: (m: string) => console.warn("stream-delay:decoder", m),
        logErrors: (e: unknown[]) => console.warn("stream-delay:decoder", e),
      };
      decoder = new Html5QrcodeShim([Html5QrcodeSupportedFormats.QR_CODE], true, false, logger);
    } catch (err) {
      console.error("stream-delay:decoder-load-failed", err);
      setMeasure({ kind: "failed", message: "The QR reader could not be loaded. Refresh the page and try again." });
      return;
    }

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const readings: DelayReading[] = [];
    let lastQr = 0;
    const deadline = Date.now() + MEASURE_TIMEOUT_MS;
    while (!cancelRef.current && Date.now() < deadline && readings.length < MEASURE_READINGS) {
      const video = videoBoxRef.current?.querySelector("video");
      if (ctx && video && video.videoWidth > 0) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        // Times taken at the moment the frame was captured, before decoding.
        const capturedAt = Date.now();
        const serverNow = capturedAt + offsetMs;
        const latest = latestSampleRef.current;
        const playingDate =
          latest && latest.playingDateMs !== null ? latest.playingDateMs + (capturedAt - latest.at) : null;
        try {
          ctx.getImageData(0, 0, 1, 1);
        } catch (err) {
          console.error("stream-delay:frame-unreadable", err);
          setMeasure({
            kind: "failed",
            message: "This browser will not let the console read the video frames. Try Chrome, or ask for the stream's CORS header to be checked.",
          });
          return;
        }
        try {
          const decoded = await decoder.decodeAsync(canvas);
          const qr = parseClockQr(decoded.text);
          if (qr !== null && qr !== lastQr) {
            lastQr = qr;
            readings.push(readingFromClock(qr, serverNow, playingDate));
            setMeasure({ kind: "running", found: readings.length });
          }
        } catch {
          // No QR code in this frame: the normal case until the host shares the clock.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, SCAN_EVERY_MS));
    }
    if (cancelRef.current) return;
    if (readings.length === 0) {
      console.warn("stream-delay:no-clock-found");
      setMeasure({
        kind: "failed",
        message: "No clock found in the stream. Check that the host is sharing the clock page in Zoom and that the preview is playing.",
      });
      return;
    }
    const pick = (key: keyof DelayReading) => {
      const values = readings.map((r) => r[key]).filter((v): v is number => v !== null);
      return median(values);
    };
    const result: DelayReading = { totalMs: pick("totalMs") ?? 0, zoomMs: pick("zoomMs"), oursMs: pick("oursMs") };
    console.info("stream-delay:measured", { ...result, readings: readings.length });
    setMeasure({ kind: "done", result, count: readings.length, at: Date.now() + offsetMs });
  };

  const clockUrl = `/stream-clock?tz=${encodeURIComponent(timezone)}`;
  const measuredAt = (ms: number) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(
      new Date(ms),
    );

  return (
    <div className="space-y-3 rounded-md bg-muted/40 p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">Our delay:</span>
        {!playing ? (
          <span className="text-muted-foreground">shown once the stream plays</span>
        ) : ours !== null ? (
          <>
            <span className="font-mono tabular-nums">{formatDelay(ours)}</span>
            <span className="text-xs text-muted-foreground">from our server receiving the video to this screen</span>
          </>
        ) : sample?.behindEdgeS != null ? (
          <>
            <span className="font-mono tabular-nums">about {sample.behindEdgeS.toFixed(1)} s</span>
            <span className="text-xs text-muted-foreground">
              behind the newest chunk (the stream carries no arrival times, so this is an estimate)
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">measuring…</span>
        )}
      </div>

      <div className="space-y-2 border-t pt-3">
        <p className="font-medium">Zoom&apos;s delay (clock test)</p>
        <p className="text-xs text-muted-foreground">
          Open the clock page and have the host share it in Zoom, then press Measure. The console reads
          the clock out of the stream for up to a minute.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" asChild className="gap-2">
            <a href={clockUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4" />
              Open the clock page
            </a>
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void runMeasure()}
            disabled={!playing || offsetMs === null || measure.kind === "running"}
            className="gap-2"
          >
            {measure.kind === "running" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Timer className="h-4 w-4" />}
            {measure.kind === "running" ? `Reading the clock… ${measure.found}/${MEASURE_READINGS}` : "Measure Zoom delay"}
          </Button>
          {measure.kind === "running" && (
            <Button size="sm" variant="ghost" onClick={() => {
                cancelRef.current = true;
                setMeasure({ kind: "idle" });
              }}>
              Cancel
            </Button>
          )}
        </div>
        {measure.kind === "done" && (
          <div className="space-y-1">
            <p>
              <span className="font-medium">Total {formatDelay(measure.result.totalMs)}</span>
              {" = "}Zoom {formatDelay(measure.result.zoomMs)} + ours {formatDelay(measure.result.oursMs)}
            </p>
            <p className="text-xs text-muted-foreground">
              Median of {measure.count} readings at {measuredAt(measure.at)}.
              {measure.result.zoomMs === null &&
                " The stream carries no arrival times, so only the total can be measured."}
            </p>
          </div>
        )}
        {measure.kind === "failed" && <p className="text-sm text-red-600">{measure.message}</p>}
      </div>
    </div>
  );
}
