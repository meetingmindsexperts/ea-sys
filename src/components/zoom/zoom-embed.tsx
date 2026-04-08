"use client";

import { useState } from "react";
import { Video, ExternalLink, Maximize2, Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ZoomEmbedProps {
  sdkKey?: string;
  signature?: string;
  meetingNumber: string;
  passcode: string;
  userName?: string;
  joinUrl: string;
}

export function ZoomEmbed({
  meetingNumber,
  passcode,
  joinUrl,
}: ZoomEmbedProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Use Zoom's web client URL for iframe embedding
  // This avoids the React version conflict with @zoom/meetingsdk
  const zoomWebUrl = `https://zoom.us/wc/join/${meetingNumber}${passcode ? `?pwd=${encodeURIComponent(passcode)}` : ""}`;

  return (
    <div className={`relative w-full ${isFullscreen ? "fixed inset-0 z-50 bg-background" : ""}`}>
      <div className="absolute top-2 right-2 z-10 flex gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          className="h-7 gap-1 text-xs shadow-md"
          onClick={() => setIsFullscreen(!isFullscreen)}
        >
          {isFullscreen ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
          {isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="h-7 gap-1 text-xs shadow-md"
          onClick={() => window.open(joinUrl, "_blank")}
        >
          <ExternalLink className="h-3 w-3" />
          Zoom App
        </Button>
      </div>

      <iframe
        src={zoomWebUrl}
        className={`w-full rounded-lg border-0 ${isFullscreen ? "h-full" : "min-h-[600px]"}`}
        allow="camera; microphone; display-capture; autoplay; clipboard-write; fullscreen"
        sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-downloads allow-popups-to-escape-sandbox"
        title="Zoom Meeting"
      />

      <noscript>
        <div className="flex flex-col items-center justify-center gap-4 rounded-lg border bg-muted/30 p-8">
          <Video className="h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">JavaScript is required to join this meeting.</p>
          <a href={joinUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline">
            Open in Zoom App
          </a>
        </div>
      </noscript>
    </div>
  );
}
