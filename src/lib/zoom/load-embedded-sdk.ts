/**
 * Loader for the Zoom Meeting SDK "Component View" embedded runtime, with a
 * switchable strategy.
 *
 * WHY THIS EXISTS — `@zoom/meetingsdk@6.0.0`'s `/embedded` bundle does NOT
 * inline React. It externalizes `react`/`react-dom`, and its code reads React
 * 18's internal `ReactCurrentOwner`. When the app bundler resolves those
 * externals to OUR React 19 (which removed `ReactCurrentOwner`), the SDK throws
 * *"Cannot read properties of undefined (reading 'ReactCurrentOwner')"* and the
 * embed fails to load. (Producer-reported on a live webinar, June 23 2026.)
 *
 * THE FIX — load the SDK + its OWN React 18 from Zoom's CDN as isolated browser
 * globals (`window.React` = React 18, `window.ZoomMtgEmbedded`). The Next app
 * keeps importing React 19 through the module graph, so the two never collide.
 * This is Zoom's documented integration for React apps, not a hack.
 *
 * SWITCHABLE — `NEXT_PUBLIC_ZOOM_EMBED_LOADER` flips between:
 *   - "cdn" (default)  → load from source.zoom.us (React-18-isolated; works now)
 *   - "npm"            → `import "@zoom/meetingsdk/embedded"` (the bundled path;
 *                        broken under React 19 today, but kept so we can flip
 *                        back the moment Zoom ships a React-19-compatible SDK —
 *                        a one-env-var change, no code edit).
 */

// Type-only import — fully erased at build, so it does NOT pull the
// React-19-colliding runtime into the bundle. Used purely to type the loader's
// return so the component keeps the SDK's own types.
type ZoomMtgEmbeddedModule = typeof import("@zoom/meetingsdk/embedded")["default"];

export type ZoomEmbeddedLoader = "cdn" | "npm";

/** Matches the installed `@zoom/meetingsdk` version. Bump together. */
const ZOOM_SDK_VERSION = "6.0.0";

// Vendor globals the embedded CDN bundle expects (React 18 + its deps), then
// the embedded bundle itself (registers `window.ZoomMtgEmbedded`). Order
// matters: react before react-dom, all vendors before the bundle.
const CDN_SCRIPTS = [
  `https://source.zoom.us/${ZOOM_SDK_VERSION}/lib/vendor/react.min.js`,
  `https://source.zoom.us/${ZOOM_SDK_VERSION}/lib/vendor/react-dom.min.js`,
  `https://source.zoom.us/${ZOOM_SDK_VERSION}/lib/vendor/redux.min.js`,
  `https://source.zoom.us/${ZOOM_SDK_VERSION}/lib/vendor/redux-thunk.min.js`,
  `https://source.zoom.us/${ZOOM_SDK_VERSION}/lib/vendor/lodash.min.js`,
  `https://source.zoom.us/zoom-meeting-embedded-${ZOOM_SDK_VERSION}.min.js`,
];

export const ZOOM_EMBED_LOADER: ZoomEmbeddedLoader =
  process.env.NEXT_PUBLIC_ZOOM_EMBED_LOADER === "npm" ? "npm" : "cdn";

// Cache the CDN load so repeat mounts (and the cleanup path) reuse one load.
let cdnPromise: Promise<ZoomMtgEmbeddedModule> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-zoom-sdk="${src}"]`,
    );
    if (existing) {
      if (existing.dataset.loaded === "true") {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () =>
        reject(new Error(`Failed to load Zoom SDK script: ${src}`)),
      );
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = false; // ordered execution
    s.dataset.zoomSdk = src;
    s.addEventListener("load", () => {
      s.dataset.loaded = "true";
      resolve();
    });
    s.addEventListener("error", () =>
      reject(new Error(`Failed to load Zoom SDK script: ${src}`)),
    );
    document.head.appendChild(s);
  });
}

async function loadFromCdn(): Promise<ZoomMtgEmbeddedModule> {
  if (typeof window === "undefined") {
    throw new Error("Zoom embedded SDK can only load in the browser");
  }
  if (cdnPromise) return cdnPromise;
  cdnPromise = (async () => {
    // Sequential so React/ReactDOM globals exist before the embedded bundle.
    for (const src of CDN_SCRIPTS) {
      await loadScript(src);
    }
    const g = (window as unknown as { ZoomMtgEmbedded?: ZoomMtgEmbeddedModule })
      .ZoomMtgEmbedded;
    if (!g) {
      // Reset so a later retry can re-attempt rather than reuse a bad load.
      cdnPromise = null;
      throw new Error(
        "Zoom embedded SDK loaded but did not register window.ZoomMtgEmbedded",
      );
    }
    return g;
  })();
  return cdnPromise;
}

/**
 * Returns the `ZoomMtgEmbedded` module (createClient / destroyClient / …) using
 * the configured strategy. Same shape regardless of loader, so callers don't
 * branch.
 */
export async function loadZoomMtgEmbedded(
  loader: ZoomEmbeddedLoader = ZOOM_EMBED_LOADER,
): Promise<ZoomMtgEmbeddedModule> {
  if (loader === "npm") {
    return (await import("@zoom/meetingsdk/embedded")).default;
  }
  return loadFromCdn();
}
