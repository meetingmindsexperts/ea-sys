import { describe, expect, it, vi } from "vitest";
import {
  fitZoomPanel,
  lockDocumentScroll,
  lockLandscape,
  resolveFullscreenApi,
  resolveVideoFullscreen,
  unlockOrientation,
} from "@/lib/fullscreen";

/**
 * The fullscreen helpers behind both webinar players (Oct 1, 2026). The hook
 * and the components need a browser; the API resolution and the panel-fit
 * arithmetic do not, so they are pinned here.
 */

type FakeEl = Record<string, unknown>;

function fakeDoc(overrides: Record<string, unknown> = {}) {
  return { fullscreenElement: null, ...overrides } as unknown as Document;
}

describe("resolveFullscreenApi", () => {
  it("uses the standard API when the element and document have it", async () => {
    const request = vi.fn(async () => {});
    const exit = vi.fn(async () => {});
    const el: FakeEl = { requestFullscreen: request };
    const doc = fakeDoc({ exitFullscreen: exit, fullscreenElement: el });

    const api = resolveFullscreenApi(el as unknown as HTMLElement, doc);
    expect(api).not.toBeNull();
    await api!.request();
    await api!.exit();
    expect(request).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(api!.current()).toBe(el);
  });

  it("falls back to the WebKit-prefixed API (iPad Safari)", async () => {
    const request = vi.fn(() => undefined);
    const exit = vi.fn(() => undefined);
    const el: FakeEl = { webkitRequestFullscreen: request };
    const doc = fakeDoc({
      webkitExitFullscreen: exit,
      fullscreenElement: undefined,
      webkitFullscreenElement: el,
    });

    const api = resolveFullscreenApi(el as unknown as HTMLElement, doc);
    expect(api).not.toBeNull();
    await api!.request();
    await api!.exit();
    expect(request).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(api!.current()).toBe(el);
  });

  it("is null when the element cannot go fullscreen (iPhone Safari)", () => {
    const el: FakeEl = {};
    const doc = fakeDoc({ exitFullscreen: async () => {} });
    expect(resolveFullscreenApi(el as unknown as HTMLElement, doc)).toBeNull();
  });

  it("is null when the document reports fullscreen disabled (Permissions-Policy)", () => {
    const el: FakeEl = { requestFullscreen: async () => {} };
    const doc = fakeDoc({ exitFullscreen: async () => {}, fullscreenEnabled: false });
    expect(resolveFullscreenApi(el as unknown as HTMLElement, doc)).toBeNull();
  });

  it("is null when the document cannot exit", () => {
    const el: FakeEl = { requestFullscreen: async () => {} };
    expect(resolveFullscreenApi(el as unknown as HTMLElement, fakeDoc())).toBeNull();
  });
});

describe("lockDocumentScroll", () => {
  function fakes(scrollY: number, inline: Record<string, string> = {}, htmlInline: Record<string, string> = {}) {
    const style: Record<string, string> = { ...inline };
    const htmlStyle: Record<string, string> = { ...htmlInline };
    const doc = { body: { style }, documentElement: { style: htmlStyle } } as unknown as Document;
    const scrollTo = vi.fn();
    const win = { scrollY, scrollTo } as unknown as Window;
    return { style, htmlStyle, doc, win, scrollTo };
  }

  it("pins the body at the current offset (iOS Safari ignores overflow: hidden) and hides html overflow", () => {
    const { style, htmlStyle, doc, win } = fakes(640);
    lockDocumentScroll(doc, win);
    expect(style.position).toBe("fixed");
    expect(style.top).toBe("-640px");
    expect(style.width).toBe("100%");
    expect(style.overflow).toBe("hidden");
    expect(htmlStyle.overflow).toBe("hidden");
  });

  it("unlock restores the inline styles that were there and the scroll offset", () => {
    const { style, htmlStyle, doc, win, scrollTo } = fakes(
      640,
      { position: "relative", width: "90%" },
      { overflow: "auto" },
    );
    const unlock = lockDocumentScroll(doc, win);
    unlock();
    expect(style.position).toBe("relative");
    expect(style.width).toBe("90%");
    expect(style.top).toBe("");
    expect(style.overflow).toBe("");
    expect(htmlStyle.overflow).toBe("auto");
    expect(scrollTo).toHaveBeenCalledWith(0, 640);
  });
});

describe("fitZoomPanel", () => {
  it("speaker view: full height, width capped by Zoom's 568x400 aspect", () => {
    // The Oct 1 live screenshot: a 1340 x 628 area got a ~555px panel.
    const size = fitZoomPanel({ width: 1340, height: 628 }, false)!;
    expect(size.width).toBe(Math.floor(628 / (400 / 568)));
    expect(size.height).toBeLessThanOrEqual(628);
    expect(size.width).toBeGreaterThan(880);
  });

  it("a narrow area is width-limited", () => {
    const size = fitZoomPanel({ width: 358, height: 448 }, false)!;
    expect(size.width).toBe(358);
    expect(size.height).toBe(Math.floor(358 * (400 / 568)));
  });

  it("receiving a share uses the taller 615 base height", () => {
    const size = fitZoomPanel({ width: 1280, height: 760 }, true)!;
    expect(size.width).toBe(Math.floor(760 / (615 / 568)));
    expect(size.height).toBeLessThanOrEqual(760);
  });

  it("is null for an unmeasured area", () => {
    expect(fitZoomPanel({ width: 0, height: 500 }, false)).toBeNull();
  });
});

describe("resolveVideoFullscreen (iPhone, Nov 24, 2026)", () => {
  it("hands the video to Apple's player once it has a picture", () => {
    const enter = vi.fn();
    const exit = vi.fn();
    const video = {
      webkitEnterFullscreen: enter,
      webkitExitFullscreen: exit,
      webkitSupportsFullscreen: true,
      webkitDisplayingFullscreen: false,
      readyState: 4,
      error: null,
    };
    const api = resolveVideoFullscreen(video as unknown as HTMLVideoElement);
    expect(api).not.toBeNull();
    api!.enter();
    expect(enter).toHaveBeenCalledTimes(1);
    expect(api!.active()).toBe(false);
    video.webkitDisplayingFullscreen = true;
    expect(api!.active()).toBe(true);
    api!.exit();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("is null before the video has a picture, so the in-page box is used", () => {
    const video = { webkitEnterFullscreen: vi.fn(), webkitSupportsFullscreen: false, readyState: 0, error: null };
    expect(resolveVideoFullscreen(video as unknown as HTMLVideoElement)).toBeNull();
  });

  // Review of 9dc1aae07: the browser's flag can be true for a video with a source and no picture
  // (reconnecting, or the stream dropped), and Apple's player would open black over our message.
  it("is null while the video has nothing to show, whatever the browser's flag says", () => {
    const base = { webkitEnterFullscreen: vi.fn(), webkitSupportsFullscreen: true };
    expect(resolveVideoFullscreen({ ...base, readyState: 0, error: null } as unknown as HTMLVideoElement)).toBeNull();
    expect(resolveVideoFullscreen({ ...base, readyState: 4, error: { code: 4 } } as unknown as HTMLVideoElement)).toBeNull();
    expect(resolveVideoFullscreen({ ...base, readyState: 1, error: null } as unknown as HTMLVideoElement)).not.toBeNull();
  });

  it("is null on a browser without Apple's player, and with no video", () => {
    expect(resolveVideoFullscreen({} as HTMLVideoElement)).toBeNull();
    expect(resolveVideoFullscreen(null)).toBeNull();
  });
});

describe("lockLandscape (Android, Nov 24, 2026)", () => {
  function fakeWin(opts: { coarse: boolean; lock?: (o: string) => Promise<void>; unlock?: () => void }) {
    return {
      matchMedia: (q: string) => ({ matches: q === "(pointer: coarse)" && opts.coarse }),
      screen: { orientation: { lock: opts.lock, unlock: opts.unlock } },
    } as unknown as Window;
  }

  it("turns a touch screen sideways", async () => {
    const lock = vi.fn(async () => {});
    expect(await lockLandscape(fakeWin({ coarse: true, lock }))).toBe(true);
    expect(lock).toHaveBeenCalledWith("landscape");
  });

  it("never asks a desktop, which would refuse on every click", async () => {
    const lock = vi.fn(async () => {});
    expect(await lockLandscape(fakeWin({ coarse: false, lock }))).toBe(false);
    expect(lock).not.toHaveBeenCalled();
  });

  it("answers false when the browser refuses (Safari on iPad), without throwing", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const lock = vi.fn(async () => {
      throw Object.assign(new Error("no"), { name: "NotSupportedError" });
    });
    expect(await lockLandscape(fakeWin({ coarse: true, lock }))).toBe(false);
    expect(info).toHaveBeenCalledWith("fullscreen:orientation-lock-refused", "NotSupportedError");
    info.mockRestore();
  });

  it("answers false where there is no orientation lock at all", async () => {
    expect(await lockLandscape(fakeWin({ coarse: true }))).toBe(false);
  });

  it("unlocks, and a throwing unlock is logged, not raised", () => {
    const unlock = vi.fn();
    unlockOrientation(fakeWin({ coarse: true, unlock }));
    expect(unlock).toHaveBeenCalledTimes(1);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(() =>
      unlockOrientation(
        fakeWin({
          coarse: true,
          unlock: () => {
            throw new Error("x");
          },
        }),
      ),
    ).not.toThrow();
    expect(info).toHaveBeenCalled();
    info.mockRestore();
  });
});
