import { describe, expect, it, vi } from "vitest";
import { resolveFullscreenApi, shrinkToFit } from "@/lib/fullscreen";

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

describe("shrinkToFit", () => {
  const bounds = { width: 1024, height: 576 };

  it("is null when the drawn panel fits (within tolerance)", () => {
    expect(shrinkToFit(1024, { width: 1024, height: 576 }, bounds)).toBeNull();
    expect(shrinkToFit(1024, { width: 1025, height: 577 }, bounds)).toBeNull();
    expect(shrinkToFit(1024, { width: 800, height: 400 }, bounds)).toBeNull();
  });

  it("scales the request down by the height overflow (speaker view, 16:9 area)", () => {
    // Zoom draws speaker view at about 0.70 × width: 1024 wide becomes 721 tall.
    const next = shrinkToFit(1024, { width: 1024, height: 721 }, bounds);
    expect(next).toBe(Math.floor(1024 * (576 / 721)));
    expect(next!).toBeLessThan(1024);
    // The SDK's height is linear in the width, so the corrected request fits.
    expect(Math.round(next! * 0.704)).toBeLessThanOrEqual(576);
  });

  it("scales by the worse of the two overflows", () => {
    const next = shrinkToFit(1024, { width: 1200, height: 600 }, bounds);
    expect(next).toBe(Math.floor(1024 * Math.min(1024 / 1200, 576 / 600)));
  });

  it("never grows inside a fit cycle", () => {
    expect(shrinkToFit(600, { width: 600, height: 700 }, bounds, { minWidth: 700 })).toBeNull();
  });

  it("keeps a floor so a tiny area cannot ask for a sliver", () => {
    expect(shrinkToFit(360, { width: 360, height: 900 }, { width: 360, height: 200 })).toBe(200);
  });

  it("is null on degenerate input", () => {
    expect(shrinkToFit(0, { width: 1, height: 1 }, bounds)).toBeNull();
    expect(shrinkToFit(1024, { width: 0, height: 0 }, bounds)).toBeNull();
    expect(shrinkToFit(1024, { width: 1, height: 1 }, { width: 0, height: 0 })).toBeNull();
  });
});
