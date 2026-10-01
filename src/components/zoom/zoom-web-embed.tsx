"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MeetingInfoType, SuspensionViewType, VideoOptions } from "@zoom/meetingsdk/embedded";
import { Loader2, AlertCircle, ExternalLink, Maximize2, Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { loadZoomMtgEmbedded } from "@/lib/zoom/load-embedded-sdk";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { shrinkToFit, type Size } from "@/lib/fullscreen";

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
 * Layout (Oct 1, 2026). The Component View is a floating widget: left alone it
 * draws a 250px ribbon at the top-left of its root and leaves the rest of our
 * 16:9 box black (the Sep 30 practice screenshot in WEBINAR_DEMO_GUIDE shows
 * it). So the embed now owns the box:
 * - a slim bar above the video holds the ONE control we add, Full screen;
 *   Zoom's own header and toolbar stay inside its panel, and the two never
 *   overlap;
 * - the panel starts in speaker view, pinned at the root's top-left, with
 *   drag and resize off (owner: "limit controls for attendees"), and is
 *   sized to the area through `viewSizes` + `updateVideoOptions`. The SDK
 *   keeps its own aspect per view, so we ask for the whole area, measure what
 *   it drew, and shrink the request by the overflow (`shrinkToFit`), then
 *   centre the result. A fresh full-area request follows every area resize,
 *   the fullscreen toggle, and a share starting or stopping;
 * - Full screen is the browser API via `useFullscreen`, with the in-page
 *   fallback for iPhone Safari.
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
  /** Shown on the bar above the video. */
  sessionName?: string;
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

/** Zoom's "Meeting has not started" join refusal: retried, not shown as an error. */
const MEETING_NOT_STARTED = 3008;
const HOST_WAIT_RETRY_MS = 10_000;
/** One hour of 10-second retries, then the error shows as before. */
const HOST_WAIT_MAX_ATTEMPTS = 360;

/**
 * The attendee's panel is boxed, not floating: our box does the sizing, so
 * Zoom's drag handle and resize corner are off. Pinned at the root's top-left
 * so the measured box and the drawn box coincide. Repeated on every size
 * update because `updateVideoOptions` may replace rather than merge.
 */
const ATTENDEE_VIDEO_LOCK: Pick<VideoOptions, "isResizable" | "popper"> = {
  isResizable: false,
  popper: { disableDraggable: true, anchorPosition: { top: 0, left: 0 } },
};

/**
 * Zoom's meeting-info dropdown shows topic and host only. The meeting number,
 * passcode and invite link are left out: the join is gated by registration on
 * our page, and those three are the side door around it.
 */
const ATTENDEE_MEETING_INFO: MeetingInfoType[] = ["topic", "host"];

/**
 * How many shrink steps one fit cycle may take. The SDK's height is linear in
 * the requested width, so the first step lands within a pixel; the cap only
 * guards against an SDK build that sizes differently.
 */
const MAX_FIT_CORRECTIONS = 3;

type LoadState =
  | { phase: "loading" }
  | { phase: "joining" }
  | { phase: "waiting-host" }
  | { phase: "joined" }
  | { phase: "error"; message: string };

export function ZoomWebEmbed({
  // sdkKey stays on the props (the parent gates on it) but is not sent to join.
  signature,
  meetingNumber,
  passcode,
  userName,
  userEmail,
  joinUrl,
  sessionName,
  onLeave,
  onJoinError,
}: ZoomWebEmbedProps) {
  // The fullscreen target: bar + video area.
  const stageRef = useRef<HTMLDivElement>(null);
  // The video area the SDK panel must fit; measured by a ResizeObserver.
  const areaRef = useRef<HTMLDivElement>(null);
  // The SDK's root (`zoomAppRoot`): Zoom renders its panel inside this div.
  const containerRef = useRef<HTMLDivElement>(null);
  // The SDK's module-level client handle. We hold it in a ref so cleanup
  // can call destroyClient() without re-rendering.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clientRef = useRef<any>(null);
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  const areaSizeRef = useRef<Size>({ width: 0, height: 0 });
  const fitRef = useRef<{ requestedWidth: number; corrections: number }>({
    requestedWidth: 0,
    corrections: 0,
  });
  // `updateVideoOptions` is wired to the SDK's store only when the meeting UI
  // mounts on join; before that the 6.0.0 build throws ("w is not a
  // function", seen Oct 1, 2026 in the local harness on every area resize).
  // Until the join, the size travels in `customize.video.viewSizes` at init,
  // and the first refit after joining catches any resize in between (a long
  // "waiting for the host" spell with a fullscreen toggle, for instance).
  const joinedRef = useRef(false);
  // The root's explicit size: the last size requested from the SDK. The SDK
  // draws the panel at exactly the requested width, so the panel fills the
  // root and flex centres the root in the area. Null until the first request,
  // when the root simply fills the area.
  const [rootSize, setRootSize] = useState<Size | null>(null);
  const measureFrameRef = useRef<number | null>(null);
  const measureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest-value refs so the observer effect and the request path can call
  // each other without a dependency cycle or an effect re-run.
  const measurePanelRef = useRef<() => void>(() => {});
  const refitRef = useRef<() => void>(() => {});

  const { isFullscreen, isFallback, toggle: toggleFullscreen } = useFullscreen(stageRef);

  // Pin onLeave in a ref so the mount-once effect can read the latest
  // handler without forcing a re-mount when the parent re-renders.
  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;

  // Same reason as onLeave: a parent that re-creates this handler each render
  // must not tear down and re-mount the SDK, which would drop the attendee out
  // of the meeting.
  const onJoinErrorRef = useRef(onJoinError);
  onJoinErrorRef.current = onJoinError;

  /**
   * Measure on the next frame, never inside an observer callback. The SDK
   * re-renders in a microtask after a request, and a layout change landing
   * inside the same observation loop is what raises the "ResizeObserver loop"
   * window error. Coalesced, so a burst of mutations measures once.
   */
  const scheduleMeasure = useCallback(() => {
    if (measureFrameRef.current !== null) return;
    measureFrameRef.current = requestAnimationFrame(() => {
      measureFrameRef.current = null;
      measurePanelRef.current();
    });
  }, []);

  const requestPanelSize = useCallback(
    (width: number, height: number) => {
      const client = clientRef.current;
      if (!client || !joinedRef.current || width <= 0 || height <= 0) return;
      const size: Size = { width: Math.round(width), height: Math.round(height) };
      setRootSize((prev) =>
        prev && prev.width === size.width && prev.height === size.height ? prev : size,
      );
      try {
        client.updateVideoOptions({ ...ATTENDEE_VIDEO_LOCK, viewSizes: { default: size } });
      } catch (err) {
        // The panel keeps its last size; the attendee still has a working
        // player, just not a fitted one.
        console.warn("zoom-embed:resize-failed", err);
      }
      // The SDK applies the size asynchronously. The mutation observer below
      // normally catches it; this is the belt for an SDK build whose update
      // touches nothing the observer watches.
      if (measureTimerRef.current) clearTimeout(measureTimerRef.current);
      measureTimerRef.current = setTimeout(scheduleMeasure, 400);
    },
    [scheduleMeasure],
  );

  /** Start a fit cycle: ask for the whole area, then let `measurePanel` shrink. */
  const refit = useCallback(() => {
    const area = areaSizeRef.current;
    if (area.width <= 0 || area.height <= 0) return;
    fitRef.current = { requestedWidth: area.width, corrections: 0 };
    requestPanelSize(area.width, area.height);
  }, [requestPanelSize]);
  refitRef.current = refit;

  /**
   * Compare what the SDK drew with the area. The panel is absolutely
   * positioned at the root's top-left and the root is its containing block,
   * so anything drawn beyond the root shows up in the root's scroll extent
   * however the SDK nests its DOM (a zero-height wrapper or a popper node in
   * between changes nothing). The root is sized to the last request, so the
   * SDK can only match it or overflow it.
   */
  const measurePanel = useCallback(() => {
    const root = containerRef.current;
    if (!root || !joinedRef.current) return;
    const drawn: Size = { width: root.scrollWidth, height: root.scrollHeight };
    const fit = fitRef.current;
    if (fit.corrections >= MAX_FIT_CORRECTIONS) return;
    const next = shrinkToFit(fit.requestedWidth, drawn, areaSizeRef.current);
    if (next === null) return;
    fit.requestedWidth = next;
    fit.corrections += 1;
    requestPanelSize(next, areaSizeRef.current.height);
  }, [requestPanelSize]);
  measurePanelRef.current = measurePanel;

  // Watch the area (our box) and the SDK's drawing (the root's subtree).
  useEffect(() => {
    const area = areaRef.current;
    const root = containerRef.current;
    if (!area || !root) return;

    const areaObserver = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      areaSizeRef.current = { width: rect.width, height: rect.height };
      // Off the observer's own tick, for the reason given on scheduleMeasure.
      requestAnimationFrame(() => refitRef.current());
    });
    areaObserver.observe(area);

    // The SDK sets its panel's size as inline style, so any style change in
    // the subtree (and the panel's first appearance) measures on the next
    // frame. One observer on the root, nothing per child, nothing to unobserve.
    const sdkObserver = new MutationObserver(() => scheduleMeasure());
    sdkObserver.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["style"],
    });

    return () => {
      areaObserver.disconnect();
      sdkObserver.disconnect();
      if (measureFrameRef.current !== null) cancelAnimationFrame(measureFrameRef.current);
      if (measureTimerRef.current) clearTimeout(measureTimerRef.current);
    };
  }, [scheduleMeasure]);

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

        // A share starting or stopping changes the SDK's panel aspect (the
        // shared content stacks above the speaker strip), so refit from the
        // full area either way: shrink on start, grow back on stop.
        try {
          client.on("peer-share-state-change", () => refit());
        } catch {
          // Best effort: without it the panel still fits, just not maximally
          // after a share ends.
        }

        const area = areaSizeRef.current;
        const video: VideoOptions = {
          ...ATTENDEE_VIDEO_LOCK,
          // Speaker view: the active speaker, or the shared slides, fills the
          // panel. Zoom's own default for an attendee is the 250px ribbon.
          // The SDK types this as a const enum, which a type-only import
          // cannot reference at runtime; the string is the enum's value.
          defaultViewType: "speaker" as unknown as SuspensionViewType,
          ...(area.width > 0 && area.height > 0
            ? {
                viewSizes: {
                  default: { width: Math.round(area.width), height: Math.round(area.height) },
                },
              }
            : {}),
        };
        fitRef.current = { requestedWidth: area.width, corrections: 0 };

        await client.init({
          zoomAppRoot: containerRef.current,
          language: "en-US",
          patchJsMedia: true,
          leaveOnPageUnload: true,
          customize: {
            meetingInfo: [...ATTENDEE_MEETING_INFO],
            video,
          },
          // Asset path defaults to https://source.zoom.us/{version}/lib/av
          // which works in prod. Override via env if we ever self-host the
          // WASM/audio assets.
        });

        if (cancelled) return;
        reachedPhase = "joining";
        setState({ phase: "joining" });

        // Zoom refuses a join with 3008 "Meeting has not started" until the
        // host starts it in Zoom. A producer can open our room first (Sep 30,
        // 2026: seen in the practice run), so rather than showing an error the
        // attendee waits here and we retry quietly. Any other failure throws
        // to the catch below as before.
        for (let attempt = 0; ; attempt++) {
          try {
            // No sdkKey here: the SDK removed it from joinOptions in v4 and
            // warns when it is passed; the key travels inside the signature.
            await client.join({
              signature,
              meetingNumber,
              password: passcode || "",
              userName,
              userEmail: userEmail || "",
            });
            break;
          } catch (joinErr) {
            const waitingForHost =
              extractZoomErrorCode(joinErr) === MEETING_NOT_STARTED && attempt < HOST_WAIT_MAX_ATTEMPTS;
            if (!waitingForHost || cancelled) throw joinErr;
            setState({ phase: "waiting-host" });
            await new Promise((resolve) => setTimeout(resolve, HOST_WAIT_RETRY_MS));
            if (cancelled) return;
          }
        }

        if (cancelled) return;
        reachedPhase = "joined";
        setState({ phase: "joined" });
        // The panel exists now; size it to the area it landed in.
        joinedRef.current = true;
        refit();
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
      joinedRef.current = false;
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
    <div
      ref={stageRef}
      data-zoom-embed-stage="true"
      className={cn(
        "relative w-full bg-black overflow-hidden flex flex-col",
        !isFullscreen && "rounded-lg",
        isFallback && "fixed inset-0 z-50",
      )}
      // A pinned `inset-0` box with auto height still honours a sibling
      // margin from the parent's `space-y-*`, which would leave a strip of
      // page showing below the player.
      style={isFallback ? { margin: 0 } : undefined}
    >
      {/* Our bar. The one place for controls we add, kept clear of Zoom's
          header and toolbar, which live inside its panel below. */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 bg-zinc-900 px-3 text-white">
        <div className="flex min-w-0 items-center gap-2">
          {state.phase === "joined" ? (
            <span className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-red-400">
              <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
              LIVE
            </span>
          ) : null}
          {sessionName ? (
            <span className="truncate text-sm text-zinc-200">{sessionName}</span>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void toggleFullscreen()}
          className="h-8 gap-1.5 text-white hover:bg-white/15 hover:text-white"
          aria-pressed={isFullscreen}
          title={isFullscreen ? "Exit full screen (Esc)" : "Full screen"}
        >
          {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          <span className="text-xs">{isFullscreen ? "Exit full screen" : "Full screen"}</span>
        </Button>
      </div>

      {/* The video area: 16:9 on the page (taller on phones, where a 16:9
          strip is unusable), the rest of the screen in fullscreen. The SDK's
          root is sized to the fitted request and centred, so the panel sits
          in the middle with black at the sides when its aspect is narrower. */}
      <div
        ref={areaRef}
        className={cn(
          "relative flex w-full items-center justify-center overflow-hidden",
          isFullscreen ? "min-h-0 flex-1" : "aspect-[4/5] sm:aspect-video",
        )}
      >
        <div
          ref={containerRef}
          data-zoom-embed-root="true"
          className="relative"
          style={{
            width: rootSize?.width ?? "100%",
            height: rootSize?.height ?? "100%",
          }}
        />

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

        {state.phase === "waiting-host" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 text-white p-6 text-center">
            <Loader2 className="h-8 w-8 animate-spin" />
            <p className="text-sm font-medium">Waiting for the host to start the webinar</p>
            <p className="text-xs text-gray-300 max-w-md">
              Keep this page open. You&apos;ll join automatically as soon as it starts.
            </p>
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
