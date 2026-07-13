/**
 * loadCertificatePdfBytes — the shared, GUARDED cert PDF loader (single source
 * of truth for the issue worker + resend route). Verifies the path-traversal +
 * SSRF guards the worker previously lacked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("fs/promises", () => ({ readFile: readFileMock }));

import { loadCertificatePdfBytes, validateBackgroundPdfUrl } from "@/lib/certificates/pdf-loader";

beforeEach(() => {
  vi.clearAllMocks();
  readFileMock.mockResolvedValue(Buffer.from("%PDF-1.4 local"));
  vi.stubGlobal("fetch", vi.fn());
});

describe("loadCertificatePdfBytes — local path guard", () => {
  it("reads a valid cert path under public/uploads/certificates/", async () => {
    const buf = await loadCertificatePdfBytes("/uploads/certificates/2026/07/abc.pdf");
    expect(buf.toString()).toContain("%PDF");
    expect(readFileMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a path-traversal attempt (…/../etc/passwd) without reading", async () => {
    await expect(loadCertificatePdfBytes("/uploads/../../etc/passwd")).rejects.toThrow(/escapes allowed prefix/);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("rejects a sibling-prefix bypass (certificates-evil)", async () => {
    await expect(loadCertificatePdfBytes("/uploads/certificates-evil/x.pdf")).rejects.toThrow(/escapes allowed prefix/);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("rejects an /uploads path outside certificates/ (e.g. photos)", async () => {
    await expect(loadCertificatePdfBytes("/uploads/photos/x.pdf")).rejects.toThrow(/escapes allowed prefix/);
  });
});

describe("loadCertificatePdfBytes — remote SSRF guard", () => {
  it("fetches an allowlisted https Supabase URL", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode("%PDF remote").buffer });
    const buf = await loadCertificatePdfBytes("https://proj.supabase.co/storage/v1/x.pdf");
    expect(buf.toString()).toContain("%PDF");
  });

  it("rejects a non-allowlisted host without fetching", async () => {
    await expect(loadCertificatePdfBytes("https://evil.example.com/x.pdf")).rejects.toThrow(/not on allowlist/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects a look-alike host (supabase.co.evil.com)", async () => {
    await expect(loadCertificatePdfBytes("https://supabase.co.evil.com/x.pdf")).rejects.toThrow(/not on allowlist/);
  });

  it("rejects a non-https remote URL", async () => {
    await expect(loadCertificatePdfBytes("http://proj.supabase.co/x.pdf")).rejects.toThrow(/must use https/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects an invalid URL string", async () => {
    await expect(loadCertificatePdfBytes("not a url")).rejects.toThrow(/not a valid URL/);
  });

  it("throws on a non-2xx fetch", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 404 });
    await expect(loadCertificatePdfBytes("https://proj.supabase.co/x.pdf")).rejects.toThrow(/HTTP 404/);
  });
});

describe("validateBackgroundPdfUrl — write-side guard (B1)", () => {
  it("accepts a system-generated local cert path", () => {
    expect(validateBackgroundPdfUrl("/uploads/certificates/evt123/abc.pdf").ok).toBe(true);
  });

  it("accepts an https Supabase URL", () => {
    expect(validateBackgroundPdfUrl("https://proj.supabase.co/storage/v1/x.pdf").ok).toBe(true);
  });

  it("rejects a local path-traversal (../../.env)", () => {
    const r = validateBackgroundPdfUrl("/uploads/../../.env");
    expect(r.ok).toBe(false);
  });

  it("rejects a local path outside certificates/ (photos)", () => {
    expect(validateBackgroundPdfUrl("/uploads/photos/x.pdf").ok).toBe(false);
  });

  it("rejects a traversal that stays under the certificates/ prefix textually", () => {
    // starts with /uploads/certificates/ but contains a `..` segment
    expect(validateBackgroundPdfUrl("/uploads/certificates/../../secrets/x.pdf").ok).toBe(false);
  });

  it("rejects a NUL byte", () => {
    expect(validateBackgroundPdfUrl("/uploads/certificates/a\0.pdf").ok).toBe(false);
  });

  it("rejects a non-allowlisted remote host", () => {
    expect(validateBackgroundPdfUrl("https://evil.example.com/x.pdf").ok).toBe(false);
  });

  it("rejects a look-alike remote host", () => {
    expect(validateBackgroundPdfUrl("https://supabase.co.evil.com/x.pdf").ok).toBe(false);
  });

  it("rejects an http (non-https) remote URL", () => {
    expect(validateBackgroundPdfUrl("http://proj.supabase.co/x.pdf").ok).toBe(false);
  });

  it("rejects an SSRF metadata-endpoint URL", () => {
    expect(validateBackgroundPdfUrl("http://169.254.169.254/latest/meta-data/").ok).toBe(false);
  });

  it("rejects an empty string and an over-length string", () => {
    expect(validateBackgroundPdfUrl("").ok).toBe(false);
    expect(validateBackgroundPdfUrl("/uploads/certificates/" + "a".repeat(500) + ".pdf").ok).toBe(false);
  });
});
