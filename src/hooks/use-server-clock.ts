"use client";

import { useEffect, useState } from "react";
import { pickClockOffset, type ClockSample } from "@/lib/stream-latency";

export interface ServerClock {
  /** Server time minus this browser's time, in ms; null while syncing. */
  offsetMs: number | null;
  /**
   * "synced" once the server answered; "local" when it could not be reached
   * (offline, or rate-limited), in which case offsetMs is 0 and times use this
   * device's own clock. Callers say so rather than waiting forever.
   */
  status: "syncing" | "synced" | "local";
}

/**
 * Five quick requests to /api/public/time; the shortest round trip wins.
 * Re-measured every 10 minutes.
 */
export function useServerClock(enabled = true): ServerClock {
  const [clock, setClock] = useState<ServerClock>({ offsetMs: null, status: "syncing" });

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
          if (!res.ok) {
            console.warn("server-clock:sample-refused", res.status);
            continue;
          }
          const body = (await res.json()) as { now?: number };
          if (typeof body.now === "number") samples.push({ sentAt, receivedAt, serverNow: body.now });
        } catch (err) {
          console.warn("server-clock:sample-failed", err);
        }
      }
      if (cancelled) return;
      const offset = pickClockOffset(samples);
      if (offset === null) {
        console.warn("server-clock:unavailable-using-local-clock");
        setClock({ offsetMs: 0, status: "local" });
        return;
      }
      setClock({ offsetMs: offset, status: "synced" });
    };
    void measure();
    const id = setInterval(() => void measure(), 10 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled]);

  return clock;
}
