"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, AlertCircle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { loadZoomMtgEmbedded } from "@/lib/zoom/load-embedded-sdk";

/**
 * Zoom Meeting SDK — Component View embed.
 *
 * The SDK runtime is obtained via `loadZoomMtgEmbedded()` (see
 * src/lib/zoom/load-embedded-sdk.ts). By default it loads from Zoom's CDN with
 * the SDK's OWN React 18 as isolated browser globals — because the npm
 * `/embedded` bundle externalizes React and would otherwise resolve to our
 * React 19 and crash on the removed `ReactCurrentOwner` internal. The npm-import
 * path is kept behind `NEXT_PUBLIC_ZOOM_EMBED_LOADER=npm` for an easy flip-back
 * once Zoom ships a React-19-compatible SDK. Client View remains unsupported.
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
  /**
   * Called when the embed fails to mount or join. The failure happens entirely
   * inside the browser, so without this it reaches no log we can read: the
   * server already answered 200 with a signature. The page owns the reporting
   * because this component knows nothing about routes; see the public session
   * page for the one consumer.
   */
  onJoinError?: (detail: {
    phase: "loading" | "joining" | "joined" | "unknown";
    message: string;
    errorCode?: string | number;
  }) => void;
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
  onJoinError,
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

  // Same reason as onLeave: a parent that re-creates this handler each render
  // must not tear down and re-mount the SDK, which would drop the attendee out
  // of the meeting.
  const onJoinErrorRef = useRef(onJoinError);
  onJoinErrorRef.current = onJoinError;

  useEffect(() => {
    let cancelled = false;

    async function mount() {
      if (!containerRef.current) return;

      // Which step we reached, so a failure report says whether the SDK failed
      // to LOAD (CDN blocked, React incompatibility) or failed to JOIN (bad
      // signature, domain not allowlisted). Those point at different fixes, and
      // the thrown error alone rarely distinguishes them.
      let reachedPhase: "loading" | "joining" | "joined" = "loading";

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

        // Loads the SDK lazily (CDN by default — keeps the ~3 MB bundle off the
        // page's initial chunk AND isolates the SDK's React 18 from our React 19).
        const ZoomMtgEmbedded = await loadZoomMtgEmbedded();
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
        reachedPhase = "joining";
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
        reachedPhase = "joined";
        setState({ phase: "joined" });
      } catch (err) {
        if (cancelled) return;
        const message = extractZoomErrorMessage(err);
        setState({ phase: "error", message });
        // Log to console for dev visibility; production Sentry picks it up
        // via the app's existing instrumentation.
        console.error("ZoomWebEmbed failed to mount", err);
        // Report it somewhere we can actually read. Until this existed, the
        // server logged a clean 200 with a signature and the attendee saw a
        // dead player, so "the webinar will not join" had no server-side trace
        // at all. Never allowed to throw: the attendee is already looking at a
        // broken join and a failing report would only replace one error with
        // another.
        try {
          onJoinErrorRef.current?.({
            phase: reachedPhase,
            message,
            errorCode: extractZoomErrorCode(err),
          });
        } catch {
          // Reporting is best-effort by contract.
        }
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
          const ZoomMtgEmbedded = await loadZoomMtgEmbedded();
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

/**
 * Zoom's numeric errorCode, when the SDK supplies one.
 *
 * Worth carrying separately from the message because the code is the stable
 * part: Zoom's human-readable text varies across SDK versions, while the code
 * is what their documentation is indexed by. Extracted defensively because the
 * SDK rejects with a plain object, not an Error.
 */
function extractZoomErrorCode(err: unknown): string | number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const obj = err as Record<string, unknown>;
  const code = obj.errorCode ?? obj.type ?? obj.code;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
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
