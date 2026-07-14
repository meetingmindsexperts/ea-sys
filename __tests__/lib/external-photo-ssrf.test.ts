/**
 * SSRF guard on the EventsAir photo import.
 *
 * downloadExternalPhoto() used to be a bare `fetch(externalUrl)` with no
 * validation of any kind. The URL comes from the EventsAir import payload — not
 * typed by an end user, but not ours either, and "an upstream system supplied it"
 * is not a security boundary.
 *
 * What made it worth fixing rather than filing: the Docker socket is mounted into
 * this container. An app-initiated request to an internal address is a much
 * shorter path to the host than it looks.
 *
 * Every test below is an attack that WORKED against the previous implementation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const safeFetchImage = vi.fn();
const writeFile = vi.fn(async () => undefined);
const mkdir = vi.fn(async () => undefined);

vi.mock("@/lib/safe-fetch", () => ({
  safeFetchImage: (...a: unknown[]) => safeFetchImage(...a),
}));

// Stub the filesystem rather than the uploader: downloadExternalPhoto calls
// uploadPhoto directly (not through the module object), so a vi.spyOn on the
// export does NOT intercept it — the real writer would run and litter
// public/uploads with test files. Mocking fs keeps the real upload path under
// test while writing nothing.
vi.mock("fs/promises", () => ({
  writeFile: (...a: unknown[]) => writeFile(...(a as [])),
  mkdir: (...a: unknown[]) => mkdir(...(a as [])),
}));

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// storage.ts picks its provider at module load; local is the production setting.
vi.stubEnv("STORAGE_PROVIDER", "local");

async function loadStorage() {
  vi.resetModules();
  return import("@/lib/storage");
}

describe("downloadExternalPhoto — SSRF", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    safeFetchImage.mockReset();
    writeFile.mockClear();
  });

  it("routes every external URL through the SSRF-safe fetcher", async () => {
    const { downloadExternalPhoto } = await loadStorage();
    safeFetchImage.mockResolvedValue({
      ok: true,
      data: { buffer: Buffer.from("x"), ext: "jpg", mime: "image/jpeg" },
      finalUrl: "https://cdn.eventsair.com/p.jpg",
    });

    await downloadExternalPhoto("https://cdn.eventsair.com/p.jpg");

    // The bare `fetch` is gone. That is the whole fix.
    expect(safeFetchImage).toHaveBeenCalledWith(
      "https://cdn.eventsair.com/p.jpg",
      expect.objectContaining({ maxBytes: 500 * 1024, timeoutMs: 10_000 })
    );
  });

  it("refuses a URL the guard blocks (EC2 instance metadata)", async () => {
    const { downloadExternalPhoto } = await loadStorage();
    safeFetchImage.mockResolvedValue({
      ok: false,
      reason: "ip_blocked",
      detail: "169.254.169.254 is on the cloud-metadata block list",
    });

    const out = await downloadExternalPhoto("http://169.254.169.254/latest/meta-data/");

    expect(out).toBeNull();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("refuses an internal Docker-network address", async () => {
    // The app shares a bridge network with the worker and MediaMTX. Before the
    // fix, a photo URL of http://ea-sys-worker:3099/health was simply fetched.
    const { downloadExternalPhoto } = await loadStorage();
    safeFetchImage.mockResolvedValue({ ok: false, reason: "ip_blocked", detail: "resolved to 172.18.0.3" });

    expect(await downloadExternalPhoto("http://ea-sys-worker:3099/health")).toBeNull();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("refuses a redirect into an internal address", async () => {
    // The bypass a naive host allowlist always misses: the permitted host answers
    // 302 → 169.254.169.254. safeFetchImage re-validates every hop.
    const { downloadExternalPhoto } = await loadStorage();
    safeFetchImage.mockResolvedValue({
      ok: false,
      reason: "ip_blocked",
      detail: "redirect target resolved to 169.254.169.254",
      finalUrl: "http://169.254.169.254/",
    });

    expect(await downloadExternalPhoto("https://evil.example.com/redirect.jpg")).toBeNull();
  });

  it("refuses SVG even though the fetcher permits it", async () => {
    // These files are re-served from OUR origin. An SVG can carry a <script>, so
    // accepting one would turn a photo import into stored XSS on our own domain.
    const { downloadExternalPhoto } = await loadStorage();
    safeFetchImage.mockResolvedValue({
      ok: true,
      data: { buffer: Buffer.from("<svg onload=alert(1)>"), ext: "svg", mime: "image/svg+xml" },
      finalUrl: "https://cdn.example.com/x.svg",
    });

    expect(await downloadExternalPhoto("https://cdn.example.com/x.svg")).toBeNull();
    // Nothing reached disk — the SVG was never re-hosted on our origin.
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("still re-hosts a legitimate photo", async () => {
    const { downloadExternalPhoto } = await loadStorage();
    safeFetchImage.mockResolvedValue({
      ok: true,
      data: { buffer: Buffer.from("jpegbytes"), ext: "jpg", mime: "image/jpeg" },
      finalUrl: "https://cdn.eventsair.com/p.jpg",
    });

    const out = await downloadExternalPhoto("https://cdn.eventsair.com/p.jpg");

    expect(out).toMatch(/^\/uploads\/photos\/.*\.jpg$/);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("short-circuits URLs we already host (no outbound request at all)", async () => {
    const { downloadExternalPhoto } = await loadStorage();

    expect(await downloadExternalPhoto("/uploads/photos/2026/07/a.jpg")).toBe("/uploads/photos/2026/07/a.jpg");
    expect(safeFetchImage).not.toHaveBeenCalled();
  });
});
