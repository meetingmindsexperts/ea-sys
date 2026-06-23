"use client";

import { useEffect, useState } from "react";
import { Loader2, Clock } from "lucide-react";
import { parseLobbyVideo } from "@/lib/webinar/lobby-video";

interface WaitingRoomProps {
  /** ISO start time, for the countdown. */
  startsAt: string;
  /** YouTube/Vimeo holding video (looped, muted). */
  lobbyVideoUrl?: string | null;
  /** Optional message under the video. */
  lobbyMessage?: string | null;
  /** Event banner — used as a branded poster when no holding video is set. */
  posterUrl?: string | null;
}

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/**
 * Branded webinar waiting room shown to registered attendees before the
 * producer opens the room. Plays an optional looped YouTube/Vimeo holding
 * video and counts down to start. The parent polls `lobby-status` and swaps
 * this out for the live view the moment the room opens.
 */
export function WaitingRoom({ startsAt, lobbyVideoUrl, lobbyMessage, posterUrl }: WaitingRoomProps) {
  const now = useNow();
  const remaining = new Date(startsAt).getTime() - now;
  const started = remaining <= 0;
  const video = parseLobbyVideo(lobbyVideoUrl);

  return (
    <div className="space-y-4">
      {/* Three-tier visual: holding video → event-banner poster → gradient.
          The "waiting…" overlay sits on all non-video states so the lobby
          always reads as a deliberate holding screen, never a broken embed. */}
      {video ? (
        <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
          <iframe
            src={video.embedUrl}
            title="Waiting room"
            className="absolute inset-0 h-full w-full"
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
          />
        </div>
      ) : (
        <div className="relative flex aspect-video w-full flex-col items-center justify-center gap-3 overflow-hidden rounded-lg bg-gradient-to-br from-slate-900 to-slate-700 text-white">
          {posterUrl && (
            // Dimmed decorative poster behind a "waiting…" overlay. Plain <img>
            // (not next/image) — the banner is a user-uploaded absolute/relative
            // URL and optimization isn't worth it for a background image.
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={posterUrl}
              alt=""
              className="absolute inset-0 h-full w-full object-cover opacity-40"
            />
          )}
          <Loader2 className="relative h-8 w-8 animate-spin opacity-90" />
          <p className="relative text-sm font-medium opacity-90">
            Waiting for the session to begin…
          </p>
        </div>
      )}

      {/* Countdown + message */}
      <div className="rounded-lg border bg-white p-5 text-center">
        <div className="mb-1 flex items-center justify-center gap-2 text-sm font-medium text-slate-500">
          <Clock className="h-4 w-4" />
          {started ? "Starting any moment" : "Starts in"}
        </div>
        {!started && (
          <p className="text-2xl font-bold tabular-nums text-slate-900">
            {formatRemaining(remaining)}
          </p>
        )}
        <p className="mt-2 text-sm text-slate-600">
          {lobbyMessage ||
            "You're in the waiting room — please keep this page open. You'll be admitted automatically when the host opens the session."}
        </p>
      </div>
    </div>
  );
}
