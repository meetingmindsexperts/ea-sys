/**
 * /api/events/:eventId/venue/drawing with the REAL permission code: dark while
 * the venue module is off; uploading needs events.update and a real image
 * (by its bytes, never its name) under 10 MB, stored in this event's private
 * folder; reading needs events.read and serves only a drawing this event's
 * upload named, from its own folder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockAuth, mockDb, rateLimit, upload, read } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { event: { findFirst: vi.fn() } },
  rateLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
  upload: vi.fn(async (_b: Buffer, name: string, _t: string, dir: string) => `/uploads/${dir}/${name}`),
  read: vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])),
}));

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
    static json(b: unknown, i?: { status?: number; headers?: Record<string, string> }) {
      const r = new NextResponse(b, i);
      return Object.assign(r, { json: async () => b });
    }
  }
  return { NextResponse };
});
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/security", async (orig) => ({ ...(await orig<typeof import("@/lib/security")>()), checkRateLimit: rateLimit }));
vi.mock("@/lib/storage", () => ({ uploadFile: upload, readStoredFile: read }));

import { GET, POST } from "@/app/api/events/[eventId]/venue/drawing/route";

type Res = { status: number; headers: Headers; json?: () => Promise<Record<string, unknown>> };
const params = { params: Promise.resolve({ eventId: "evt-1" }) };
const as = (role: string) => mockAuth.mockResolvedValue({ user: { id: `u-${role}`, role, organizationId: "org-1" } });
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const post = (bytes: Uint8Array<ArrayBuffer>, name = "plan.jpg") => {
  const body = new FormData();
  body.append("file", new File([new Uint8Array(bytes)], name, { type: "image/jpeg" }));
  return POST(new Request("http://localhost/x", { method: "POST", body }), params) as Promise<Res>;
};
const OWN = "/uploads/venue-drawings/evt-1/3f2b1c4e-5a6d-4e7f-8a9b-0c1d2e3f4a5b.jpg";
const get = (path: string) => GET(new Request(`http://localhost/x?path=${encodeURIComponent(path)}`), params) as Promise<Res>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("VENUE_MODULE_ENABLED", "true");
  mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST: storing a drawing", () => {
  it("404 while the module is off, 401 without a session, 403 for a read-only viewer", async () => {
    vi.stubEnv("VENUE_MODULE_ENABLED", "");
    as("ADMIN");
    expect((await post(JPEG)).status).toBe(404);
    vi.stubEnv("VENUE_MODULE_ENABLED", "true");
    mockAuth.mockResolvedValue(null);
    expect((await post(JPEG)).status).toBe(401);
    as("MEMBER");
    expect((await post(JPEG)).status).toBe(403);
    expect(upload).not.toHaveBeenCalled();
  });

  it("stores a real image in this event's private folder under a fresh name", async () => {
    as("ORGANIZER");
    const res = await post(JPEG);
    expect(res.status).toBe(200);
    const { path } = await res.json!();
    expect(path).toMatch(/^\/uploads\/venue-drawings\/evt-1\/[0-9a-f-]{36}\.jpg$/);
  });

  it("goes by the file's bytes, not its name: a PDF or an SVG named .jpg is refused", async () => {
    as("ADMIN");
    for (const bytes of [new TextEncoder().encode("%PDF-1.7 ..."), new TextEncoder().encode("<svg onload=alert(1)>")]) {
      const res = await post(bytes, "plan.jpg");
      expect(res.status).toBe(400);
      expect((await res.json!()).code).toBe("UNSUPPORTED_TYPE");
    }
    expect(upload).not.toHaveBeenCalled();
  });

  it("refuses a file over 10 MB, and an event the person cannot reach", async () => {
    as("ADMIN");
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(JPEG);
    expect((await post(big)).status).toBe(400);
    mockDb.event.findFirst.mockResolvedValue(null);
    expect((await post(JPEG)).status).toBe(404);
    expect(upload).not.toHaveBeenCalled();
  });

  it("refuses a store that hands back a public address instead of the private path", async () => {
    as("ADMIN");
    upload.mockResolvedValueOnce("https://bucket.example.com/venue-drawings/evt-1/x.jpg");
    const res = await post(JPEG);
    expect(res.status).toBe(500);
    expect((await res.json!()).error).toMatch(/private/);
  });

  it("a file just under nginx's 10 MB ceiling gets this route's own message", async () => {
    as("ADMIN");
    const big = new Uint8Array(9.75 * 1024 * 1024);
    big.set(JPEG);
    const res = await post(big);
    expect(res.status).toBe(400);
    expect((await res.json!()).code).toBe("TOO_LARGE");
  });

  it("429 past the hourly limit", async () => {
    as("ADMIN");
    rateLimit.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 60 });
    expect((await post(JPEG)).status).toBe(429);
  });
});

describe("GET: viewing a drawing", () => {
  it("serves this event's drawing to anyone who can see the event", async () => {
    as("MEMBER");
    const res = await get(OWN);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(read).toHaveBeenCalledWith(OWN, "/uploads/venue-drawings/evt-1/");
  });

  it("never serves another event's drawing, another folder, or a path that climbs out", async () => {
    as("ADMIN");
    for (const path of [
      "/uploads/venue-drawings/evt-2/3f2b1c4e-5a6d-4e7f-8a9b-0c1d2e3f4a5b.jpg",
      "/uploads/speaker-docs/evt-1/passport.jpg",
      "/uploads/venue-drawings/evt-1/../../speaker-docs/passport.jpg",
      "/uploads/venue-drawings/evt-1/notes.txt",
      "",
    ]) {
      expect((await get(path)).status).toBe(404);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("401 without a session, 404 when the event is out of reach", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await get(OWN)).status).toBe(401);
    as("ADMIN");
    mockDb.event.findFirst.mockResolvedValue(null);
    expect((await get(OWN)).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });
});
