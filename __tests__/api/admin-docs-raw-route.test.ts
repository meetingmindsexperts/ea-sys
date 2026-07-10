/**
 * GET /admin/docs/[...path] — raw shareable doc URLs (July 10, 2026).
 * Pins the access gate (login redirect / role 403), the docs/-prefix
 * convenience fallback, the no-script CSP on HTML responses, and the
 * traversal → 400 path. readDocFile is mocked; the real safety lives in
 * docs-fs (covered by its own suite).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockReadDocFile } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockReadDocFile: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/docs-fs", () => ({ readDocFile: mockReadDocFile }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { GET } from "@/app/admin/docs/[...path]/route";

const ADMIN = { user: { id: "u1", role: "ADMIN", organizationId: "org1" } };
const req = (path: string) => new Request(`https://events.example.com/admin/docs/${path}`);
const params = (...segments: string[]) => ({ params: Promise.resolve({ path: segments }) });

const HTML_FILE = {
  path: "docs/CODE_REVIEW_REGISTRATIONS_SPEAKERS.html",
  content: "<h1>Review</h1>",
  type: "html" as const,
  size: 15,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(ADMIN);
  mockReadDocFile.mockResolvedValue(HTML_FILE);
});

describe("GET /admin/docs/[...path]", () => {
  it("redirects a logged-out hit to /login with the doc as callbackUrl", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(req("CODE_REVIEW_REGISTRATIONS_SPEAKERS.html"), params("CODE_REVIEW_REGISTRATIONS_SPEAKERS.html"));
    expect(res.status).toBe(307);
    const loc = res.headers.get("location")!;
    expect(loc).toContain("/login?callbackUrl=");
    expect(decodeURIComponent(loc)).toContain("/admin/docs/CODE_REVIEW_REGISTRATIONS_SPEAKERS.html");
    expect(mockReadDocFile).not.toHaveBeenCalled();
  });

  it("403s non-admin roles (docs carry security findings — never public)", async () => {
    for (const role of ["ORGANIZER", "MEMBER", "ONSITE", "REGISTRANT"]) {
      mockAuth.mockResolvedValue({ user: { id: "u2", role, organizationId: "org1" } });
      const res = await GET(req("x.html"), params("x.html"));
      expect(res.status).toBe(403);
    }
    expect(mockReadDocFile).not.toHaveBeenCalled();
  });

  it("serves HTML with text/html + a no-script CSP", async () => {
    const res = await GET(
      req("docs/CODE_REVIEW_REGISTRATIONS_SPEAKERS.html"),
      params("docs", "CODE_REVIEW_REGISTRATIONS_SPEAKERS.html"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(await res.text()).toBe("<h1>Review</h1>");
  });

  it("falls back to the docs/ prefix when the bare filename misses", async () => {
    mockReadDocFile
      .mockResolvedValueOnce(null) // as-given: "CODE_REVIEW….html" at repo root — miss
      .mockResolvedValueOnce(HTML_FILE); // retried under docs/
    const res = await GET(
      req("CODE_REVIEW_REGISTRATIONS_SPEAKERS.html"),
      params("CODE_REVIEW_REGISTRATIONS_SPEAKERS.html"),
    );
    expect(res.status).toBe(200);
    expect(mockReadDocFile).toHaveBeenNthCalledWith(1, "CODE_REVIEW_REGISTRATIONS_SPEAKERS.html");
    expect(mockReadDocFile).toHaveBeenNthCalledWith(2, "docs/CODE_REVIEW_REGISTRATIONS_SPEAKERS.html");
  });

  it("serves markdown as text/plain (raw form; the viewer is the pretty renderer)", async () => {
    mockReadDocFile.mockResolvedValue({ path: "docs/ROLLBACK.md", content: "# Rollback", type: "markdown", size: 10 });
    const res = await GET(req("ROLLBACK.md"), params("ROLLBACK.md"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("maps a traversal throw to 400 and a miss to 404", async () => {
    mockReadDocFile.mockRejectedValue(new Error("Path escapes repository root"));
    const bad = await GET(req(".."), params(".."));
    expect(bad.status).toBe(400);

    mockReadDocFile.mockReset();
    mockReadDocFile.mockResolvedValue(null);
    const miss = await GET(req("nope.html"), params("nope.html"));
    expect(miss.status).toBe(404);
  });
});
