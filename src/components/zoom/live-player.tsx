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
  const [status, setStatus] = useState<"loading" | "playing" | "offline" | "error">("loading");
  const [isMuted, setIsMuted] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

    async function initPlayer() {
      const video = videoRef.current;
      if (!video) return;

      // Check if stream is live first
      const streamData = await pollStreamStatus();
      if (!mounted) return;

      if (!streamData || streamData.status !== "active") {
        setStatus("offline");
        onStreamStatusChange?.("idle");

        // Poll every 10s until stream goes live
        pollInterval = setInterval(async () => {
          const data = await pollStreamStatus();
          if (!mounted) return;
          if (data?.status === "active" && data.hlsUrl) {
            clearInterval(pollInterval);
            loadHls(data.hlsUrl);
          }
        }, 10_000);
        return;
      }

      loadHls(streamData.hlsUrl || hlsUrl);
    }

    async function loadHls(url: string) {
      const video = videoRef.current;
      if (!video || !mounted) return;

      // Safari has native HLS support
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = url;
        video.addEventListener("loadedmetadata", () => {
          if (mounted) {
            setStatus("playing");
            onStreamStatusChange?.("active");
            video.play().catch(() => {});
          }
        });
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
            onStreamStatusChange?.("active");
            video.play().catch(() => {});
          }
        });

        hls.on(Hls.Events.ERROR, (_event: unknown, data: { fatal?: boolean; type?: string }) => {
          if (data.fatal && mounted) {
            setStatus("offline");
            onStreamStatusChange?.("ended");
            hls.destroy();
            // Start polling again
            pollInterval = setInterval(async () => {
              const streamData = await pollStreamStatus();
              if (!mounted) return;
              if (streamData?.status === "active" && streamData.hlsUrl) {
                clearInterval(pollInterval);
                loadHls(streamData.hlsUrl);
              }
            }, 10_000);
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
  }, [hlsUrl, slug, sessionId, pollStreamStatus, onStreamStatusChange]);

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
    // Re-trigger the effect by toggling a state
    window.location.reload();
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
