"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Video, Maximize2, Minimize2, Volume2, VolumeX, RefreshCw } from "lucide-react";

interface LivePlayerProps {
  hlsUrl: string;
  slug: string;
  sessionId: string;
  posterImage?: string;
  sessionName?: string;
  onStreamStatusChange?: (status: "active" | "idle" | "ended") => void;
}

export function LivePlayer({
  hlsUrl,
  slug,
  sessionId,
  sessionName,
  onStreamStatusChange,
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
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

      // Safari has native HLS support
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
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
      }
    };
  }, [hlsUrl, slug, sessionId, pollStreamStatus, retryNonce]);

  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !videoRef.current.muted;
      setIsMuted(videoRef.current.muted);
    }
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
      setIsFullscreen(false);
    } else {
      containerRef.current.requestFullscreen();
      setIsFullscreen(true);
    }
  };

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
    <div ref={containerRef} className="relative w-full rounded-lg overflow-hidden bg-black">
      {/* Video element */}
      <video
        ref={videoRef}
        className={`w-full ${status === "playing" ? "" : "hidden"}`}
        style={{ minHeight: "400px" }}
        muted={isMuted}
        playsInline
        autoPlay
      />

      {/* Loading state */}
      {status === "loading" && (
        <div className="flex flex-col items-center justify-center min-h-[400px] text-white gap-3">
          <div className="w-12 h-12 rounded-full border-4 border-white/20 border-t-white animate-spin" />
          <p className="text-sm text-white/70">Connecting to stream...</p>
        </div>
      )}

      {/* Offline / waiting state */}
      {status === "offline" && (
        <div className="flex flex-col items-center justify-center min-h-[400px] text-white gap-4">
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
        <div className="flex flex-col items-center justify-center min-h-[400px] text-white gap-4">
          <Video className="h-10 w-10 text-white/50" />
          <p className="text-sm text-white/70">Unable to play the stream</p>
          <Button variant="secondary" size="sm" onClick={handleRetry} className="gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </Button>
        </div>
      )}

      {/* Controls overlay (when playing) */}
      {status === "playing" && (
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-3 flex items-center justify-between opacity-0 hover:opacity-100 transition-opacity">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={toggleMute} className="text-white hover:bg-white/20 h-8 w-8 p-0">
              {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </Button>
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-xs text-white font-medium">LIVE</span>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={toggleFullscreen} className="text-white hover:bg-white/20 h-8 w-8 p-0">
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
        </div>
      )}
    </div>
  );
}
