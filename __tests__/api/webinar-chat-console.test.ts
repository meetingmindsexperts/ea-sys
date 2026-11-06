/**
 * Webinar chat, the producers' side (Nov 6, 2026; docs/WEBINAR_INTERACTION_PLAN.md §6.4): the
 * moderation feed with real names, the CSV record, the switches (never on without a moderator) and
 * the moderation actions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, store } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn(), findMany: vi.fn() },
    webinarChatMessage: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  },
  mockAuth: vi.fn(),
  store: { settings: {} as Record<string, unknown> },
}));

vi.mock("next/server", () => {
  class NextResponse {
    status: number;
    headers: Headers;
    private payload: string;
    constructor(body: string, init?: { status?: number; headers?: Record<string, string> }) {
      this.payload = body;
      this.status = init?.status ?? 200;
      this.headers = new Headers(init?.headers);
    }
    async text() {
      return this.payload;
    }
    async json() {
      return JSON.parse(this.payload);
    }
    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new NextResponse(JSON.stringify(body), init);
    }
  }
  return { NextResponse };
});
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/audit-data-transfer", () => ({ recordExport: vi.fn() }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4", checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/event-settings", () => ({
  updateEventSettings: vi.fn(async (_id: string, patch: (c: Record<string, unknown>) => Record<string, unknown>) => {
    store.settings = patch(store.settings);
    return store.settings;
  }),
}));

import { GET, PATCH, POST } from "@/app/api/events/[eventId]/webinar/chat/route";

const params = { params: Promise.resolve({ eventId: "ev1" }) };
const organizer = { user: { id: "u9", role: "ORGANIZER", organizationId: "org1", firstName: "Pro", lastName: "Ducer" } };
const member = { user: { id: "u8", role: "MEMBER", organizationId: "org1", firstName: "Mem", lastName: "Ber" } };
const req = (method: string, body?: unknown, query = "") =>
  new Request(`http://x/api/events/ev1/webinar/chat${query}`, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: { "content-type": "application/json" },
  });
const chatOf = () => (store.settings.webinar as { chat?: Record<string, unknown> }).chat ?? {};

function setChat(chat: Record<string, unknown>) {
  store.settings = {
    webinar: {
      sessionId: "s1",
      viewingMode: "hls",
      lobbyMessage: "keep me",
      chat,
      handouts: [{ id: "h1", name: "Slides.pdf", storedPath: "/x", contentType: "application/pdf", size: 1, uploadedAt: "" }],
    },
  };
}
const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  body: `msg ${id}`,
  authorName: "Sara Khan",
  authorKind: "attendee",
  anonymous: false,
  kind: "message",
  handoutId: null,
  registrationId: "r1",
  deletedAt: null,
  createdAt: new Date("2026-11-06T09:00:00Z"),
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  setChat({ enabled: true, moderatorUserId: "u9" });
  mockDb.event.findFirst.mockImplementation(async () => ({ id: "ev1", settings: store.settings }));
  mockDb.user.findFirst.mockResolvedValue({ id: "u9", firstName: "Pro", lastName: "Ducer" });
  mockDb.registration.findMany.mockResolvedValue([]);
  mockDb.registration.findFirst.mockResolvedValue({ id: "r1" });
  mockDb.webinarChatMessage.findMany.mockResolvedValue([]);
  mockDb.webinarChatMessage.findFirst.mockResolvedValue({ id: "m1" });
  mockDb.webinarChatMessage.updateMany.mockResolvedValue({ count: 1 });
  mockDb.webinarChatMessage.create.mockResolvedValue({ id: "m-new" });
});

describe("the moderation feed", () => {
  it("shows real names, even for an anonymous post, with the moderator and the muted", async () => {
    mockAuth.mockResolvedValue(organizer);
    setChat({ enabled: true, moderatorUserId: "u9", mutedRegistrationIds: ["r1"], pinnedMessageId: "m1" });
    mockDb.webinarChatMessage.findMany.mockResolvedValue([row("m1", { anonymous: true })]);
    mockDb.registration.findMany.mockResolvedValue([{ id: "r1", attendee: { firstName: "Sara", lastName: "Khan" } }]);
    const res = await GET(req("GET"), params);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await res.json();
    expect(body.messages[0]).toMatchObject({ authorName: "Sara Khan", anonymous: true, authorMuted: true, pinned: true });
    expect(body.moderator).toEqual({ id: "u9", name: "Pro Ducer", isMe: true });
    expect(body.muted).toEqual([{ registrationId: "r1", name: "Sara Khan" }]);
  });

  it("the CSV is the record: real author, what others saw, deletions; never cached", async () => {
    mockAuth.mockResolvedValue(organizer);
    mockDb.webinarChatMessage.findMany.mockResolvedValue([
      row("m1", { anonymous: true }),
      row("m2", { deletedAt: new Date("2026-11-06T09:05:00Z"), body: "=HYPERLINK(1)" }),
    ]);
    const res = await GET(req("GET", undefined, "?export=csv"), params);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const csv = await res.text();
    expect(csv).toContain("Sara Khan,Attendee (anonymous)");
    expect(csv).toContain("2026-11-06T09:05:00.000Z");
    expect(csv).not.toMatch(/,=HYPERLINK/); // formula injection neutralised
    expect(mockDb.webinarChatMessage.findMany.mock.calls[0][0]).not.toHaveProperty("take");
  });
});

describe("switches", () => {
  it("chat cannot be switched on without a moderator", async () => {
    mockAuth.mockResolvedValue(organizer);
    setChat({});
    const res = await PATCH(req("PATCH", { enabled: true }), params);
    expect(res.status).toBe(409);
    expect(chatOf().enabled).not.toBe(true);
  });

  it("'moderator: me' with 'on' names the producer and switches it on; other webinar settings untouched", async () => {
    mockAuth.mockResolvedValue(organizer);
    setChat({});
    const res = await PATCH(req("PATCH", { enabled: true, moderator: "me" }), params);
    expect(res.status).toBe(200);
    expect(chatOf()).toMatchObject({ enabled: true, moderatorUserId: "u9" });
    expect((store.settings.webinar as Record<string, unknown>).lobbyMessage).toBe("keep me");
  });

  it("mute everyone, slow mode and the waiting room switch are stored", async () => {
    mockAuth.mockResolvedValue(organizer);
    await PATCH(req("PATCH", { mutedAll: true, slowMode: true, openInLobby: true }), params);
    expect(chatOf()).toMatchObject({ mutedAll: true, slowMode: true, openInLobby: true, enabled: true });
  });

  it("a read-only Member can watch the feed but not change chat", async () => {
    mockAuth.mockResolvedValue(member);
    expect((await GET(req("GET"), params)).status).toBe(200);
    expect((await PATCH(req("PATCH", { mutedAll: true }), params)).status).toBe(403);
    expect((await POST(req("POST", { action: "unpin" }), params)).status).toBe(403);
  });
});

describe("moderation actions", () => {
  it("delete keeps the row for the record (who and when) and unpins it", async () => {
    mockAuth.mockResolvedValue(organizer);
    setChat({ enabled: true, moderatorUserId: "u9", pinnedMessageId: "m1" });
    expect((await POST(req("POST", { action: "delete", messageId: "m1" }), params)).status).toBe(200);
    const call = mockDb.webinarChatMessage.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ id: "m1", sessionId: "s1", eventId: "ev1" });
    expect(call.data).toMatchObject({ deletedById: "u9" });
    expect(call.data.deletedAt).toBeInstanceOf(Date);
    expect(chatOf().pinnedMessageId).toBeNull();
  });

  it("a message from another session or event is not found", async () => {
    mockAuth.mockResolvedValue(organizer);
    mockDb.webinarChatMessage.updateMany.mockResolvedValue({ count: 0 });
    expect((await POST(req("POST", { action: "delete", messageId: "elsewhere" }), params)).status).toBe(404);
  });

  it("mute and unmute a person, only a registration of this event", async () => {
    mockAuth.mockResolvedValue(organizer);
    await POST(req("POST", { action: "mute", registrationId: "r1" }), params);
    expect(chatOf().mutedRegistrationIds).toEqual(["r1"]);
    await POST(req("POST", { action: "unmute", registrationId: "r1" }), params);
    expect(chatOf().mutedRegistrationIds).toEqual([]);
    mockDb.registration.findFirst.mockResolvedValue(null);
    expect((await POST(req("POST", { action: "mute", registrationId: "other-event" }), params)).status).toBe(404);
  });

  it("pin a message of this webinar; unpin", async () => {
    mockAuth.mockResolvedValue(organizer);
    await POST(req("POST", { action: "pin", messageId: "m1" }), params);
    expect(chatOf().pinnedMessageId).toBe("m1");
    await POST(req("POST", { action: "unpin" }), params);
    expect(chatOf().pinnedMessageId).toBeNull();
  });

  it("a host post and a shared handout are stored as staff, named from the account", async () => {
    mockAuth.mockResolvedValue(organizer);
    expect((await POST(req("POST", { action: "post", body: "Slides here", handoutId: "h1" }), params)).status).toBe(201);
    expect(mockDb.webinarChatMessage.create.mock.calls[0][0].data).toMatchObject({
      authorKind: "staff",
      authorName: "Pro Ducer",
      userId: "u9",
      kind: "handout",
      handoutId: "h1",
      organizationId: "org1",
    });
    expect((await POST(req("POST", { action: "post", body: "x", handoutId: "gone" }), params)).status).toBe(404);
  });
});
