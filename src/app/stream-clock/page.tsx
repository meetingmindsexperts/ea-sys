"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useServerClockOffset } from "@/hooks/use-server-clock";
import { encodeClockQr } from "@/lib/stream-latency";
import { DEFAULT_EVENT_TIMEZONE, tzLabel } from "@/lib/event-time";

/**
 * The clock for the stream delay test (Oct 2, 2026). The host opens it from
 * the Webinar Console and shares it in Zoom; the console's preview reads the
 * QR code (the server's time, refreshed ten times a second) out of the stream
 * and works out how long the picture took to arrive. The large time is for
 * anyone comparing by eye, in the event's timezone (?tz=). No data, no login.
 */
function StreamClock() {
  const params = useSearchParams();
  const timezone = useMemo(() => {
    const tz = params.get("tz") || DEFAULT_EVENT_TIMEZONE;
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: tz });
      return tz;
    } catch {
      return DEFAULT_EVENT_TIMEZONE;
    }
  }, [params]);
  const formatter = useMemo(
    () =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 1,
        hour12: false,
      }),
    [timezone],
  );

  const offset = useServerClockOffset();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [label, setLabel] = useState("");
  const [drawError, setDrawError] = useState<string | null>(null);

  useEffect(() => {
    if (offset === null) return;
    let cancelled = false;
    let id: ReturnType<typeof setInterval> | undefined;
    void import("bwip-js/browser")
      .then(({ toCanvas }) => {
        if (cancelled) return;
        const tick = () => {
          const serverNow = Date.now() + offset;
          setLabel(formatter.format(new Date(serverNow)));
          const canvas = canvasRef.current;
          if (!canvas) return;
          try {
            toCanvas(canvas, {
              bcid: "qrcode",
              text: encodeClockQr(serverNow),
              scale: 10,
              paddingwidth: 4,
              paddingheight: 4,
              backgroundcolor: "FFFFFF",
            });
          } catch (err) {
            console.error("stream-clock:draw-failed", err);
            setDrawError("The QR code could not be drawn in this browser.");
          }
        };
        tick();
        id = setInterval(tick, 100);
      })
      .catch((err) => {
        console.error("stream-clock:load-failed", err);
        setDrawError("The QR code could not be loaded. Refresh the page.");
      });
    return () => {
      cancelled = true;
      if (id) clearInterval(id);
    };
  }, [offset, formatter]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-white p-4 text-slate-900">
      <p className="max-w-xl text-center text-sm text-slate-600">
        Share this window in Zoom, then press <strong>Measure Zoom delay</strong> in the Webinar
        Console. Keep it on screen for about 15 seconds.
      </p>
      {offset === null ? (
        <p className="text-slate-500">Syncing with the server clock…</p>
      ) : (
        <>
          <canvas
            ref={canvasRef}
            aria-label="Clock QR code"
            className="h-[min(60vh,80vw)] w-[min(60vh,80vw)]"
            style={{ imageRendering: "pixelated" }}
          />
          <p className="font-mono text-6xl font-semibold tabular-nums sm:text-8xl">{label}</p>
          <p className="text-sm text-slate-500">{tzLabel(new Date(), timezone)}</p>
        </>
      )}
      {drawError && <p className="text-sm text-red-600">{drawError}</p>}
    </main>
  );
}

export default function StreamClockPage() {
  return (
    <Suspense fallback={null}>
      <StreamClock />
    </Suspense>
  );
}
