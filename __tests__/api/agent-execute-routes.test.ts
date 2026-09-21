/**
 * The two doors of the Event Agent share one handler: the org-level route
 * reads the event from the body, the per-event route binds it from the URL
 * (the alias the architecture review promised so no client breaks). The
 * handler owns the role gate, the rate limit, the body schema and the
 * event-to-org check; the loop is mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "next-auth";

const { mockRun, mockEventFindFirst, mockRateLimit } = vi.hoisted(() => ({
  mockRun: vi.fn(),
  mockEventFindFirst: vi.fn(),
  mockRateLimit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { event: { findFirst: mockEventFindFirst } }, dbOperator: {} }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/security", () => ({ checkRateLimit: mockRateLimit }));
vi.mock("@/lib/agent/run-agent", () => ({ runAgentRequest: mockRun }));

import { executeAgentRequest, AGENT_ROLES } from "@/lib/agent/execute-handler";

const session = (role: string, organizationId: string | null = "org1"): Session =>
  ({ user: { id: "u1", role, organizationId, email: "x@y.z" }, expires: "" } as unknown as Session);

function post(body: unknown): Request {
  return new Request("http://localhost/api/agent/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function readSse(res: Response): Promise<string> {
  return await res.text();
}

describe("executeAgentRequest", () => {
  beforeEach(() => {
    mockRun.mockReset();
    mockRun.mockImplementation(async (req: { send: (e: unknown) => void }) => {
      req.send({ type: "text_delta", text: "hi" });
    });
    mockEventFindFirst.mockReset();
    mockEventFindFirst.mockResolvedValue({ id: "ev1" });
    mockRateLimit.mockReset();
    mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  });

  it("admits exactly the four agent roles", async () => {
    expect([...AGENT_ROLES]).toEqual(["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER"]);
    for (const role of ["ONSITE", "WEBINARS", "CRM_USER", "HR_USER", "REVIEWER", "SUBMITTER", "REGISTRANT"]) {
      const res = await executeAgentRequest(post({ message: "hi" }), session(role), "org1", { route: "t" });
      expect(res.status, role).toBe(403);
    }
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("runs the loop for an organizer at org level with no event and streams SSE", async () => {
    const res = await executeAgentRequest(post({ message: "hi", history: [] }), session("ORGANIZER"), "org1", { route: "t" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const body = await readSse(res);
    expect(body).toContain('data: {"type":"text_delta","text":"hi"}');
    expect(body).toContain('data: {"type":"done"}');
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun.mock.calls[0][0]).toMatchObject({
      organizationId: "org1",
      eventId: null,
      actor: { userId: "u1", role: "ORGANIZER", fromApiKey: false },
      readOnly: false,
      blockFinance: false,
      message: "hi",
    });
    expect(mockEventFindFirst).not.toHaveBeenCalled();
  });

  it("MEMBER is read-only but keeps finance sight (canViewFinance includes MEMBER)", async () => {
    await readSse(await executeAgentRequest(post({ message: "hi" }), session("MEMBER"), "org1", { route: "t" }));
    expect(mockRun.mock.calls[0][0]).toMatchObject({ readOnly: true, blockFinance: false });
  });

  it("binds a body eventId to the org and refuses one it does not own", async () => {
    await readSse(await executeAgentRequest(post({ message: "hi", eventId: "ev1" }), session("ADMIN"), "org1", { route: "t" }));
    expect(mockEventFindFirst).toHaveBeenCalledWith({ where: { id: "ev1", organizationId: "org1" }, select: { id: true } });
    expect(mockRun.mock.calls[0][0]).toMatchObject({ eventId: "ev1" });

    mockEventFindFirst.mockResolvedValue(null);
    const res = await executeAgentRequest(post({ message: "hi", eventId: "other" }), session("ADMIN"), "org1", { route: "t" });
    expect(res.status).toBe(404);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it("the per-event alias binds the event from the route, not the body", async () => {
    await readSse(
      await executeAgentRequest(post({ message: "hi", eventId: "body-event" }), session("ADMIN"), "org1", {
        route: "t",
        eventIdFromRoute: "route-event",
      }),
    );
    expect(mockEventFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "route-event", organizationId: "org1" } }));
    expect(mockRun.mock.calls[0][0]).toMatchObject({ eventId: "route-event" });
  });

  it("validates the body with a schema and caps the history", async () => {
    expect((await executeAgentRequest(post({ history: [] }), session("ADMIN"), "org1", { route: "t" })).status).toBe(400);
    expect((await executeAgentRequest(post({ message: "x".repeat(2001) }), session("ADMIN"), "org1", { route: "t" })).status).toBe(400);
    expect((await executeAgentRequest(post("{not json"), session("ADMIN"), "org1", { route: "t" })).status).toBe(400);
    expect((await executeAgentRequest(post({ message: "hi", history: [{ role: "system", content: "x" }] }), session("ADMIN"), "org1", { route: "t" })).status).toBe(400);
    expect(mockRun).not.toHaveBeenCalled();

    const history = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }));
    const res = await executeAgentRequest(post({ message: "hi", history: history.slice(0, 40) }), session("ADMIN"), "org1", { route: "t" });
    await readSse(res);
    expect(mockRun.mock.calls[0][0].history).toHaveLength(40);
    const long = await executeAgentRequest(post({ message: "hi", history: [{ role: "user", content: "y".repeat(9000) }] }), session("ADMIN"), "org1", { route: "t" });
    await readSse(long);
    expect(mockRun.mock.calls[1][0].history[0].content).toHaveLength(8000);
  });

  it("returns 429 with Retry-After when the per-user limit is hit", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 120 });
    const res = await executeAgentRequest(post({ message: "hi" }), session("ADMIN"), "org1", { route: "t" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
    expect(mockRateLimit).toHaveBeenCalledWith(expect.objectContaining({ key: "agent-u1", limit: 20 }));
  });

  it("masks a provider error in the stream", async () => {
    mockRun.mockRejectedValue(new Error("boom"));
    const body = await readSse(await executeAgentRequest(post({ message: "hi" }), session("ADMIN"), "org1", { route: "t" }));
    expect(body).toContain('"type":"error"');
    expect(body).not.toContain("boom");
  });
});

describe("the two route files", () => {
  it("both authenticate, then delegate; the event route passes the URL's event", async () => {
    vi.resetModules();
    const mockAuth = vi.fn();
    const mockExecute = vi.fn<typeof executeAgentRequest>(async () => new Response("ok"));
    vi.doMock("@/lib/auth", () => ({ auth: mockAuth }));
    vi.doMock("@/lib/agent/execute-handler", () => ({ executeAgentRequest: mockExecute }));
    vi.doMock("@/lib/require-org", () => ({
      requireOrgId: (s: Session) => (s.user.organizationId ? { orgId: s.user.organizationId } : { error: new Response("", { status: 403 }) }),
    }));
    const org = await import("@/app/api/agent/execute/route");
    const ev = await import("@/app/api/events/[eventId]/agent/execute/route");

    mockAuth.mockResolvedValue(null);
    expect((await org.POST(post({ message: "hi" }))).status).toBe(401);
    expect((await ev.POST(post({ message: "hi" }), { params: Promise.resolve({ eventId: "ev1" }) })).status).toBe(401);
    expect(mockExecute).not.toHaveBeenCalled();

    mockAuth.mockResolvedValue(session("ADMIN"));
    await org.POST(post({ message: "hi" }));
    await ev.POST(post({ message: "hi" }), { params: Promise.resolve({ eventId: "ev1" }) });
    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(mockExecute.mock.calls[0][3]).toEqual({ route: "agent/execute" });
    expect(mockExecute.mock.calls[1][3]).toEqual({ route: "events/agent-execute", eventIdFromRoute: "ev1" });
    expect(mockExecute.mock.calls[0][2]).toBe("org1");
  });
});
