/** /api/admin/docs/public (Sep 25, 2026): the operator-only switch behind the viewer's "Public link". */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockSet, mockList, mockEnabled } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockSet: vi.fn(),
  mockList: vi.fn(),
  mockEnabled: vi.fn(() => true),
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/public-docs", () => ({ setDocPublic: mockSet, listPublicDocPaths: mockList, publicDocLinksEnabled: mockEnabled }));

import { GET, POST } from "@/app/api/admin/docs/public/route";

const OPERATOR = { user: { id: "op1", role: "SUPER_ADMIN", organizationId: "org1" } };
const post = (body: unknown) => new Request("http://t/api/admin/docs/public", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(OPERATOR);
  mockList.mockResolvedValue(["docs/WEBINAR_EVENTS.html"]);
  mockSet.mockResolvedValue({ ok: true, path: "docs/WEBINAR_EVENTS.html", public: true });
});

describe("/api/admin/docs/public", () => {
  it("lists the public docs for the operator", async () => {
    const res = await GET();
    expect(await res.json()).toEqual({ enabled: true, paths: ["docs/WEBINAR_EVENTS.html"] });
  });

  it("switches a doc for the operator, as that operator", async () => {
    const res = await POST(post({ path: "WEBINAR_EVENTS.html", public: true }));
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith({ path: "WEBINAR_EVENTS.html", makePublic: true, userId: "op1" });
  });

  it("refuses everyone but the operator, including an org ADMIN, on both verbs", async () => {
    for (const role of ["ADMIN", "ORGANIZER", "MEMBER", "REGISTRANT"]) {
      mockAuth.mockResolvedValue({ user: { id: "x", role, organizationId: "org1" } });
      expect((await GET()).status, role).toBe(403);
      expect((await POST(post({ path: "a.html", public: true }))).status, role).toBe(403);
    }
    mockAuth.mockResolvedValue(null);
    expect((await POST(post({ path: "a.html", public: true }))).status).toBe(401);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("answers a bad body with 400 and maps the refusals", async () => {
    expect((await POST(post("{nope"))).status).toBe(400);
    expect((await POST(post({ path: "a.html" }))).status).toBe(400);
    mockSet.mockResolvedValueOnce({ ok: false, code: "NOT_FOUND", message: "m" });
    expect((await POST(post({ path: "a.html", public: true }))).status).toBe(404);
    mockSet.mockResolvedValueOnce({ ok: false, code: "NOT_HTML", message: "m" });
    expect((await POST(post({ path: "a.md", public: true }))).status).toBe(400);
    mockSet.mockResolvedValueOnce({ ok: false, code: "DISABLED", message: "m" });
    expect((await POST(post({ path: "a.html", public: true }))).status).toBe(409);
  });
});
