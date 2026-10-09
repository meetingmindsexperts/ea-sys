/**
 * GET /e/:slug/venue (review L10): signed out goes to sign-in and back, the
 * event's own text can never close the inline <script> it is written into,
 * and the page (it carries the person's id and name) is never cached.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockAuth, mockDb } = vi.hoisted(() => ({ mockAuth: vi.fn(), mockDb: { event: { findFirst: vi.fn() } } }));

vi.mock("next/server", () => {
  class NextResponse {
    status: number;
    headers: Headers;
    constructor(public body: string | null, init?: { status?: number; headers?: Record<string, string> }) {
      this.status = init?.status ?? 200;
      this.headers = new Headers(init?.headers);
    }
    static json(b: unknown, i?: { status?: number }) { return new NextResponse(JSON.stringify(b), i); }
    static redirect(u: URL) { const r = new NextResponse(null, { status: 307 }); r.headers.set("location", String(u)); return r; }
  }
  return { NextResponse };
});
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
const { loadVenueProgramme } = vi.hoisted(() => ({ loadVenueProgramme: vi.fn() }));
vi.mock("@/services/venue-programme-service", () => ({ loadVenueProgramme }));

import { GET } from "@/app/e/[slug]/venue/route";

const EVENT = {
  id: "evt-1", slug: "ehc26", name: "EHC", startDate: new Date("2026-04-10T06:00:00Z"), endDate: new Date("2026-04-12T06:00:00Z"),
  venue: "Conrad Dubai", timezone: "Asia/Dubai", eventType: "CONFERENCE", settings: {}, organizationId: "org-1", staffAssignments: [],
};
const open = () => GET(new Request("http://0.0.0.0:3000/e/ehc26/venue"), { params: Promise.resolve({ slug: "ehc26" }) }) as unknown as Promise<{ status: number; body: string; headers: Headers }>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("VENUE_EVENT_SLUGS", "ehc26");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://events.example.test");
  mockAuth.mockResolvedValue({ user: { id: "u-1", role: "ADMIN", organizationId: "org-1", name: "Wren" } });
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  loadVenueProgramme.mockResolvedValue({ v: 1, tz: "Asia/Dubai", sessions: [], sponsors: [] });
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /e/:slug/venue", () => {
  it("sends a signed-out visitor to sign in on the public URL, then back to the venue", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await open();
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://events.example.test/login?callbackUrl=%2Fe%2Fehc26%2Fvenue");
  });

  it("writes event text into the page so it can never close the script it sits in", async () => {
    const name = "EHC </script><script>alert(1)</script> <!-- \u2028\u2029 end";
    mockDb.event.findFirst.mockResolvedValue({ ...EVENT, name, venue: "</SCRIPT><img src=x onerror=alert(2)>" });
    const res = await open();
    expect(res.status).toBe(200);
    const injected = res.body.slice(0, res.body.indexOf('<script src="/venue-runtime.js">'));
    expect(injected.match(/<\/script>/gi)).toHaveLength(1); // only the inline block's own closing tag
    expect(injected).not.toContain("<!--");
    expect(injected).not.toMatch(/[\u2028\u2029]/);
    expect(injected).toContain("\\u003c/script>");
    // and it still reads back as the same text
    const literal = injected.match(/window\.EHC_EVENT=(.*?);window\.EHC_VENUE=/)![1];
    expect(JSON.parse(literal).name).toBe(name);
  });

  it("is never cached: it carries the person's id and name", async () => {
    const res = await open();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.body).toContain('"userId":"u-1"');
  });

  it("is not found for an event that is not listed", async () => {
    vi.stubEnv("VENUE_EVENT_SLUGS", "");
    expect((await open()).status).toBe(404);
  });

  it("sends a generated venue's layout and the event's own names when its rooms are saved and open", async () => {
    vi.stubEnv("VENUE_EVENT_SLUGS", "");
    vi.stubEnv("VENUE_MODULE_ENABLED", "true");
    const rooms = { list: [{ id: "foyer", name: "Foyer", kind: "foyer", capacity: 200 }, { id: "plenary", name: "Main Hall", kind: "plenary", capacity: 300 }], updatedAt: 1, updatedBy: "u" };
    mockDb.event.findFirst.mockResolvedValue({ ...EVENT, slug: "summit27", code: "SUM27", organization: { name: "MM Group" }, settings: { venue: { rooms, open: true } } });
    const res = await open();
    expect(res.status).toBe(200);
    const layout = JSON.parse(res.body.match(/window\.EHC_LAYOUT=(.*?);window\.EHC_EVENT=/)![1]);
    expect(layout.zones.map((z: { id: string }) => z.id)).toEqual(["foyer", "corridor", "plenary"]);
    const ev = JSON.parse(res.body.match(/window\.EHC_EVENT=(.*?);window\.EHC_VENUE=/)![1]);
    expect(ev).toMatchObject({ short: "SUM27", organiser: "MM Group" });
  });

  it("sends the event's programme, placed in the rooms of the venue it serves", async () => {
    const prog = { v: 1, tz: "Asia/Dubai", sessions: [{ room: "plenary", title: "</script> Opening", start: "2026-04-10T05:00:00.000Z", end: "2026-04-10T06:00:00.000Z" }], sponsors: [{ name: "Novartis" }] };
    loadVenueProgramme.mockResolvedValue(prog);
    const res = await open();
    const [caller, rooms, tz] = loadVenueProgramme.mock.calls[0];
    expect(caller).toEqual({ organizationId: "org-1", eventId: "evt-1" });
    expect(rooms).toContainEqual({ id: "hallA", name: "Hall A" });
    expect(tz).toBe("Asia/Dubai");
    const sent = JSON.parse(res.body.match(/window\.EHC_PROGRAMME=(.*?);<\/script>/)![1]);
    expect(sent).toEqual(prog);
  });

  it("keeps EHC's hand-built rooms (no layout) for a listed event with no saved rooms", async () => {
    const res = await open();
    expect(res.body).toContain("window.EHC_LAYOUT=null;");
  });

  it("is not found while saved rooms are not opened", async () => {
    vi.stubEnv("VENUE_EVENT_SLUGS", "");
    vi.stubEnv("VENUE_MODULE_ENABLED", "true");
    mockDb.event.findFirst.mockResolvedValue({ ...EVENT, settings: { venue: { rooms: { list: [{ id: "foyer", name: "Foyer", kind: "foyer", capacity: 200 }], updatedAt: 1 } } } });
    expect((await open()).status).toBe(404);
  });
});
