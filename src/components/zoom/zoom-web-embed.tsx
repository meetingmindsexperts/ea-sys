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
 * - StrictMode double-invoke is handled via a module-level destroy promise
 *   (`pendingDestroy`) that subsequent mounts await before creating a new
 *   client. Without this, cleanup 1's async destroy could race cleanup 2's
 *   createClient and leave a dangling client handle.
 * - The SDK's `connection-change` event is our source of truth for when
 *   the user clicks Zoom's in-meeting Leave button. We call `onLeave`
 *   when state becomes `Closed` so the parent can unmount this component.
 */

// Module-level handle to the destroy in flight. Subsequent mounts await
// this before creating a new client, so StrictMode's double-invoke can't
// end up with cleanup-1 destroying effect-2's freshly-created client.
let pendingDestroy: Promise<void> | null = null;

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

  // Pin onLeave in a ref so the mount-once effect can read the latest
  // handler without forcing a re-mount when the parent re-renders.
  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;

  useEffect(() => {
    let cancelled = false;

    async function mount() {
      if (!containerRef.current) return;

      try {
        // Wait for any in-flight destroy from a previous mount (StrictMode
        // double-invoke). Without this, cleanup 1's async destroy could
        // race against effect 2's createClient → init.
        if (pendingDestroy) {
          try {
            await pendingDestroy;
          } catch {
            // Ignore — pending destroy errors shouldn't block a fresh mount.
          }
        }
        if (cancelled) return;

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

        // Subscribe to connection-change so we can tell the parent when
        // the user clicks Zoom's in-meeting Leave button. Without this,
        // the embed would tear itself down internally while the parent
        // still thought `isJoining === true`, leaving a black box.
        try {
          client.on("connection-change", (payload: { state?: string }) => {
            if (payload?.state === "Closed") {
              onLeaveRef.current?.();
            }
          });
        } catch {
          // Older SDK builds may throw here; ignore — the parent can still
          // unmount via its own Leave button.
        }

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
      // Serialized through the module-level pendingDestroy promise so
      // StrictMode's re-mount doesn't race this cleanup.
      pendingDestroy = (async () => {
        try {
          if (clientRef.current) {
            try {
              await clientRef.current.leaveMeeting();
            } catch {
              // Swallow — either never joined or already left.
            }
          }
          const ZoomMtgEmbedded = (await import("@zoom/meetingsdk/embedded"))
            .default;
          try {
            ZoomMtgEmbedded.destroyClient();
          } catch {
            // Ignore — maybe already destroyed.
          }
        } finally {
          clientRef.current = null;
          // Clear the shared handle so future mounts don't block on a
          // resolved promise forever (micro-task overhead is negligible,
          // but tidy).
          pendingDestroy = null;
        }
      })();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Intentionally mount-once — prop changes would require a full
  // remount anyway (Zoom client can't rejoin a different meeting).

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
          {joinUrl ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.open(joinUrl, "_blank", "noopener,noreferrer")}
            >
              <ExternalLink className="h-4 w-4 mr-2" />
              Open in Zoom app instead
            </Button>
          ) : null}
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
