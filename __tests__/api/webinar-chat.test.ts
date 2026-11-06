/**
 * Webinar chat (Nov 6, 2026; docs/WEBINAR_INTERACTION_PLAN.md §6): the public poll and post route.
 * Who may read and post (the viewer rule), when (the room), what others see (anonymous, never ids),
 * incremental reads from the cached snapshot, and the moderator's limits.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockRate } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    eventSession: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn() },
    webinarChatMessage: { findMany: vi.fn(), create: vi.fn() },
  },
  mockAuth: vi.fn(),
  mockRate: vi.fn(),
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
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4", checkRateLimit: mockRate }));

import { GET, POST } from "@/app/api/public/events/[slug]/sessions/[sessionId]/chat/route";
import { getChatSnapshot, messagesAfter, resetChatCaches } from "@/lib/webinar/chat-server";
import { cleanChatText } from "@/lib/webinar/chat";

const params = { params: Promise.resolve({ slug: "web", sessionId: "s1" }) };
const attendee = { user: { id: "u1", role: "REGISTRANT", organizationId: null, firstName: "Sara", lastName: "Khan" } };
const other = { user: { id: "u2", role: "REGISTRANT", organizationId: null, firstName: "Omar", lastName: "Ali" } };
const staff = { user: { id: "u9", role: "ORGANIZER", organizationId: "org1", firstName: "Pro", lastName: "Ducer" } };

const chatOn = { enabled: true, moderatorUserId: "u9" };
function setEvent(chat: Record<string, unknown> = chatOn, extra: Record<string, unknown> = {}) {
  mockDb.event.findFirst.mockResolvedValue({
    id: "ev1",
    organizationId: "org1",
    status: "PUBLISHED",
    eventType: "WEBINAR",
    settings: {
      webinar: {
        sessionId: "s1",
        viewingMode: "hls",
        chat,
        handouts: [{ id: "h1", name: "Slides.pdf", storedPath: "/x", contentType: "application/pdf", size: 1, uploadedAt: "" }],
        ...extra,
      },
    },
  });
}
const START = new Date(Date.now() - 10 * 60_000);
const END = new Date(Date.now() + 50 * 60_000);
function setRoom(status: string, start = START, end = END) {
  mockDb.eventSession.findFirst.mockResolvedValue({ status, startTime: start, endTime: end });
}
const msg = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  body: `hello ${id}`,
  authorName: "Sara Khan",
  authorKind: "attendee",
  anonymous: false,
  kind: "message",
  handoutId: null,
  registrationId: "r1",
  userId: null,
  deletedAt: null,
  createdAt: new Date(),
  ...extra,
});
/** findMany returns newest first. */
function setMessages(oldestFirst: ReturnType<typeof msg>[]) {
  mockDb.webinarChatMessage.findMany.mockResolvedValue([...oldestFirst].reverse());
}
const get = (after?: string) => GET(new Request(`http://x/chat${after ? `?after=${after}` : ""}`), params);
const post = (body: unknown) =>
  POST(new Request("http://x/chat", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), params);

beforeEach(() => {
  vi.clearAllMocks();
  resetChatCaches();
  mockRate.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  setEvent();
  setRoom("LIVE");
  setMessages([]);
  mockDb.registration.findFirst.mockImplementation(async ({ where }: { where: { userId: string } }) =>
    where.userId === "u1"
      ? { id: "r1", attendee: { firstName: "Sara", lastName: "Khan" } }
      : where.userId === "u2"
        ? { id: "r2", attendee: { firstName: "Omar", lastName: "Ali" } }
        : null,
  );
  mockDb.webinarChatMessage.create.mockResolvedValue({ id: "m-new" });
});

describe("who may read", () => {
  it("401 signed out, for reading and posting", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect((await post({ body: "hi" })).status).toBe(401);
  });

  it("404 when this is not the webinar's room", async () => {
    mockAuth.mockResolvedValue(attendee);
    setEvent(chatOn, { sessionId: "other" });
    expect((await get()).status).toBe(404);
  });

  it("off unless switched on WITH a moderator named, and only in Custom stream mode", async () => {
    mockAuth.mockResolvedValue(attendee);
    for (const [chat, extra] of [
      [{ enabled: true }, {}],
      [{ enabled: false, moderatorUserId: "u9" }, {}],
      [chatOn, { viewingMode: "zoom" }],
    ] as const) {
      resetChatCaches();
      setEvent(chat, extra);
      expect(await (await get()).json()).toEqual({ enabled: false });
    }
  });

  it("a registration that may not watch (pending, unpaid) cannot read: the viewer rule", async () => {
    mockAuth.mockResolvedValue(attendee);
    mockDb.registration.findFirst.mockResolvedValue(null);
    expect((await get()).status).toBe(403);
    const where = mockDb.registration.findFirst.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ["CONFIRMED", "CHECKED_IN"] });
  });
});

describe("when", () => {
  it("before the room opens an attendee reads nothing; staff still read, to test", async () => {
    setRoom("SCHEDULED", new Date(Date.now() + 3600_000), new Date(Date.now() + 7200_000));
    setMessages([msg("m1")]);
    mockAuth.mockResolvedValue(attendee);
    const a = await (await get()).json();
    expect(a).toMatchObject({ phase: "closed", canPost: false, messages: [] });
    mockAuth.mockResolvedValue(staff);
    const s = await (await get()).json();
    expect(s.messages).toHaveLength(1);
  });

  it("the waiting-room switch opens it before the room", async () => {
    setEvent({ ...chatOn, openInLobby: true });
    setRoom("SCHEDULED", new Date(Date.now() + 3600_000), new Date(Date.now() + 7200_000));
    mockAuth.mockResolvedValue(attendee);
    expect(await (await get()).json()).toMatchObject({ phase: "open", canPost: true });
  });

  it("after the webinar ended it is read-only", async () => {
    setRoom("COMPLETED");
    setMessages([msg("m1")]);
    mockAuth.mockResolvedValue(attendee);
    const body = await (await get()).json();
    expect(body).toMatchObject({ phase: "readonly", canPost: false });
    expect(body.messages).toHaveLength(1);
    expect((await post({ body: "late" })).status).toBe(409);
  });
});

describe("what others see", () => {
  it("an anonymous message shows 'Attendee' to others and is 'mine' to its author; no ids ever leave", async () => {
    setMessages([msg("m1", { anonymous: true })]);
    mockAuth.mockResolvedValue(other);
    const seen = (await (await get()).json()).messages[0];
    expect(seen).toMatchObject({ author: "Attendee", mine: false });
    expect(JSON.stringify(seen)).not.toMatch(/Sara|r1|registrationId|userId/);
    resetChatCaches();
    mockAuth.mockResolvedValue(attendee);
    expect((await (await get()).json()).messages[0]).toMatchObject({ mine: true });
  });

  it("a named message shows the full name; staff are always named", async () => {
    setMessages([msg("m1"), msg("m2", { authorKind: "staff", authorName: "Pro Ducer", registrationId: null, userId: "u9", anonymous: true })]);
    mockAuth.mockResolvedValue(other);
    const [a, b] = (await (await get()).json()).messages;
    expect(a.author).toBe("Sara Khan");
    expect(b).toMatchObject({ author: "Pro Ducer", authorKind: "staff" });
  });

  it("a shared handout arrives as a card with its name", async () => {
    setMessages([msg("m1", { kind: "handout", handoutId: "h1", authorKind: "staff", userId: "u9", registrationId: null })]);
    mockAuth.mockResolvedValue(attendee);
    expect((await (await get()).json()).messages[0]).toMatchObject({ kind: "handout", handout: { id: "h1", name: "Slides.pdf" } });
  });
});

describe("incremental reads", () => {
  it("after=<id> returns only newer messages; deleted ones go in 'removed'; an unknown id resets", async () => {
    setMessages([msg("m1"), msg("m2", { deletedAt: new Date() }), msg("m3")]);
    mockAuth.mockResolvedValue(attendee);
    const first = await (await get()).json();
    expect(first.reset).toBe(true);
    expect(first.messages.map((m: { id: string }) => m.id)).toEqual(["m1", "m3"]);
    expect(first.removed).toEqual(["m2"]);
    const next = await (await get("m1")).json();
    expect(next.reset).toBe(false);
    expect(next.messages.map((m: { id: string }) => m.id)).toEqual(["m3"]);
    expect((await (await get("gone")).json()).reset).toBe(true);
  });

  it("polls are answered from the snapshot: one database read per 2 s, not per request", async () => {
    mockAuth.mockResolvedValue(attendee);
    await get();
    await get();
    await get();
    expect(mockDb.webinarChatMessage.findMany).toHaveBeenCalledTimes(1);
    expect(mockDb.registration.findFirst).toHaveBeenCalledTimes(1);
  });

  it("the pinned message rides every poll", async () => {
    setEvent({ ...chatOn, pinnedMessageId: "m1" });
    setMessages([msg("m1", { authorKind: "staff", userId: "u9", registrationId: null, authorName: "Pro Ducer" })]);
    mockAuth.mockResolvedValue(attendee);
    expect((await (await get("m1")).json()).pinned).toMatchObject({ id: "m1", author: "Pro Ducer" });
  });
});

describe("posting", () => {
  it("stores the real name from the registration and the anonymous choice, never a name from the request", async () => {
    mockAuth.mockResolvedValue(attendee);
    const res = await post({ body: "  Great talk  ", anonymous: true, authorName: "Someone Else" });
    expect(res.status).toBe(201);
    expect(mockDb.webinarChatMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          authorName: "Sara Khan",
          anonymous: true,
          authorKind: "attendee",
          registrationId: "r1",
          userId: null,
          body: "Great talk",
          organizationId: "org1",
        }),
      }),
    );
  });

  it("staff are always named, even if they ask to be anonymous", async () => {
    mockAuth.mockResolvedValue(staff);
    await post({ body: "Welcome", anonymous: true });
    expect(mockDb.webinarChatMessage.create.mock.calls[0][0].data).toMatchObject({ authorKind: "staff", anonymous: false, userId: "u9" });
  });

  it("400 for an empty or over-long message", async () => {
    mockAuth.mockResolvedValue(attendee);
    expect((await post({ body: "   " })).status).toBe(400);
    expect((await post({ body: "x".repeat(501) })).status).toBe(400);
  });

  it("mute everyone stops attendees, not staff; a muted person is refused", async () => {
    setEvent({ ...chatOn, mutedAll: true });
    mockAuth.mockResolvedValue(attendee);
    expect((await post({ body: "hi" })).status).toBe(403);
    mockAuth.mockResolvedValue(staff);
    expect((await post({ body: "hi" })).status).toBe(201);
    setEvent({ ...chatOn, mutedRegistrationIds: ["r1"] });
    mockAuth.mockResolvedValue(attendee);
    const res = await post({ body: "hi" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("CHAT_MUTED");
  });

  it("a mute bites on the next post, not after the poll cache expires", async () => {
    mockAuth.mockResolvedValue(attendee);
    await get(); // warms the snapshot without the mute
    setEvent({ ...chatOn, mutedRegistrationIds: ["r1"] });
    expect((await post({ body: "hi" })).status).toBe(403);
  });

  it("only staff share handouts, and only one still attached", async () => {
    mockAuth.mockResolvedValue(attendee);
    expect((await post({ body: "look", handoutId: "h1" })).status).toBe(403);
    mockAuth.mockResolvedValue(staff);
    expect((await post({ body: "look", handoutId: "nope" })).status).toBe(404);
    expect((await post({ body: "Slides for part 2", handoutId: "h1" })).status).toBe(201);
    expect(mockDb.webinarChatMessage.create.mock.calls[0][0].data).toMatchObject({ kind: "handout", handoutId: "h1" });
  });

  it("too fast is a 429 with Retry-After, and nothing is stored", async () => {
    mockAuth.mockResolvedValue(attendee);
    mockRate.mockReturnValue({ allowed: false, retryAfterSeconds: 3 });
    const res = await post({ body: "hi" });
    expect(res.status).toBe(429);
    expect(mockDb.webinarChatMessage.create).not.toHaveBeenCalled();
  });

  it("slow mode stretches an attendee's gap to 15 s", async () => {
    setEvent({ ...chatOn, slowMode: true });
    mockAuth.mockResolvedValue(attendee);
    await post({ body: "hi" });
    expect(mockRate).toHaveBeenCalledWith(expect.objectContaining({ key: "webinar-chat-gap:u1:ev1", windowMs: 15_000 }));
  });
});

describe("review of f35de631", () => {
  it("M1: a post refused by the per-person limit touches no database and leaves the shared snapshot alone", async () => {
    mockAuth.mockResolvedValue(attendee);
    await get(); // warm the snapshot everyone reads
    vi.clearAllMocks();
    mockRate.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 30 });
    expect((await post({ body: "spam" })).status).toBe(429);
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
    mockRate.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
    await get();
    expect(mockDb.webinarChatMessage.findMany).not.toHaveBeenCalled(); // still served from the snapshot
  });

  it("M1: polls that miss together share one rebuild", async () => {
    await Promise.all([getChatSnapshot({}, "web", "s1"), getChatSnapshot({}, "web", "s1"), getChatSnapshot({}, "web", "s1")]);
    expect(mockDb.webinarChatMessage.findMany).toHaveBeenCalledTimes(1);
  });

  it("M1: a post is appended to the snapshot, no rebuild for the next poll", async () => {
    mockAuth.mockResolvedValue(attendee);
    mockDb.webinarChatMessage.create.mockResolvedValue({ ...msg("m9"), deletedAt: undefined });
    expect((await post({ body: "hi" })).status).toBe(201);
    const reads = mockDb.webinarChatMessage.findMany.mock.calls.length;
    const body = await (await get()).json();
    expect(body.messages.map((m: { id: string }) => m.id)).toContain("m9");
    expect(mockDb.webinarChatMessage.findMany.mock.calls.length).toBe(reads);
  });

  it("M2: a moderation version the page does not hold reloads the window, so a restored message comes back", () => {
    const snap = { version: 2, messages: [msg("m1"), msg("m2")].map(({ deletedAt, ...m }) => ({ ...m, deleted: deletedAt !== null })) };
    expect(messagesAfter(snap, "m2", 2).reset).toBe(false);
    const r = messagesAfter(snap, "m2", 1);
    expect(r.reset).toBe(true);
    expect(r.fresh.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("L3: messages from the few seconds before the cursor are sent again (a late commit is not skipped)", () => {
    const t = Date.parse("2026-11-06T09:00:00Z");
    const at = (id: string, ms: number) => ({ ...msg(id, { createdAt: new Date(t + ms) }), deleted: false });
    const snap = { version: 0, messages: [at("old", -60_000), at("late", -1_000), at("cursor", 0), at("new", 500)] };
    expect(messagesAfter(snap, "cursor", 0).fresh.map((m) => m.id)).toEqual(["late", "new"]);
  });

  it("L7: a pin that aged out of the window is still found", async () => {
    setEvent({ ...chatOn, pinnedMessageId: "old-pin" });
    setMessages([msg("m1")]);
    mockDb.webinarChatMessage.findFirst = vi.fn().mockResolvedValue(msg("old-pin", { authorKind: "staff", authorName: "Pro Ducer" }));
    mockAuth.mockResolvedValue(attendee);
    expect((await (await get()).json()).pinned).toMatchObject({ id: "old-pin" });
  });

  it("L6: bidi overrides, isolates and zero-width space are stripped; emoji joiners and RLM stay", () => {
    expect(cleanChatText("pay\u202Eexe.txt\u2066x\u2069\u200By")).toBe("payexe.txtxy");
    expect(cleanChatText("family 👨\u200D👩\u200D👧 \u200Fمرحبا")).toBe("family 👨\u200D👩\u200D👧 \u200Fمرحبا");
  });
});
