/**
 * Questions from custom-stream viewers (Oct 1, 2026): the public ask/list
 * route and the producer list/mark route.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    eventSession: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn() },
    webinarViewerQuestion: { create: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  },
  mockAuth: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/public-event", () => ({ publicEventWhere: vi.fn(async () => ({})) }));
vi.mock("@/lib/security", () => ({
  getClientIp: () => "1.2.3.4",
  checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
}));

import { POST as ask, GET as listMine } from "@/app/api/public/events/[slug]/sessions/[sessionId]/questions/route";
import { GET as listAll, PATCH as mark } from "@/app/api/events/[eventId]/webinar/questions/route";

const publicParams = { params: Promise.resolve({ slug: "test-webinar", sessionId: "s1" }) };
const staffParams = { params: Promise.resolve({ eventId: "ev1" }) };
const attendee = { user: { id: "u1", role: "REGISTRANT", organizationId: null, firstName: "A", lastName: "B" } };
const organizer = { user: { id: "u9", role: "ORGANIZER", organizationId: "org1", firstName: "Org", lastName: "Staff" } };

const req = (body?: unknown) =>
  new Request("http://localhost/x", {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1", settings: { webinar: { sessionId: "s1" } } });
  mockDb.eventSession.findFirst.mockResolvedValue({ id: "s1" });
  mockDb.webinarViewerQuestion.create.mockResolvedValue({ id: "q1", question: "Why?", status: "NEW", createdAt: new Date() });
});

describe("public: ask a question", () => {
  it("401 when signed out", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await ask(req({ question: "Hello there" }), publicParams)).status).toBe(401);
  });

  it("403 when not registered for the event", async () => {
    mockAuth.mockResolvedValue(attendee);
    mockDb.registration.findFirst.mockResolvedValue(null);
    expect((await ask(req({ question: "Hello there" }), publicParams)).status).toBe(403);
    expect(mockDb.webinarViewerQuestion.create).not.toHaveBeenCalled();
  });

  it("400 for an empty or over-long question", async () => {
    mockAuth.mockResolvedValue(attendee);
    expect((await ask(req({ question: "  " }), publicParams)).status).toBe(400);
    expect((await ask(req({ question: "x".repeat(1001) }), publicParams)).status).toBe(400);
  });

  it("stores the question under the registration's name, never a name from the body", async () => {
    mockAuth.mockResolvedValue(attendee);
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1", attendee: { firstName: "Dana", lastName: "Lee" } });
    const res = await ask(req({ question: "  What is the dose?  ", askerName: "Someone Else" }), publicParams);
    expect(res.status).toBe(201);
    expect(mockDb.webinarViewerQuestion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventId: "ev1", organizationId: "org1", sessionId: "s1", registrationId: "r1",
          askerName: "Dana Lee", question: "What is the dose?",
        }),
      }),
    );
  });

  it("org staff testing the page can ask without a registration", async () => {
    mockAuth.mockResolvedValue(organizer);
    const res = await ask(req({ question: "Test question" }), publicParams);
    expect(res.status).toBe(201);
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
    expect(mockDb.webinarViewerQuestion.create.mock.calls[0][0].data).toMatchObject({ registrationId: null, askerName: "Org Staff" });
  });

  it("404 when the session is not in this event", async () => {
    mockAuth.mockResolvedValue(attendee);
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1", attendee: { firstName: "D", lastName: "L" } });
    mockDb.eventSession.findFirst.mockResolvedValue(null);
    expect((await ask(req({ question: "Hello there" }), publicParams)).status).toBe(404);
  });

  it("lists the viewer's own questions and the shown ones, with shortened names, never dismissed", async () => {
    mockAuth.mockResolvedValue(attendee);
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1", attendee: { firstName: "D", lastName: "L" } });
    mockDb.webinarViewerQuestion.findMany
      .mockResolvedValueOnce([{ id: "q1", question: "Mine", status: "NEW", isPublic: false }])
      .mockResolvedValueOnce([{ id: "q2", question: "Shown", status: "ANSWERED", askerName: "Dana Maria Lee" }]);
    const res = await listMine(req(), publicParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mockDb.webinarViewerQuestion.findMany.mock.calls[0][0].where).toMatchObject({ registrationId: "r1", sessionId: "s1" });
    expect(mockDb.webinarViewerQuestion.findMany.mock.calls[1][0].where).toEqual({
      sessionId: "s1", eventId: "ev1", isPublic: true, status: { not: "DISMISSED" },
    });
    expect(body.published).toEqual([{ id: "q2", question: "Shown", status: "ANSWERED", askerName: "Dana L." }]);
  });
});

describe("producer: list and mark", () => {
  it("lists the anchor session's questions", async () => {
    mockAuth.mockResolvedValue(organizer);
    mockDb.webinarViewerQuestion.findMany.mockResolvedValue([{ id: "q1" }]);
    const res = await listAll(req(), staffParams);
    expect(res.status).toBe(200);
    expect(mockDb.webinarViewerQuestion.findMany.mock.calls[0][0].where).toEqual({ eventId: "ev1", sessionId: "s1" });
  });

  it("marks a question answered, bound to the event", async () => {
    mockAuth.mockResolvedValue(organizer);
    mockDb.webinarViewerQuestion.updateMany.mockResolvedValue({ count: 1 });
    const res = await mark(
      new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify({ id: "q1", status: "ANSWERED" }) }),
      staffParams,
    );
    expect(res.status).toBe(200);
    const call = mockDb.webinarViewerQuestion.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "q1", eventId: "ev1" });
    expect(call.data.status).toBe("ANSWERED");
    expect(call.data.answeredAt).toBeInstanceOf(Date);
  });

  it("shows a question to attendees; dismissing always hides it; an empty change is refused", async () => {
    mockAuth.mockResolvedValue(organizer);
    mockDb.webinarViewerQuestion.updateMany.mockResolvedValue({ count: 1 });
    const patch = (body: unknown) =>
      mark(new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify(body) }), staffParams);
    expect((await patch({ id: "q1", isPublic: true })).status).toBe(200);
    expect(mockDb.webinarViewerQuestion.updateMany.mock.calls[0][0].data).toEqual({ isPublic: true });
    expect((await patch({ id: "q1", status: "DISMISSED", isPublic: true })).status).toBe(200);
    expect(mockDb.webinarViewerQuestion.updateMany.mock.calls[1][0].data).toMatchObject({ status: "DISMISSED", isPublic: false });
    expect((await patch({ id: "q1" })).status).toBe(400);
  });

  it("404 for a question from another event; 400 for a bad status; 403 for a read-only member", async () => {
    mockAuth.mockResolvedValue(organizer);
    mockDb.webinarViewerQuestion.updateMany.mockResolvedValue({ count: 0 });
    const patch = (body: unknown) =>
      mark(new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify(body) }), staffParams);
    expect((await patch({ id: "qX", status: "ANSWERED" })).status).toBe(404);
    expect((await patch({ id: "q1", status: "DELETED" })).status).toBe(400);
    mockAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", organizationId: "org1" } });
    expect((await patch({ id: "q1", status: "ANSWERED" })).status).toBe(403);
  });
});
