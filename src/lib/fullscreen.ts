/**
 * Fullscreen helpers shared by the webinar players (the Zoom Component View
 * embed and the HLS live player).
 *
 * Pure by design: nothing here touches React, and the DOM comes in as
 * arguments, so the browser-API resolution and the panel-fit arithmetic are
 * unit-tested in node (`__tests__/lib/fullscreen.test.ts`). The React side is
 * `src/hooks/use-fullscreen.ts`.
 */

export interface Size {
  width: number;
  height: number;
}

export interface FullscreenApi {
  request: () => Promise<void>;
  exit: () => Promise<void>;
  /** The element currently fullscreen, standard or WebKit-prefixed. */
  current: () => Element | null;
}

type PrefixedElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type PrefixedDocument = Document & {
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
};

function requestFullscreenFn(pel: PrefixedElement) {
  if (typeof pel.requestFullscreen === "function") return () => pel.requestFullscreen();
  if (typeof pel.webkitRequestFullscreen === "function") return () => pel.webkitRequestFullscreen?.();
  return null;
}

function exitFullscreenFn(pdoc: PrefixedDocument) {
  if (typeof pdoc.exitFullscreen === "function") return () => pdoc.exitFullscreen();
  if (typeof pdoc.webkitExitFullscreen === "function") return () => pdoc.webkitExitFullscreen?.();
  return null;
}

/**
 * The Fullscreen API for `el`, or null when this browser cannot make an
 * element fullscreen (iPhone Safari exposes it only on `<video>`, and a
 * Permissions-Policy can switch it off). Callers fall back to pinning the
 * element to the viewport themselves.
 */
export function resolveFullscreenApi(
  el: HTMLElement,
  doc: Document = el.ownerDocument,
): FullscreenApi | null {
  const pel = el as PrefixedElement;
  const pdoc = doc as PrefixedDocument;

  if (doc.fullscreenEnabled === false && pdoc.webkitFullscreenEnabled !== true) return null;

  const request = requestFullscreenFn(pel);
  if (!request) return null;

  const exit = exitFullscreenFn(pdoc);
  if (!exit) return null;

  return {
    request: async () => {
      await request();
    },
    exit: async () => {
      await exit();
    },
    current: () => doc.fullscreenElement ?? pdoc.webkitFullscreenElement ?? null,
  };
}

type WebkitVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitSupportsFullscreen?: boolean;
  webkitDisplayingFullscreen?: boolean;
};

export interface VideoFullscreenApi {
  enter: () => void;
  exit: () => void;
  /** The video is in Apple's own full screen player now. */
  active: () => boolean;
}

/**
 * Apple's own full screen video player, for a browser that cannot make an
 * element fullscreen (iPhone Safari; Nov 24, 2026, owner: "mobile full screen
 * can be improved"). It is the only true full screen an iPhone offers a web
 * page: it hides Safari's bars and turns sideways with the phone, where the
 * in-page fallback is a black box under the address bar. Null until the video
 * has something to show, so a player that is waiting, reconnecting or failed
 * falls back to the in-page box, where its message can be read. The browser's
 * own flag is not enough for that (review of 9dc1aae07): it can be true for a
 * video that has a source and no picture, and Apple's player would open black.
 */
export function resolveVideoFullscreen(video: HTMLVideoElement | null): VideoFullscreenApi | null {
  const v = video as WebkitVideo | null;
  if (!v || typeof v.webkitEnterFullscreen !== "function" || v.webkitSupportsFullscreen !== true) return null;
  if (v.readyState < 1 || v.error) return null;
  return {
    enter: () => v.webkitEnterFullscreen?.(),
    exit: () => v.webkitExitFullscreen?.(),
    active: () => v.webkitDisplayingFullscreen === true,
  };
}

/**
 * Turn a phone sideways for a 16:9 picture, once the player is fullscreen
 * (browsers allow the lock only then). Touch screens only: a desktop refuses
 * the lock, and asking there would only log a refusal on every click. Answers
 * whether the lock took; a refusal (Safari on iPad, a policy) is not an error,
 * the picture is simply shown the way the device is held.
 */
export async function lockLandscape(win: Window): Promise<boolean> {
  const orientation = win.screen?.orientation as (ScreenOrientation & { lock?: (o: string) => Promise<void> }) | undefined;
  if (!orientation || typeof orientation.lock !== "function") return false;
  if (!win.matchMedia?.("(pointer: coarse)").matches) return false;
  try {
    await orientation.lock("landscape");
    return true;
  } catch (err) {
    console.info("fullscreen:orientation-lock-refused", err instanceof Error ? err.name : err);
    return false;
  }
}

/** Undo `lockLandscape`. Leaving fullscreen releases the lock anyway; this covers a browser that does not. */
export function unlockOrientation(win: Window): void {
  const orientation = win.screen?.orientation as (ScreenOrientation & { unlock?: () => void }) | undefined;
  try {
    orientation?.unlock?.();
  } catch (err) {
    console.info("fullscreen:orientation-unlock-failed", err instanceof Error ? err.name : err);
  }
}

/**
 * Stop the page behind an in-page fullscreen fallback from scrolling, and
 * return the function that undoes it.
 *
 * `overflow: hidden` on the document is not enough: iOS Safari ignores it for
 * touch scrolling, and iPhone Safari is the one platform the fallback exists
 * for. Pinning the body with `position: fixed` at the current offset holds
 * everywhere; the offset is put back on unlock so the viewer lands where
 * they were. Inline styles that were there before are restored as they were.
 */
export function lockDocumentScroll(doc: Document, win: Window): () => void {
  const body = doc.body;
  const html = doc.documentElement;
  const scrollY = win.scrollY;
  const keys = ["position", "top", "left", "right", "width", "overflow"] as const;
  const previous = Object.fromEntries(keys.map((k) => [k, body.style[k] ?? ""])) as Record<
    (typeof keys)[number],
    string
  >;
  const previousHtmlOverflow = html.style.overflow ?? "";
  body.style.position = "fixed";
  body.style.top = `-${scrollY}px`;
  body.style.left = "0";
  body.style.right = "0";
  body.style.width = "100%";
  body.style.overflow = "hidden";
  // Desktop browsers honour this and it keeps a stray scrollbar from showing
  // beside the pinned body; iOS ignores it, which is what the pin is for.
  html.style.overflow = "hidden";
  return () => {
    for (const k of keys) body.style[k] = previous[k];
    html.style.overflow = previousHtmlOverflow;
    win.scrollTo(0, scrollY);
  };
}

/**
 * Zoom Component View (SDK 6.0.0) panel aspect, height over width, read from
 * the SDK's own size table: speaker view is 568 x 400, and while a share is
 * being received the SDK forces the base height to 615. The SDK draws a
 * requested `{width, height}` as `{width, max(height, ratio * width)}`, so
 * the panel can never be wider than `height / ratio`.
 */
export const ZOOM_SPEAKER_RATIO = 400 / 568;
export const ZOOM_SHARE_RATIO = 615 / 568;

/**
 * The largest Zoom panel that fits `area`: full height, width capped by the
 * SDK's aspect. Computed, not measured: the Oct 1, 2026 build measured the
 * root's scroll extent, which Zoom's off-panel popovers inflated, and the
 * shrink loop cut the panel to about 40% of the area on a live webinar.
 */
export function fitZoomPanel(area: Size, sharing: boolean): Size | null {
  if (area.width <= 0 || area.height <= 0) return null;
  const ratio = sharing ? ZOOM_SHARE_RATIO : ZOOM_SPEAKER_RATIO;
  const width = Math.max(200, Math.floor(Math.min(area.width, area.height / ratio)));
  return { width, height: Math.floor(width * ratio) };
}
