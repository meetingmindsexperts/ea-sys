/**
 * Webinar handouts (Oct 6, 2026; docs/WEBINAR_INTERACTION_PLAN.md §4). Owner
 * decisions pinned here: private files opened only by a signed-in registrant
 * of the webinar (or org staff testing); PDF, PPTX and DOCX up to 8 MB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockStorage, state } = vi.hoisted(() => {
  const state = { settings: {} as Record<string, unknown> };
  return {
    state,
    mockAuth: vi.fn(),
    mockStorage: {
      uploadFile: vi.fn(),
      deleteStoredFile: vi.fn(),
      readStoredFile: vi.fn(),
    },
    mockDb: {
      event: { findFirst: vi.fn() },
      registration: { findFirst: vi.fn() },
      // updateHandouts: SELECT ... FOR UPDATE, then a jsonb_set UPDATE.
      $queryRaw: vi.fn(async () => [{ settings: state.settings }]),
      // Called as (strings, json, eventId): written() reads the json.
      $executeRaw: vi.fn(async () => 1),
    },
  };
});

vi.mock("next/server", () => {
  class NextResponse {
    status: number;
    headers: Headers;
    body: unknown;
    constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = new Headers(init?.headers);
    }
    async json() {
      return this.body;
    }
    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new NextResponse(body, init);
    }
  }
  return { NextResponse };
});
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: (tx: typeof mockDb) => unknown) => fn(mockDb) }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/public-event", () => ({ publicEventWhere: vi.fn(async () => ({})) }));
const { rate } = vi.hoisted(() => ({ rate: { allowed: true } }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: rate.allowed, retryAfterSeconds: 60 }), getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/storage", () => mockStorage);

import { POST as upload, PATCH as reorder } from "@/app/api/events/[eventId]/webinar/handouts/route";
import { DELETE as remove, GET as staffOpen } from "@/app/api/events/[eventId]/webinar/handouts/[handoutId]/route";
import { StorageError } from "@/lib/storage-errors";
import { removeHandoutFiles } from "@/lib/webinar/handout-download";
import { GET as list } from "@/app/api/public/events/[slug]/sessions/[sessionId]/handouts/route";
import { GET as download } from "@/app/api/public/events/[slug]/sessions/[sessionId]/handouts/[handoutId]/route";
import {
  MAX_HANDOUTS,
  handoutBytesMatch,
  keepStoredHandouts,
  readHandouts,
  resolveHandoutType,
  sanitizeHandoutName,
  type WebinarHandout,
} from "@/lib/webinar/handouts";

const PDF = "application/pdf";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const organizer = { user: { id: "u9", role: "ORGANIZER", organizationId: "org1", firstName: "Org", lastName: "Staff" } };
const member = { user: { id: "u8", role: "MEMBER", organizationId: "org1", firstName: "Mem", lastName: "Ber" } };
const attendee = { user: { id: "u1", role: "REGISTRANT", organizationId: null, firstName: "A", lastName: "B" } };
const H = (id: string, extra: Partial<WebinarHandout> = {}): WebinarHandout => ({
  id,
  name: `${id}.pdf`,
  storedPath: `/uploads/webinar-handouts/ev1/${id}.pdf`,
  contentType: PDF,
  size: 1000,
  uploadedAt: "2026-10-06T10:00:00.000Z",
  ...extra,
});
const staffParams = { params: Promise.resolve({ eventId: "ev1" }) };
const publicParams = { params: Promise.resolve({ slug: "web", sessionId: "s1" }) };

function multipart(file: File | null): Request {
  const fd = new FormData();
  if (file) fd.append("file", file);
  return { formData: async () => fd, headers: new Headers() } as unknown as Request;
}
const pdfFile = (name = "Slides.pdf", bytes = "%PDF-1.7 body") => new File([bytes], name, { type: PDF });
/** The list the last UPDATE wrote (the JSON is the first bound value). */
function written(): WebinarHandout[] | null {
  const call = mockDb.$executeRaw.mock.calls.at(-1) as unknown[] | undefined;
  return call ? (JSON.parse(call[1] as string) as WebinarHandout[]) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  rate.allowed = true;
  state.settings = { webinar: { sessionId: "s1", handouts: [H("h1"), H("h2")] } };
  mockDb.event.findFirst.mockImplementation(async () => ({
    id: "ev1",
    organizationId: "org1",
    eventType: "WEBINAR",
    settings: state.settings,
  }));
  mockDb.registration.findFirst.mockResolvedValue(null);
  mockStorage.uploadFile.mockResolvedValue("/uploads/webinar-handouts/ev1/new.pdf");
  mockStorage.deleteStoredFile.mockResolvedValue(undefined);
  mockStorage.readStoredFile.mockResolvedValue(Buffer.from("%PDF-1.7 body"));
});

describe("the handouts module", () => {
  it("allows PDF, PPTX and DOCX by extension, and refuses a reported type that disagrees", () => {
    expect(resolveHandoutType({ name: "a.pdf", type: "" })).toBe(PDF);
    expect(resolveHandoutType({ name: "deck.PPTX", type: "application/octet-stream" })).toBe(PPTX);
    expect(resolveHandoutType({ name: "a.exe", type: PDF })).toBeNull();
    expect(resolveHandoutType({ name: "a.pdf", type: PPTX })).toBeNull();
  });

  it("checks the first bytes, so a renamed file cannot pass", () => {
    expect(handoutBytesMatch(new TextEncoder().encode("%PDF-1.4"), PDF)).toBe(true);
    expect(handoutBytesMatch(new TextEncoder().encode("PK\u0003\u0004"), PPTX)).toBe(true);
    expect(handoutBytesMatch(new TextEncoder().encode("MZ\u0090"), PDF)).toBe(false);
  });

  it("sanitises the display name and forces the extension", () => {
    expect(sanitizeHandoutName('../../etc/"evil"<x>.pdf', PDF)).toBe("evilx.pdf");
    expect(sanitizeHandoutName("Deck.final.pptx", PPTX)).toBe("Deck.final.pptx");
    expect(sanitizeHandoutName("", PDF)).toBe("handout.pdf");
  });

  it("ignores malformed entries in settings", () => {
    expect(readHandouts({ handouts: [H("ok"), { id: 1 }, null, "x"] }).map((h) => h.id)).toEqual(["ok"]);
    expect(readHandouts({ handouts: "nope" })).toEqual([]);
  });
});

describe("console: add a handout", () => {
  it("stores a PDF under this event's private prefix and appends it to the list", async () => {
    mockAuth.mockResolvedValue(organizer);
    const res = await upload(multipart(pdfFile()), staffParams);
    expect(res.status).toBe(201);
    expect(mockStorage.uploadFile.mock.calls[0][3]).toBe("webinar-handouts/ev1");
    const list = written()!;
    expect(list.map((h) => h.id).slice(0, 2)).toEqual(["h1", "h2"]);
    expect(list[2]).toMatchObject({ name: "Slides.pdf", contentType: PDF, storedPath: "/uploads/webinar-handouts/ev1/new.pdf" });
  });

  it("needs webinar.manage: a MEMBER (read only) is refused and nothing is stored", async () => {
    mockAuth.mockResolvedValue(member);
    const res = await upload(multipart(pdfFile()), staffParams);
    expect(res.status).toBe(403);
    expect(mockStorage.uploadFile).not.toHaveBeenCalled();
  });

  it("refuses another type, a renamed file and anything over 8 MB", async () => {
    mockAuth.mockResolvedValue(organizer);
    expect((await upload(multipart(new File(["x"], "a.exe")), staffParams)).status).toBe(400);
    expect((await upload(multipart(pdfFile("a.pdf", "MZ not a pdf")), staffParams)).status).toBe(400);
    const big = pdfFile();
    Object.defineProperty(big, "size", { value: 8 * 1024 * 1024 + 1 });
    expect((await upload(multipart(big), staffParams)).status).toBe(400);
    expect(mockStorage.uploadFile).not.toHaveBeenCalled();
  });

  it("refuses an 11th handout and removes the file it had just stored", async () => {
    mockAuth.mockResolvedValue(organizer);
    state.settings = { webinar: { sessionId: "s1", handouts: Array.from({ length: MAX_HANDOUTS }, (_, i) => H(`h${i}`)) } };
    const res = await upload(multipart(pdfFile()), staffParams);
    expect(res.status).toBe(400);
    expect(mockDb.$executeRaw).not.toHaveBeenCalled();
    expect(mockStorage.deleteStoredFile).toHaveBeenCalledWith("/uploads/webinar-handouts/ev1/new.pdf", "/uploads/webinar-handouts/ev1/");
  });

  it("only on a webinar", async () => {
    mockAuth.mockResolvedValue(organizer);
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1", eventType: "CONFERENCE", settings: {} });
    expect((await upload(multipart(pdfFile()), staffParams)).status).toBe(400);
  });
});

describe("console: reorder and remove", () => {
  const patch = (body: unknown) => reorder({ json: async () => body } as unknown as Request, staffParams);

  it("reorders when the order names exactly the current handouts", async () => {
    mockAuth.mockResolvedValue(organizer);
    expect((await patch({ order: ["h2", "h1"] })).status).toBe(200);
    expect(written()!.map((h) => h.id)).toEqual(["h2", "h1"]);
  });

  it("a stale or padded order is refused (409), nothing written", async () => {
    mockAuth.mockResolvedValue(organizer);
    expect((await patch({ order: ["h2"] })).status).toBe(409);
    expect((await patch({ order: ["h2", "h2"] })).status).toBe(409);
    expect((await patch({ order: ["h2", "hX"] })).status).toBe(409);
    expect(mockDb.$executeRaw).not.toHaveBeenCalled();
  });

  it("remove takes it off the list, then deletes the file", async () => {
    mockAuth.mockResolvedValue(organizer);
    const res = await remove(new Request("http://x"), { params: Promise.resolve({ eventId: "ev1", handoutId: "h1" }) });
    expect(res.status).toBe(200);
    expect(written()!.map((h) => h.id)).toEqual(["h2"]);
    // Guarded to this event's own folder, never the handouts root.
    expect(mockStorage.deleteStoredFile).toHaveBeenCalledWith("/uploads/webinar-handouts/ev1/h1.pdf", "/uploads/webinar-handouts/ev1/");
  });

  it("removing an unknown handout is a 404 and deletes nothing", async () => {
    mockAuth.mockResolvedValue(organizer);
    const res = await remove(new Request("http://x"), { params: Promise.resolve({ eventId: "ev1", handoutId: "nope" }) });
    expect(res.status).toBe(404);
    expect(mockStorage.deleteStoredFile).not.toHaveBeenCalled();
  });
});

describe("attendee: list and download", () => {
  const asRegistrant = () => {
    mockAuth.mockResolvedValue(attendee);
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1", attendee: { firstName: "A", lastName: "B" } });
  };
  const get = (handoutId: string) =>
    download(new Request("http://x"), { params: Promise.resolve({ slug: "web", sessionId: "s1", handoutId }) });

  it("signed out: refused, for the list and the file", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await list(new Request("http://x"), publicParams)).status).toBe(401);
    expect((await get("h1")).status).toBe(401);
    expect(mockStorage.readStoredFile).not.toHaveBeenCalled();
  });

  it("signed in but not registered: refused (a forwarded link opens for no one else)", async () => {
    mockAuth.mockResolvedValue(attendee);
    expect((await list(new Request("http://x"), publicParams)).status).toBe(403);
    expect((await get("h1")).status).toBe(403);
    expect(mockStorage.readStoredFile).not.toHaveBeenCalled();
  });

  it("a registrant gets the list without storage paths", async () => {
    asRegistrant();
    const body = (await (await list(new Request("http://x"), publicParams)).json()) as { handouts: object[] };
    expect(body.handouts).toEqual([
      { id: "h1", name: "h1.pdf", contentType: PDF, size: 1000 },
      { id: "h2", name: "h2.pdf", contentType: PDF, size: 1000 },
    ]);
  });

  it("a registrant downloads, read through this event's own prefix", async () => {
    asRegistrant();
    const res = await get("h1");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(PDF);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mockStorage.readStoredFile).toHaveBeenCalledWith("/uploads/webinar-handouts/ev1/h1.pdf", "/uploads/webinar-handouts/ev1/");
  });

  it("a path outside this event's prefix is never read", async () => {
    asRegistrant();
    state.settings = { webinar: { sessionId: "s1", handouts: [H("h1", { storedPath: "/uploads/webinar-handouts/OTHER/x.pdf" })] } };
    expect((await get("h1")).status).toBe(404);
    expect(mockStorage.readStoredFile).not.toHaveBeenCalled();
  });

  it("only the webinar's room session serves handouts", async () => {
    asRegistrant();
    state.settings = { webinar: { sessionId: "other", handouts: [H("h1")] } };
    expect((await get("h1")).status).toBe(404);
  });

  it("org staff testing the page can open them", async () => {
    mockAuth.mockResolvedValue(organizer);
    expect((await get("h2")).status).toBe(200);
  });
});

describe("review of handouts (Oct 6, 2026)", () => {
  const asRegistrant = () => {
    mockAuth.mockResolvedValue(attendee);
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1", attendee: { firstName: "A", lastName: "B" } });
  };
  const get = (handoutId: string) =>
    download(new Request("http://x"), { params: Promise.resolve({ slug: "web", sessionId: "s1", handoutId }) });

  it("a cancelled registration never counts: the lookup excludes CANCELLED, oldest first", async () => {
    asRegistrant();
    await get("h1");
    expect(mockDb.registration.findFirst.mock.calls[0][0]).toMatchObject({
      where: { eventId: "ev1", userId: "u1", status: { not: "CANCELLED" } },
      orderBy: { createdAt: "asc" },
    });
  });

  it("downloads are rate limited per person (429, nothing read)", async () => {
    asRegistrant();
    rate.allowed = false;
    expect((await get("h1")).status).toBe(429);
    expect(mockStorage.readStoredFile).not.toHaveBeenCalled();
  });

  it("a listed file missing from storage is a 404, not a 500", async () => {
    asRegistrant();
    mockStorage.readStoredFile.mockRejectedValue(new StorageError("not-found", "gone"));
    expect((await get("h1")).status).toBe(404);
  });

  it("staff open a handout from the console (read access is enough), through the same folder check", async () => {
    mockAuth.mockResolvedValue(member);
    const res = await staffOpen(new Request("http://x"), { params: Promise.resolve({ eventId: "ev1", handoutId: "h2" }) });
    expect(res.status).toBe(200);
    expect(mockStorage.readStoredFile).toHaveBeenCalledWith("/uploads/webinar-handouts/ev1/h2.pdf", "/uploads/webinar-handouts/ev1/");
  });

  it("an upload whose list write throws removes the stored file again", async () => {
    mockAuth.mockResolvedValue(organizer);
    mockDb.$executeRaw.mockRejectedValueOnce(new Error("db down"));
    const res = await upload(multipart(pdfFile()), staffParams);
    expect(res.status).toBe(500);
    expect(mockStorage.deleteStoredFile).toHaveBeenCalledWith("/uploads/webinar-handouts/ev1/new.pdf", "/uploads/webinar-handouts/ev1/");
  });

  it("the general settings save keeps the stored handouts: it can neither wipe nor plant them", () => {
    const current = { webinar: { sessionId: "s1", handouts: [H("h1")] }, other: 1 };
    const wiped = keepStoredHandouts(current, { ...current, webinar: { sessionId: "s1", lobbyMessage: "hi" } });
    expect((wiped.webinar as { handouts: unknown[] }).handouts).toEqual([H("h1")]);
    const planted = keepStoredHandouts(current, {
      ...current,
      webinar: { sessionId: "s1", handouts: [H("x", { storedPath: "/uploads/webinar-handouts/OTHER/x.pdf" })] },
    });
    expect((planted.webinar as { handouts: unknown[] }).handouts).toEqual([H("h1")]);
    // No stored list and none sent: nothing invented.
    expect(keepStoredHandouts({}, { webinar: { handouts: [H("x")] } }).webinar).toEqual({});
    // A save without a webinar object is untouched.
    expect(keepStoredHandouts(current, { other: 2 })).toEqual({ other: 2 });
  });

  it("deleting an event removes its handout files, each only from its own folder, and never throws", async () => {
    mockStorage.deleteStoredFile.mockRejectedValueOnce(new Error("s3 down"));
    await expect(removeHandoutFiles("ev1", [H("h1"), H("h2")])).resolves.toBeUndefined();
    expect(mockStorage.deleteStoredFile).toHaveBeenCalledTimes(2);
    expect(mockStorage.deleteStoredFile).toHaveBeenLastCalledWith("/uploads/webinar-handouts/ev1/h2.pdf", "/uploads/webinar-handouts/ev1/");
  });
});
