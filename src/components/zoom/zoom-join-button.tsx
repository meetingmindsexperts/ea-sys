"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Video, ExternalLink, Loader2 } from "lucide-react";

interface ZoomJoinButtonProps {
  slug: string;
  sessionId: string;
  startTime: string;
  endTime: string;
  sessionStatus?: string;
}

const JOINABLE_BEFORE_MS = 15 * 60 * 1000;

export function ZoomJoinButton({ slug, sessionId, startTime, endTime, sessionStatus }: ZoomJoinButtonProps) {
  const [joinInfo, setJoinInfo] = useState<{
    mode: "sdk" | "url";
    joinUrl: string;
    passcode?: string;
    sdkKey?: string;
    signature?: string;
    meetingNumber?: string;
    sessionName?: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [isJoinable, setIsJoinable] = useState(false);

  // Check if session is joinable (LIVE or starts within 15 min)
  useEffect(() => {
    const check = () => {
      const now = Date.now();
      const start = new Date(startTime).getTime();
      const end = new Date(endTime).getTime();
      const live = sessionStatus === "LIVE" || (now >= start && now <= end);
      const upcoming = start - now <= JOINABLE_BEFORE_MS && start > now;
      setIsJoinable(live || upcoming);
    };

    check();
    const interval = setInterval(check, 30_000); // re-check every 30s
    return () => clearInterval(interval);
  }, [startTime, endTime, sessionStatus]);

  if (!isJoinable) return null;

  const handleJoin = async () => {
    if (joinInfo) {
      // Already have join info — open in new tab or navigate to embed page
      if (joinInfo.mode === "sdk") {
        window.open(`/e/${slug}/session/${sessionId}`, "_blank");
      } else {
        window.open(joinInfo.joinUrl, "_blank");
      }
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/public/events/${slug}/sessions/${sessionId}/zoom-join`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Cannot join yet");
      }
      const data = await res.json();
      setJoinInfo(data);

      if (data.mode === "sdk") {
        window.open(`/e/${slug}/session/${sessionId}`, "_blank");
      } else {
        window.open(data.joinUrl, "_blank");
      }
    } catch (err) {
      console.error("Failed to get join info:", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      size="sm"
      className="gap-1.5 bg-blue-600 hover:bg-blue-700 text-white"
      onClick={handleJoin}
      disabled={loading}
    >
      {loading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Video className="h-3.5 w-3.5" />
      )}
      Join
      <ExternalLink className="h-3 w-3" />
    </Button>
  );
}
