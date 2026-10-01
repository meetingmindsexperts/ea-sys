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

  const request =
    typeof pel.requestFullscreen === "function"
      ? () => pel.requestFullscreen()
      : typeof pel.webkitRequestFullscreen === "function"
        ? () => pel.webkitRequestFullscreen?.()
        : null;
  if (!request) return null;

  const exit =
    typeof pdoc.exitFullscreen === "function"
      ? () => pdoc.exitFullscreen()
      : typeof pdoc.webkitExitFullscreen === "function"
        ? () => pdoc.webkitExitFullscreen?.()
        : null;
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
 * Next width to ask the Zoom SDK for, or null when the drawn panel already
 * fits its area. `drawn` is the root's scroll extent: the root is sized to
 * the request and is the panel's containing block, so the SDK can only match
 * it or overflow it, and the overflow is what this corrects.
 *
 * Zoom's Component View sizes its panel as `{ requestedWidth, max(requestedHeight,
 * k × requestedWidth) }`, where `k` is the SDK's own ratio for the current
 * view: about 0.70 in speaker view, about 1.08 while a share is being
 * received, smaller in gallery. It changes with the view and with sharing,
 * and it belongs to the SDK version, so rather than hard-code it we ask for
 * the whole area, measure what was drawn, and scale the request down by the
 * overflow. The height formula is linear in the width, so one step lands
 * within a pixel and the caller caps the loop anyway.
 *
 * Never grows inside a fit cycle: growth comes from a fresh request for the
 * full area (area resize, fullscreen toggle, share start or stop).
 */
export function shrinkToFit(
  requestedWidth: number,
  drawn: Size,
  bounds: Size,
  opts: { tolerance?: number; minWidth?: number } = {},
): number | null {
  const tolerance = opts.tolerance ?? 2;
  const minWidth = opts.minWidth ?? 200;
  if (drawn.width <= 0 || drawn.height <= 0) return null;
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  if (requestedWidth <= 0) return null;

  const fitsWidth = drawn.width <= bounds.width + tolerance;
  const fitsHeight = drawn.height <= bounds.height + tolerance;
  if (fitsWidth && fitsHeight) return null;

  const scale = Math.min(bounds.width / drawn.width, bounds.height / drawn.height);
  const next = Math.max(minWidth, Math.floor(requestedWidth * scale));
  if (next >= requestedWidth) return null;
  return next;
}
