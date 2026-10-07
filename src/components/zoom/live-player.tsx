"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Video,
  Maximize2,
  Minimize2,
  Volume2,
  VolumeX,
  RefreshCw,
  Pause,
  Play,
  PictureInPicture2,
  Radio,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useFullscreen } from "@/hooks/use-fullscreen";

/** Normal playback sits ~6 s behind the newest chunk (3 x 2 s segments).
 *  Further behind than this means a pause or a long buffer. */
const BEHIND_LIVE_THRESHOLD_S = 12;
/** Where "Back to live" lands on native HLS, seconds before the newest chunk. */
const LIVE_EDGE_OFFSET_S = 4;

interface LivePlayerProps {
  hlsUrl: string;
  slug: string;
  sessionId: string;
  posterImage?: string;
  sessionName?: string;
  onStreamStatusChange?: (status: "active" | "idle" | "ended") => void;
  /**
   * Console stream preview only (Oct 2, 2026): called about once a second
   * while playing with the arrival time of the frame on screen (from the
   * chunk's EXT-X-PROGRAM-DATE-TIME stamp; null when the stream has none) and
   * how far playback sits behind the newest chunk. Attendees never pass it.
   */
  onTimingSample?: (sample: PlayerTimingSample) => void;
  /**
   * Request the video with CORS so the console can read frames for the clock
   * test (a canvas refuses frames from another origin without it). Off for
   * attendees: a CDN that dropped the CORS header would stop their playback.
   */
  measurable?: boolean;
}

export interface PlayerTimingSample {
  /** Local time the sample was taken (ms, Date.now()). */
  at: number;
  /** Arrival time of the frame on screen, on the server clock (ms), or null. */
  playingDateMs: number | null;
  /** Seconds behind the newest chunk, or null when unknown. */
  behindEdgeS: number | null;
}

export function LivePlayer({
  hlsUrl,
  slug,
  sessionId,
  sessionName,
  onStreamStatusChange,
  onTimingSample,
  measurable = false,
}: LivePlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<unknown>(null);
  // True once we've failed over from the CDN URL to the origin URL, so the
  // CDN→origin failover happens at most once per load (no ping-pong).
  const triedFallbackRef = useRef(false);
  const [status, setStatus] = useState<"loading" | "playing" | "offline" | "error">("loading");
  // Bumped by the Retry button to re-run the init effect (instead of a full
  // window.location.reload, which at 5k viewers is a thundering-herd self-DoS).
  const [retryNonce, setRetryNonce] = useState(0);
  const [isMuted, setIsMuted] = useState(true);
  // The stream starts muted (browsers only autoplay silent video), so a large
  // "Tap to turn on sound" button covers the picture until the viewer makes a
  // choice either way (owner, Oct 7, 2026).
  const [soundChosen, setSoundChosen] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  // Behind the live moment by more than the normal buffer: after a pause or a
  // long buffer. Drives the "Back to live" button.
  const [isBehind, setIsBehind] = useState(false);
  const [pipSupported, setPipSupported] = useState(false);
  const [inPip, setInPip] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // Shared with the Zoom embed: browser fullscreen with Esc tracked, and the
  // in-page fallback where the browser has no element fullscreen (iPhone).
  const { isFullscreen, isFallback, toggle: toggleFullscreen } = useFullscreen(containerRef);

  // Latest-value ref for the status callback so the init effect below does NOT
  // list it as a dependency. A caller passing a non-memoized onStreamStatusChange
  // would otherwise re-run the whole effect — tearing down + re-creating the HLS
  // instance and the 10s recovery poll — on every render (ROADMAP webinar LOW).
  // On the public page the prop is undefined so this is harmless today; the ref
  // future-proofs it. Updating a ref during render is StrictMode-safe.
  const onStreamStatusChangeRef = useRef(onStreamStatusChange);
  onStreamStatusChangeRef.current = onStreamStatusChange;

  const pollStreamStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/public/events/${slug}/sessions/${sessionId}/stream-status`);
      if (!res.ok) return null;
      const data = await res.json();
      return data;
    } catch {
      return null;
    }
  }, [slug, sessionId]);

  // Initialize HLS player
  useEffect(() => {
    let mounted = true;
    let pollInterval: ReturnType<typeof setInterval>;

    // Resume polling stream-status until the stream is live again, then reload —
    // so a transient drop (CDN blip, RTMP reconnect, segment gap) AUTO-RECOVERS
    // instead of dead-ending the viewer in an error/reload screen.
    function startRecoveryPoll(reason: "idle" | "ended") {
      setStatus("offline");
      onStreamStatusChangeRef.current?.(reason);
      clearInterval(pollInterval);
      pollInterval = setInterval(async () => {
        const data = await pollStreamStatus();
        if (!mounted) return;
        if (data?.status === "active" && data.hlsUrl) {
          clearInterval(pollInterval);
          triedFallbackRef.current = false;
          loadHls(data.hlsUrl, data.hlsOriginUrl);
        }
      }, 10_000);
    }

    async function initPlayer() {
      const video = videoRef.current;
      if (!video) return;
      triedFallbackRef.current = false;

      // Check if stream is live first
      const streamData = await pollStreamStatus();
      if (!mounted) return;

      if (!streamData || streamData.status !== "active") {
        startRecoveryPoll("idle");
        return;
      }

      loadHls(streamData.hlsUrl || hlsUrl, streamData.hlsOriginUrl);
    }

    // Load `url`; on a fatal failure, fail over to `fallbackUrl` (the box
    // origin) once if the CDN edge misbehaves — then surface a retry message.
    async function loadHls(url: string, fallbackUrl?: string) {
      const video = videoRef.current;
      if (!video || !mounted) return;

      const tryFallback = (): boolean => {
        if (fallbackUrl && fallbackUrl !== url && !triedFallbackRef.current) {
          triedFallbackRef.current = true;
          loadHls(fallbackUrl);
          return true;
        }
        return false;
      };

      // Native HLS: Safari, and Chrome too since 2025. The console preview
      // (`measurable`) prefers hls.js where it can run, because only hls.js
      // exposes the chunk arrival times the delay readout needs (Oct 2, 2026).
      const hlsJsUsable = measurable && typeof window !== "undefined" && "MediaSource" in window;
      if (video.canPlayType("application/vnd.apple.mpegurl") && !hlsJsUsable) {
        video.src = url;
        video.onloadedmetadata = () => {
          if (mounted) {
            setStatus("playing");
            onStreamStatusChangeRef.current?.("active");
            video.play().catch(() => {});
          }
        };
        video.onerror = () => {
          // CDN edge failed → try the box origin once; else resume the live
          // poll so a transient drop auto-recovers.
          if (mounted && !tryFallback()) startRecoveryPoll("ended");
        };
        return;
      }

      // Other browsers: use hls.js
      try {
        const Hls = (await import("hls.js")).default;

        if (!Hls.isSupported()) {
          setStatus("error");
          return;
        }

        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 30,
        });

        hlsRef.current = hls;
        hls.loadSource(url);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (mounted) {
            setStatus("playing");
            onStreamStatusChangeRef.current?.("active");
            video.play().catch(() => {});
          }
        });

        hls.on(Hls.Events.ERROR, (_event: unknown, data: { fatal?: boolean; type?: string }) => {
          if (data.fatal && mounted) {
            hls.destroy();
            // Cleared so the preview's timing reader never reads a destroyed instance.
            if (hlsRef.current === hls) hlsRef.current = null;
            // CDN edge failed → try the box origin once.
            if (tryFallback()) return;
            // Both CDN + origin failed → resume the recovery poll (auto-reconnect
            // when healthy) rather than dead-ending in "error".
            startRecoveryPoll("ended");
          }
        });
      } catch {
        if (mounted) setStatus("error");
      }
    }

    initPlayer();

    return () => {
      mounted = false;
      clearInterval(pollInterval);
      if (hlsRef.current && typeof (hlsRef.current as { destroy?: () => void }).destroy === "function") {
        (hlsRef.current as { destroy: () => void }).destroy();
        hlsRef.current = null;
      }
    };
  }, [hlsUrl, slug, sessionId, pollStreamStatus, retryNonce, measurable]);

  // Timing samples for the console preview (see onTimingSample). Only runs
  // when a caller asks, so attendees pay nothing.
  const onTimingSampleRef = useRef(onTimingSample);
  useEffect(() => {
    onTimingSampleRef.current = onTimingSample;
  }, [onTimingSample]);
  const wantsTiming = Boolean(onTimingSample);
  useEffect(() => {
    if (!wantsTiming || status !== "playing") return;
    const id = setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      const hls = hlsRef.current as { playingDate?: Date | null; latency?: number } | null;
      let playingDateMs: number | null = null;
      let behindEdgeS: number | null = null;
      if (hls) {
        playingDateMs = hls.playingDate ? hls.playingDate.getTime() : null;
        behindEdgeS = Number.isFinite(hls.latency) ? (hls.latency ?? null) : null;
      } else {
        // Safari plays HLS natively: the stamp comes through getStartDate().
        const start = (video as HTMLVideoElement & { getStartDate?: () => Date }).getStartDate?.();
        const startMs = start ? start.getTime() : NaN;
        playingDateMs = Number.isFinite(startMs) ? startMs + video.currentTime * 1000 : null;
        if (video.seekable.length > 0) {
          behindEdgeS = video.seekable.end(video.seekable.length - 1) - video.currentTime;
        }
      }
      onTimingSampleRef.current?.({ at: Date.now(), playingDateMs, behindEdgeS });
    }, 1000);
    return () => clearInterval(id);
  }, [wantsTiming, status]);

  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !videoRef.current.muted;
      setIsMuted(videoRef.current.muted);
      setSoundChosen(true);
    }
  };

  const turnSoundOn = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = false;
    setIsMuted(false);
    setSoundChosen(true);
    // A tap is the user gesture browsers want before playing sound.
    video.play().catch((err) => console.warn("live-player:play-with-sound-failed", err));
  };

  const togglePause = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch((err) => console.warn("live-player:resume-failed", err));
    } else {
      video.pause();
    }
  };

  // Jump to the live moment: hls.js knows the exact sync point; native HLS
  // (Safari) gets a few seconds back from the newest chunk.
  const goLive = () => {
    const video = videoRef.current;
    if (!video) return;
    const hls = hlsRef.current as { liveSyncPosition?: number | null } | null;
    const sync = hls?.liveSyncPosition;
    if (typeof sync === "number" && Number.isFinite(sync)) {
      video.currentTime = sync;
    } else if (video.seekable.length > 0) {
      const end = video.seekable.end(video.seekable.length - 1);
      video.currentTime = Math.max(video.seekable.start(0), end - LIVE_EDGE_OFFSET_S);
    }
    video.play().catch((err) => console.warn("live-player:go-live-play-failed", err));
    setIsBehind(false);
  };

  const togglePip = async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch (err) {
      console.warn("live-player:pip-failed", err);
    }
  };

  // Pause / picture-in-picture state follows the video element itself, so the
  // browser's own controls (the PiP window's pause, a phone lock screen) stay
  // in step with the buttons.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setPipSupported(
      typeof document !== "undefined" &&
        document.pictureInPictureEnabled === true &&
        typeof video.requestPictureInPicture === "function",
    );
    const onPause = () => setIsPaused(true);
    const onPlay = () => setIsPaused(false);
    const onEnterPip = () => setInPip(true);
    const onLeavePip = () => setInPip(false);
    video.addEventListener("pause", onPause);
    video.addEventListener("play", onPlay);
    video.addEventListener("enterpictureinpicture", onEnterPip);
    video.addEventListener("leavepictureinpicture", onLeavePip);
    return () => {
      video.removeEventListener("pause", onPause);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("enterpictureinpicture", onEnterPip);
      video.removeEventListener("leavepictureinpicture", onLeavePip);
    };
  }, []);

  // How far behind live the picture is, checked once a second while playing.
  useEffect(() => {
    if (status !== "playing") {
      setIsBehind(false);
      return;
    }
    const id = setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      // Also catches a blocked autoplay, which fires no "pause" event.
      setIsPaused(video.paused);
      if (video.seekable.length === 0) return;
      const behind = video.seekable.end(video.seekable.length - 1) - video.currentTime;
      setIsBehind(behind > BEHIND_LIVE_THRESHOLD_S);
    }, 1000);
    return () => clearInterval(id);
  }, [status]);

  const handleRetry = () => {
    setStatus("loading");
    if (videoRef.current) {
      videoRef.current.src = "";
    }
    // Re-run the init effect (re-fetch stream-status + re-attach HLS) instead of
    // a full document reload — the latter at 5k is a thundering-herd self-DoS.
    setRetryNonce((n) => n + 1);
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative flex w-full flex-col overflow-hidden bg-black",
        !isFullscreen && "rounded-lg",
        isFallback && "fixed inset-0 z-50",
      )}
      // Same as the Zoom embed: a pinned box keeps the parent's `space-y-*`
      // sibling margin, which would leave a strip of page showing below it.
      style={isFallback ? { margin: 0 } : undefined}
    >
      {/* Always-visible bar, matching the Zoom embed's (owner, Oct 2, 2026).
          The controls used to appear only on mouse hover, so on a phone the
          viewer could neither unmute (the stream starts muted) nor go full
          screen. Inside the fullscreen box, so the way out is always there. */}
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 bg-zinc-900 px-3 text-white">
        <div className="flex min-w-0 items-center gap-2">
          {status === "playing" && !isBehind && !isPaused && (
            <span className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-red-400">
              <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
              LIVE
            </span>
          )}
          {status === "playing" && (isBehind || isPaused) && (
            <Button
              type="button"
              size="sm"
              onClick={goLive}
              className="h-8 gap-1.5 bg-red-600 text-white hover:bg-red-500"
              title="Jump to the live moment"
            >
              <Radio className="h-4 w-4" />
              <span className="text-xs font-medium">Back to live</span>
            </Button>
          )}
          {sessionName ? <span className="hidden truncate text-sm text-zinc-200 sm:inline">{sessionName}</span> : null}
        </div>
        {/* Labels drop to icons on a phone so the bar never overlaps the
            LIVE badge; each button keeps its title for screen readers. */}
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          {status === "playing" && (
            <Button
              type="button"
              size="sm"
              onClick={togglePause}
              className="h-8 gap-1.5 bg-white/10 text-white hover:bg-white/20"
              aria-pressed={isPaused}
              aria-label={isPaused ? "Play" : "Pause"}
              title={isPaused ? "Play" : "Pause"}
            >
              {isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              <span className="hidden text-xs font-medium sm:inline">{isPaused ? "Play" : "Pause"}</span>
            </Button>
          )}
          {status === "playing" && (
            <Button
              type="button"
              size="sm"
              onClick={toggleMute}
              className={cn(
                "h-8 gap-1.5",
                isMuted
                  ? "bg-white text-zinc-900 hover:bg-zinc-200"
                  : "bg-white/10 text-white hover:bg-white/20",
              )}
              aria-pressed={!isMuted}
              aria-label={isMuted ? "Unmute" : "Mute"}
              title={isMuted ? "Turn the sound on" : "Mute"}
            >
              {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
              <span className="hidden text-xs font-medium sm:inline">{isMuted ? "Unmute" : "Mute"}</span>
            </Button>
          )}
          {status === "playing" && pipSupported && (
            <Button
              type="button"
              size="sm"
              onClick={() => void togglePip()}
              className="h-8 gap-1.5 bg-white/10 text-white hover:bg-white/20"
              aria-pressed={inPip}
              aria-label={inPip ? "Exit mini player" : "Mini player"}
              title={inPip ? "Back to the page" : "Picture in picture: keep watching in a small window"}
            >
              <PictureInPicture2 className="h-4 w-4" />
              <span className="hidden text-xs font-medium md:inline">{inPip ? "Exit mini player" : "Mini player"}</span>
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            onClick={() => void toggleFullscreen()}
            className="h-8 gap-1.5 bg-white/10 text-white hover:bg-white/20"
            aria-pressed={isFullscreen}
            aria-label={isFullscreen ? "Exit full screen" : "Full screen"}
            title={isFullscreen ? "Exit full screen (Esc)" : "Full screen"}
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            <span className="hidden text-xs font-medium sm:inline">{isFullscreen ? "Exit full screen" : "Full screen"}</span>
          </Button>
        </div>
      </div>

      {/* Video element */}
      <video
        ref={videoRef}
        className={cn(
          "w-full object-contain",
          isFullscreen && "min-h-0 flex-1",
          status === "playing" ? "" : "hidden",
        )}
        // On the full-width page a 16:9 picture would be taller than a laptop
        // screen; cap it to the window so the whole picture stays in view.
        style={isFullscreen ? undefined : { minHeight: "400px", maxHeight: "calc(100vh - 8rem)" }}
        muted={isMuted}
        playsInline
        autoPlay
        crossOrigin={measurable ? "anonymous" : undefined}
      />

      {/* Tap for sound: shown over the picture until the viewer chooses. */}
      {status === "playing" && isMuted && !soundChosen && (
        <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
          <Button
            type="button"
            onClick={turnSoundOn}
            className="pointer-events-auto h-11 gap-2 rounded-full bg-white px-5 text-sm font-semibold text-zinc-900 shadow-lg hover:bg-zinc-100"
          >
            <VolumeX className="h-5 w-5" />
            Tap to turn on sound
          </Button>
        </div>
      )}

      {/* Loading state */}
      {status === "loading" && (
        <div className={cn("flex flex-col items-center justify-center min-h-[400px] text-white gap-3", isFullscreen && "flex-1")}>
          <div className="w-12 h-12 rounded-full border-4 border-white/20 border-t-white animate-spin" />
          <p className="text-sm text-white/70">Connecting to stream...</p>
        </div>
      )}

      {/* Offline / waiting state */}
      {status === "offline" && (
        <div className={cn("flex flex-col items-center justify-center min-h-[400px] text-white gap-4", isFullscreen && "flex-1")}>
          <div className="w-16 h-16 rounded-full bg-white/10 flex items-center justify-center">
            <Video className="h-8 w-8 text-white/60" />
          </div>
          <div className="text-center">
            <p className="font-medium">Waiting for stream to start...</p>
            <p className="text-sm text-white/50 mt-1">
              {sessionName ? `"${sessionName}" will appear here when the host starts streaming.` : "The stream will appear here when it goes live."}
            </p>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-white/40">
            <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            Checking every 10 seconds...
          </div>
        </div>
      )}

      {/* Error state */}
      {status === "error" && (
        <div className={cn("flex flex-col items-center justify-center min-h-[400px] text-white gap-4", isFullscreen && "flex-1")}>
          <Video className="h-10 w-10 text-white/50" />
          <p className="text-sm text-white/70">Unable to play the stream</p>
          <Button variant="secondary" size="sm" onClick={handleRetry} className="gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </Button>
        </div>
      )}

    </div>
  );
}
