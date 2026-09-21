/**
 * GET /api/agent/messages, the SUPER_ADMIN-only read surface for the Event
 * Agent's stored conversations. Pins the RBAC gate (401 / 403 / 200), the
 * LIKE-wildcard escaping on BOTH text columns, the outcome filter (a bad
 * value is a 400, never a silently widened list), the paging clamps, the
 * steps riding in seq order with their input, and the name resolution for
 * the scalar ids the run keeps.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockLogger } = vi.hoisted(() => ({
  mockDb: {
    agentRun: { findMany: vi.fn(), count: vi.fn() },
    user: { findMany: vi.fn() },
    event: { findMany: vi.fn() },
    organization: { findMany: vi.fn() },
  },
  mockAuth: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));

import { GET } from "@/app/api/agent/messages/route";

function req(query = "") {
  const searchParams = new URLSearchParams(query);
  return { nextUrl: { searchParams } } as unknown as Parameters<typeof GET>[0];
}

const RUN = {
  id: "run1",
  organizationId: "org1",
  userId: "u1",
  role: "ADMIN",
  eventId: "ev1",
  route: "event",
  message: "cancel Dr Jane Smith's registration",
  reply: "Done.",
  outcome: "COMPLETED",
  startedAt: new Date("2026-09-21T10:00:00Z"),
  steps: [{ seq: 0, tool: "list_registrations", outcome: "RAN", code: null, write: false, approved: false, durationMs: 12, input: { eventId: "ev1", q: "Jane" } }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.agentRun.findMany.mockResolvedValue([]);
  mockDb.agentRun.count.mockResolvedValue(0);
  mockDb.user.findMany.mockResolvedValue([]);
  mockDb.event.findMany.mockResolvedValue([]);
  mockDb.organization.findMany.mockResolvedValue([]);
});

describe("GET /api/agent/messages, RBAC", () => {
  it("401 when no session, and nothing is read", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mockDb.agentRun.findMany).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "agent-messages:unauthorized" }));
  });

  it("403 for a non-operator, ADMIN included", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(mockDb.agentRun.findMany).not.toHaveBeenCalled();
  });

  it("200 for SUPER_ADMIN with the runs, their steps and the resolved names", async () => {
    mockAuth.mockResolvedValue({ user: { id: "sa", role: "SUPER_ADMIN", organizationId: "org1" } });
    mockDb.agentRun.findMany.mockResolvedValue([RUN]);
    mockDb.agentRun.count.mockResolvedValue(1);
    mockDb.user.findMany.mockResolvedValue([{ id: "u1", firstName: "Ada", lastName: "Lovelace", email: "ada@x.test" }]);
    mockDb.event.findMany.mockResolvedValue([{ id: "ev1", name: "Summit 2026" }]);
    mockDb.organization.findMany.mockResolvedValue([{ id: "org1", name: "MM Group" }]);

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      id: "run1",
      message: "cancel Dr Jane Smith's registration",
      reply: "Done.",
      user: { name: "Ada Lovelace", email: "ada@x.test" },
      event: { name: "Summit 2026" },
      organization: { name: "MM Group" },
    });
    expect(body.runs[0].steps[0]).toMatchObject({ tool: "list_registrations", input: { eventId: "ev1", q: "Jane" } });
    // The lookups are by the page's ids, once each.
    expect(mockDb.user.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["u1"] } });
    expect(mockDb.event.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["ev1"] } });
    expect(mockDb.organization.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["org1"] } });
  });

  it("a deleted account or event reads as null, not a failed page", async () => {
    mockAuth.mockResolvedValue({ user: { id: "sa", role: "SUPER_ADMIN", organizationId: "org1" } });
    mockDb.agentRun.findMany.mockResolvedValue([{ ...RUN, eventId: null }]);
    mockDb.agentRun.count.mockResolvedValue(1);
    const res = await GET(req());
    const body = await res.json();
    expect(body.runs[0].user).toBeNull();
    expect(body.runs[0].event).toBeNull();
    expect(mockDb.event.findMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/agent/messages, filters and paging", () => {
  beforeEach(() => {
    mockAuth.mockResolvedValue({ user: { id: "sa", role: "SUPER_ADMIN", organizationId: "org1" } });
  });

  it("reads the steps in seq order with their input", async () => {
    await GET(req());
    const arg = mockDb.agentRun.findMany.mock.calls[0][0];
    expect(arg.select.steps.orderBy).toEqual({ seq: "asc" });
    expect(arg.select.steps.select.input).toBe(true);
    expect(arg.orderBy).toEqual({ startedAt: "desc" });
  });

  it("no q and no outcome means an empty where", async () => {
    await GET(req());
    expect(mockDb.agentRun.findMany.mock.calls[0][0].where).toEqual({});
  });

  it("escapes LIKE wildcards on both the message and the reply", async () => {
    await GET(req("q=" + encodeURIComponent("50%_off")));
    const where = mockDb.agentRun.findMany.mock.calls[0][0].where;
    expect(where.OR[0].message.contains).toBe("50\\%\\_off");
    expect(where.OR[1].reply.contains).toBe("50\\%\\_off");
    expect(where.OR[0].message.mode).toBe("insensitive");
  });

  it("filters on a known outcome", async () => {
    await GET(req("outcome=ERROR"));
    expect(mockDb.agentRun.findMany.mock.calls[0][0].where).toEqual({ outcome: "ERROR" });
    expect(mockDb.agentRun.count.mock.calls[0][0].where).toEqual({ outcome: "ERROR" });
  });

  it("refuses an unknown outcome with a logged 400 instead of listing everything", async () => {
    const res = await GET(req("outcome=BROKEN"));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_OUTCOME");
    expect(mockDb.agentRun.findMany).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "agent-messages:invalid-outcome" }));
  });

  it("clamps limit to 100 and page to at least 1", async () => {
    await GET(req("page=0&limit=999"));
    const arg = mockDb.agentRun.findMany.mock.calls[0][0];
    expect(arg.take).toBe(100);
    expect(arg.skip).toBe(0);
  });

  it("computes skip from page and limit", async () => {
    await GET(req("page=3&limit=25"));
    const arg = mockDb.agentRun.findMany.mock.calls[0][0];
    expect(arg.take).toBe(25);
    expect(arg.skip).toBe(50);
  });

  it("a database failure is a logged 500", async () => {
    mockDb.agentRun.findMany.mockRejectedValue(new Error("pool"));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "agent-messages:fetch-failed" }));
  });
});
