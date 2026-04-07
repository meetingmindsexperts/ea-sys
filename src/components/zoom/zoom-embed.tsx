"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Video, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ZoomEmbedProps {
  sdkKey: string;
  signature: string;
  meetingNumber: string;
  passcode: string;
  userName?: string;
  joinUrl: string; // fallback
}

export function ZoomEmbed({
  sdkKey,
  signature,
  meetingNumber,
  passcode,
  userName = "Attendee",
  joinUrl,
}: ZoomEmbedProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "joined" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const clientRef = useRef<unknown>(null);

  useEffect(() => {
    let mounted = true;

    async function initZoom() {
      try {
        // Dynamic import — @zoom/meetingsdk/embedded is only loaded on this page
        const ZoomMtgEmbedded = (await import("@zoom/meetingsdk/embedded")).default;

        if (!mounted || !containerRef.current) return;

        const client = ZoomMtgEmbedded.createClient();
        clientRef.current = client;

        const meetingSDKElement = containerRef.current;

        await client.init({
          zoomAppRoot: meetingSDKElement,
          language: "en-US",
          patchJsMedia: true,
        });

        await client.join({
          sdkKey,
          signature,
          meetingNumber,
          password: passcode,
          userName,
          tk: "",
        });

        if (mounted) setStatus("joined");
      } catch (err) {
        console.error("Zoom SDK init error:", err);
        if (mounted) {
          setStatus("error");
          setErrorMessage(err instanceof Error ? err.message : "Failed to initialize Zoom");
        }
      }
    }

    initZoom();

    return () => {
      mounted = false;
      // Clean up Zoom client
      if (clientRef.current && typeof (clientRef.current as { destroy?: () => void }).destroy === "function") {
        try {
          (clientRef.current as { destroy: () => void }).destroy();
        } catch {
          // ignore cleanup errors
        }
      }
    };
  }, [sdkKey, signature, meetingNumber, passcode, userName]);

  if (status === "error") {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-lg border bg-muted/30 p-8">
        <Video className="h-10 w-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {errorMessage || "Unable to load the embedded meeting."}
        </p>
        <Button
          variant="outline"
          onClick={() => window.open(joinUrl, "_blank")}
          className="gap-2"
        >
          Open in Zoom App
          <ExternalLink className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="relative w-full">
      {status === "loading" && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 rounded-lg">
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
            <p className="text-sm text-muted-foreground">Connecting to Zoom...</p>
          </div>
        </div>
      )}
      <div
        ref={containerRef}
        className="w-full min-h-[500px] rounded-lg overflow-hidden"
      />
    </div>
  );
}
