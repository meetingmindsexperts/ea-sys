"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, AlertCircle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Zoom Meeting SDK — Component View embed.
 *
 * Uses @zoom/meetingsdk/embedded, which is a UMD bundle that ships its own
 * React 18 runtime internally. That bundled React lives inside the SDK's
 * DOM subtree and never interacts with our app's React 19 — that's why
 * Component View works where Client View doesn't.
 *
 * Key lifecycle notes:
 * - `createClient()` returns a module-level singleton. Re-mounting must
 *   call `destroyClient()` first, otherwise init throws.
 * - The SDK bundle (~3 MB gzipped + WASM assets loaded from source.zoom.us)
 *   must only hit the browser of users who actually open a webinar. This
 *   component is safe to import normally, but callers should still wrap
 *   it in `next/dynamic({ ssr: false })` so the bundle doesn't land in
 *   the server build or on unrelated pages.
 * - Dev-mode StrictMode double-invoke is handled by `destroyOnUnmount` in
 *   cleanup; the second effect run will see the old client already gone.
 */

interface ZoomWebEmbedProps {
  sdkKey: string;
  signature: string;
  meetingNumber: string;
  passcode: string;
  userName: string;
  userEmail?: string;
  joinUrl: string;
  onLeave?: () => void;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "joining" }
  | { phase: "joined" }
  | { phase: "error"; message: string };

export function ZoomWebEmbed({
  sdkKey,
  signature,
  meetingNumber,
  passcode,
  userName,
  userEmail,
  joinUrl,
  onLeave,
}: ZoomWebEmbedProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The SDK's module-level client handle. We hold it in a ref so cleanup
  // can call destroyClient() without re-rendering.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clientRef = useRef<any>(null);
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function mount() {
      if (!containerRef.current) return;

      try {
        // Dynamic import keeps the 3 MB+ SDK bundle out of the page's
        // initial chunk. Top-level await would pull it into every build.
        const ZoomMtgEmbedded = (await import("@zoom/meetingsdk/embedded"))
          .default;
        if (cancelled) return;

        // Tear down any previous instance. Safe to call even if one
        // doesn't exist — the SDK is defensive about double-destroy.
        try {
          ZoomMtgEmbedded.destroyClient();
        } catch {
          // First mount has nothing to destroy; ignore.
        }

        const client = ZoomMtgEmbedded.createClient();
        clientRef.current = client;

        await client.init({
          zoomAppRoot: containerRef.current,
          language: "en-US",
          patchJsMedia: true,
          leaveOnPageUnload: true,
          // Asset path defaults to https://source.zoom.us/{version}/lib/av
          // which works in prod. Override via env if we ever self-host the
          // WASM/audio assets.
        });

        if (cancelled) return;
        setState({ phase: "joining" });

        await client.join({
          sdkKey,
          signature,
          meetingNumber,
          password: passcode || "",
          userName,
          userEmail: userEmail || "",
        });

        if (cancelled) return;
        setState({ phase: "joined" });
      } catch (err) {
        if (cancelled) return;
        const message = extractZoomErrorMessage(err);
        setState({ phase: "error", message });
        // Log to console for dev visibility; production Sentry picks it up
        // via the app's existing instrumentation.
        console.error("ZoomWebEmbed failed to mount", err);
      }
    }

    mount();

    return () => {
      cancelled = true;
      // Tell the SDK we're leaving so it closes the AV stream cleanly.
      // Wrapped because leaveMeeting rejects if the client was never
      // joined (e.g. init failed) — in that case, just destroy.
      (async () => {
        try {
          if (clientRef.current) {
            try {
              await clientRef.current.leaveMeeting();
            } catch {
              // Swallow — either never joined or already left.
            }
          }
          // Dynamic import again because destroyClient is a module-level
          // method. The second import is cached from the first, so it's
          // cheap.
          const ZoomMtgEmbedded = (await import("@zoom/meetingsdk/embedded"))
            .default;
          try {
            ZoomMtgEmbedded.destroyClient();
          } catch {
            // Ignore — maybe already destroyed.
          }
        } finally {
          clientRef.current = null;
        }
      })();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Intentionally mount-once — prop changes would require a full
  // remount anyway (Zoom client can't rejoin a different meeting).

  // Notify parent when the user leaves the meeting. The SDK emits a
  // 'connection-change' event with state === 'Closed' which we could
  // hook into, but a simpler approach is: the parent unmounts this
  // component when the user clicks a dismiss button, so onLeave isn't
  // called from inside here today. Kept in the prop list for future wiring.
  void onLeave;

  return (
    <div className="relative w-full bg-black rounded-lg overflow-hidden">
      {/* Fixed 16:9 container — the SDK mounts its own UI into this div */}
      <div className="aspect-video w-full">
        <div
          ref={containerRef}
          className="w-full h-full"
          data-zoom-embed-root="true"
        />
      </div>

      {/* Overlay states — rendered above the SDK container */}
      {state.phase === "loading" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 text-white">
          <Loader2 className="h-8 w-8 animate-spin" />
          <p className="text-sm">Loading Zoom…</p>
        </div>
      )}

      {state.phase === "joining" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 text-white">
          <Loader2 className="h-8 w-8 animate-spin" />
          <p className="text-sm">Joining the webinar…</p>
        </div>
      )}

      {state.phase === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/90 text-white p-6">
          <AlertCircle className="h-10 w-10 text-red-400" />
          <p className="text-sm font-medium">Couldn&apos;t load the embedded meeting</p>
          <p className="text-xs text-gray-300 text-center max-w-md">
            {state.message}
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => window.open(joinUrl, "_blank", "noopener,noreferrer")}
          >
            <ExternalLink className="h-4 w-4 mr-2" />
            Open in Zoom app instead
          </Button>
        </div>
      )}
    </div>
  );
}

function extractZoomErrorMessage(err: unknown): string {
  if (!err) return "Unknown error";
  if (err instanceof Error) return err.message;
  if (typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.reason === "string") return obj.reason;
    if (typeof obj.errorMessage === "string") return obj.errorMessage;
    if (typeof obj.message === "string") return obj.message;
  }
  return String(err);
}
