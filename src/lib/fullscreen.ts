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
