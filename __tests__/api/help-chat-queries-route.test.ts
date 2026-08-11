/**
 * GET /api/help-chat/queries — the SUPER_ADMIN-only read surface for captured
 * help-assistant Q&A. Pins the RBAC gate (401 / 403 / 200) and the
 * LIKE-wildcard escaping (a `%`/`_` in the search must match literally, not
 * widen the result set — the registration-export lesson).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth } = vi.hoisted(() => ({
  mockDb: {
    helpChatQuery: { findMany: vi.fn(), count: vi.fn() },
  },
  mockAuth: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
// Same object under both names, mirroring master (one client, one pool). The
// route reads on the operator lane; the assertions still drive mockDb.
vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "@/app/api/help-chat/queries/route";

// The route reads req.nextUrl.searchParams — a plain object is enough.
function req(query = "") {
  const searchParams = new URLSearchParams(query);
  return { nextUrl: { searchParams } } as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.helpChatQuery.findMany.mockResolvedValue([]);
  mockDb.helpChatQuery.count.mockResolvedValue(0);
});

describe("GET /api/help-chat/queries — RBAC", () => {
  it("401 when no session", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mockDb.helpChatQuery.findMany).not.toHaveBeenCalled();
  });

  it("403 for a non-SUPER_ADMIN (even ADMIN)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN" } });
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(mockDb.helpChatQuery.findMany).not.toHaveBeenCalled();
  });

  it("200 for SUPER_ADMIN, returns queries + total", async () => {
    mockAuth.mockResolvedValue({ user: { id: "sa", role: "SUPER_ADMIN" } });
    mockDb.helpChatQuery.findMany.mockResolvedValue([{ id: "q1" }]);
    mockDb.helpChatQuery.count.mockResolvedValue(1);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.queries).toHaveLength(1);
    expect(body.page).toBe(1);
  });
});

describe("GET /api/help-chat/queries — search + paging", () => {
  beforeEach(() => {
    mockAuth.mockResolvedValue({ user: { id: "sa", role: "SUPER_ADMIN" } });
  });

  it("no q → empty where (no OR filter)", async () => {
    await GET(req());
    const arg = mockDb.helpChatQuery.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({});
  });

  it("escapes LIKE wildcards in the search term", async () => {
    await GET(req("q=" + encodeURIComponent("50%_off")));
    const arg = mockDb.helpChatQuery.findMany.mock.calls[0][0];
    // Both the question and answer branches get the escaped needle.
    expect(arg.where.OR[0].question.contains).toBe("50\\%\\_off");
    expect(arg.where.OR[1].answer.contains).toBe("50\\%\\_off");
    expect(arg.where.OR[0].question.mode).toBe("insensitive");
  });

  it("clamps limit to 100 and page to >= 1, computes skip/take", async () => {
    await GET(req("page=0&limit=999"));
    const arg = mockDb.helpChatQuery.findMany.mock.calls[0][0];
    expect(arg.take).toBe(100); // capped
    expect(arg.skip).toBe(0); // page floored to 1 → (1-1)*100
    expect(arg.orderBy).toEqual({ createdAt: "desc" });
  });

  it("computes skip from page and limit", async () => {
    await GET(req("page=3&limit=25"));
    const arg = mockDb.helpChatQuery.findMany.mock.calls[0][0];
    expect(arg.take).toBe(25);
    expect(arg.skip).toBe(50); // (3-1)*25
  });
});
