/**
 * Unit tests for src/lib/zoom/load-embedded-sdk.ts — the loader that fixes the
 * Zoom embed "ReactCurrentOwner" crash under React 19 by loading the SDK + its
 * own React 18 from Zoom's CDN.
 *
 * Runtime proof that the REAL CDN bundle works (React 18.2.0 isolated +
 * createClient/init without the crash) was done via a live browser check on
 * 2026-06-23. These tests pin OUR loader logic: correct script set/order,
 * caching, the npm flip-back branch, and error handling — in the `node` test
 * env, with `document`/`window` stubbed (no jsdom dependency added).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const SDK = { createClient: vi.fn(), destroyClient: vi.fn() };
const NPM_SDK = { createClient: vi.fn(), destroyClient: vi.fn() };

vi.mock("@zoom/meetingsdk/embedded", () => ({ default: NPM_SDK }));

interface FakeScript {
  src: string;
  async: boolean;
  dataset: Record<string, string>;
  _listeners: Record<string, () => void>;
  addEventListener: (ev: string, cb: () => void) => void;
}

let appended: FakeScript[];
let fakeWindow: Record<string, unknown>;

function installDom() {
  appended = [];
  fakeWindow = {};
  const head = {
    appendChild: (node: FakeScript) => {
      appended.push(node);
      // Simulate async load: the embedded bundle registers the global, then
      // every script fires "load" so the loader's sequential awaits resolve.
      queueMicrotask(() => {
        if (node.src.includes("zoom-meeting-embedded")) {
          fakeWindow.ZoomMtgEmbedded = SDK;
        }
        node.dataset.loaded = "true";
        node._listeners.load?.();
      });
      return node;
    },
  };
  const fakeDocument = {
    head,
    querySelector: () => null, // no pre-existing tags
    createElement: (): FakeScript => {
      const s: FakeScript = {
        src: "",
        async: true,
        dataset: {},
        _listeners: {},
        addEventListener(ev, cb) {
          this._listeners[ev] = cb;
        },
      };
      return s;
    },
  };
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("window", fakeWindow);
}

beforeEach(() => {
  vi.resetModules(); // fresh module-level cdnPromise cache per test
  installDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadZoomMtgEmbedded — cdn (default)", () => {
  it("injects the 6 source.zoom.us scripts in order and returns window.ZoomMtgEmbedded", async () => {
    const { loadZoomMtgEmbedded } = await import("@/lib/zoom/load-embedded-sdk");
    const sdk = await loadZoomMtgEmbedded("cdn");

    expect(sdk).toBe(SDK);
    const urls = appended.map((s) => s.src);
    expect(urls).toHaveLength(6);
    expect(urls.every((u) => u.startsWith("https://source.zoom.us/"))).toBe(true);
    // react MUST precede react-dom; the embedded bundle MUST be last.
    expect(urls[0]).toContain("/6.0.0/lib/vendor/react.min.js");
    expect(urls[1]).toContain("/6.0.0/lib/vendor/react-dom.min.js");
    expect(urls[5]).toContain("zoom-meeting-embedded-6.0.0.min.js");
  });

  it("is cached — a second call reuses the load without re-injecting scripts", async () => {
    const { loadZoomMtgEmbedded } = await import("@/lib/zoom/load-embedded-sdk");
    const first = await loadZoomMtgEmbedded("cdn");
    const countAfterFirst = appended.length;
    const second = await loadZoomMtgEmbedded("cdn");

    expect(second).toBe(first);
    expect(appended.length).toBe(countAfterFirst); // no new scripts
  });

  it("throws (and resets cache for retry) if the global never registers", async () => {
    // Override appendChild to fire load WITHOUT setting window.ZoomMtgEmbedded.
    (document.head as unknown as { appendChild: (n: FakeScript) => FakeScript }).appendChild =
      (node: FakeScript) => {
        appended.push(node);
        queueMicrotask(() => node._listeners.load?.());
        return node;
      };
    const { loadZoomMtgEmbedded } = await import("@/lib/zoom/load-embedded-sdk");
    await expect(loadZoomMtgEmbedded("cdn")).rejects.toThrow(/did not register window\.ZoomMtgEmbedded/);
  });
});

describe("loadZoomMtgEmbedded — npm (flip-back path)", () => {
  it("dynamic-imports @zoom/meetingsdk/embedded and injects NO scripts", async () => {
    const { loadZoomMtgEmbedded } = await import("@/lib/zoom/load-embedded-sdk");
    const sdk = await loadZoomMtgEmbedded("npm");

    expect(sdk).toBe(NPM_SDK);
    expect(appended).toHaveLength(0); // npm path never touches the DOM
  });
});

describe("ZOOM_EMBED_LOADER default", () => {
  it("defaults to cdn when the env var is unset/not 'npm'", async () => {
    const { ZOOM_EMBED_LOADER } = await import("@/lib/zoom/load-embedded-sdk");
    expect(ZOOM_EMBED_LOADER).toBe("cdn");
  });
});
