"use client";

import { useEffect, useState } from "react";
import { pickClockOffset, type ClockSample } from "@/lib/stream-latency";

/**
 * Server time minus this browser's time, in ms (null until measured, or when
 * the server could not be reached). Five quick requests to /api/public/time;
 * the shortest round trip wins. Re-measured every 10 minutes.
 */
export function useServerClockOffset(enabled = true): number | null {
  const [offset, setOffset] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const measure = async () => {
      const samples: ClockSample[] = [];
      for (let i = 0; i < 5; i++) {
        try {
          const sentAt = Date.now();
          const res = await fetch("/api/public/time", { cache: "no-store" });
          const receivedAt = Date.now();
          if (!res.ok) continue;
          const body = (await res.json()) as { now?: number };
          if (typeof body.now === "number") samples.push({ sentAt, receivedAt, serverNow: body.now });
        } catch (err) {
          console.warn("server-clock:sample-failed", err);
        }
      }
      if (!cancelled) setOffset(pickClockOffset(samples));
    };
    void measure();
    const id = setInterval(() => void measure(), 10 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled]);

  return offset;
}
