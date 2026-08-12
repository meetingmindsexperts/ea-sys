/**
 * Resident/trainee official letter — the two routes.
 *
 * The upload route is the first genuinely UNAUTHENTICATED file upload in the
 * system (every other public upload is token-gated), so its bounds are the
 * whole security story and are pinned here: magic bytes over declared type,
 * size, rate limit, and a real event.
 *
 * The download route is pinned on the property that matters after the fact: a
 * column value that is not a path we produced is never resolved against the
 * filesystem, even though the register POST already validated it on the way in.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockRateLimit, mockWriteFile, mockMkdir, mockReadFile, mockRealpath, mockAuth } =
  vi.hoisted(() => ({
    mockDb: {
      event: { findFirst: vi.fn() },
      registration: { findFirst: vi.fn() },
    },
    mockRateLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
    mockWriteFile: vi.fn().mockResolvedValue(undefined),
    mockMkdir: vi.fn().mockResolvedValue(undefined),
    mockReadFile: vi.fn().mockResolvedValue(Buffer.from("%PDF-1.7 body")),
    mockRealpath: vi.fn(),
    mockAuth: vi.fn(),
  }));

vi.mock("next/server", () => {
  class MockNextResponse {
    status: number;
    body: unknown;
    headers: Record<string, string>;
    constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = init?.headers ?? {};
    }
    static json(body: unknown, init?: { status?: number }) {
      return { status: init?.status ?? 200, json: async () => body };
    }
  }
  return { NextResponse: MockNextResponse };
});
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/security", () => ({
  getClientIp: () => "127.0.0.1",
  checkRateLimit: mockRateLimit,
}));
vi.mock("@/lib/public-event", () => ({
  publicEventWhere: vi.fn().mockResolvedValue({ slug: "evt" }),
}));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (_org: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth-guards", () => ({
  denyReviewer: vi.fn(() => null),
  REGISTRATION_DESK_ALLOW: ["ONSITE", "MEMBER"],
}));
vi.mock("@/lib/event-access", () => ({
  buildEventAccessWhere: (_u: unknown, id: string) => ({ id }),
}));
vi.mock("fs/promises", () => ({
  default: { mkdir: mockMkdir, writeFile: mockWriteFile },
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  realpath: mockRealpath,
}));

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function uploadRequest(file: File | null): Request {
  const fd = new FormData();
  if (file) fd.append("file", file);
  return { formData: async () => fd } as unknown as Request;
}

function fileOf(bytes: Uint8Array, type: string, name = "letter.pdf", size?: number): File {
  const f = new File([bytes.buffer as ArrayBuffer], name, { type });
  if (size !== undefined) Object.defineProperty(f, "size", { value: size });
  return f;
}

describe("POST /api/public/events/[slug]/resident-letter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
    mockDb.event.findFirst.mockResolvedValue({ id: "evt1" });
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
  });

  async function post(file: File | null) {
    const { POST } = await import(
      "@/app/api/public/events/[slug]/resident-letter/route"
    );
    return POST(uploadRequest(file), { params: Promise.resolve({ slug: "evt" }) });
  }

  it("stores a real PDF and returns a path our own validator accepts", async () => {
    const { isResidentLetterPath } = await import("@/lib/resident-letter");
    const res = await post(fileOf(PDF, "application/pdf"));
    expect(res.status).toBe(201);
    const body = await res.json();
    // The round trip is the contract: whatever this route returns has to be
    // accepted by the register POST's validator, or the letter is silently
    // dropped at submit.
    expect(isResidentLetterPath(body.url)).toBe(true);
    expect(body.filename).toBe("letter.pdf");
    expect(mockWriteFile).toHaveBeenCalledOnce();
  });

  it("never writes the registrant's filename to disk", async () => {
    const res = await post(fileOf(PDF, "application/pdf", "../../evil.pdf"));
    expect(res.status).toBe(201);
    const written = mockWriteFile.mock.calls[0][0] as string;
    expect(written).not.toContain("evil");
    expect(written).not.toContain("..");
    // ...but it is still reported back, so staff see what was sent.
    expect((await res.json()).filename).toBe("../../evil.pdf");
  });

  it("rejects a file whose BYTES do not match its declared type", async () => {
    // The declared Content-Type is attacker-supplied. A PHP/HTML payload
    // labelled application/pdf must not land on disk with a .pdf extension.
    const res = await post(fileOf(new Uint8Array([0x3c, 0x3f, 0x70, 0x68, 0x70]), "application/pdf"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/does not match/i);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("rejects a type we do not accept", async () => {
    const res = await post(fileOf(PDF, "image/svg+xml", "letter.svg"));
    expect(res.status).toBe(400);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("rejects a file over 5MB", async () => {
    const res = await post(fileOf(PDF, "application/pdf", "big.pdf", 6 * 1024 * 1024));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/5MB/);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("accepts PNG as well as PDF", async () => {
    const res = await post(fileOf(PNG, "image/png", "letter.png"));
    expect(res.status).toBe(201);
    expect((await res.json()).url).toMatch(/\.png$/);
  });

  it("400s when no file is attached", async () => {
    const res = await post(null);
    expect(res.status).toBe(400);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("429s when the per-IP limit is exhausted, before touching the DB", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 900 });
    const res = await post(fileOf(PDF, "application/pdf"));
    expect(res.status).toBe(429);
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("404s for an unknown or unpublished event WITHOUT buffering the body", async () => {
    // A bad slug should cost a lookup, not 5MB of ingest.
    mockDb.event.findFirst.mockResolvedValue(null);
    const formData = vi.fn();
    const { POST } = await import("@/app/api/public/events/[slug]/resident-letter/route");
    const res = await POST({ formData } as unknown as Request, {
      params: Promise.resolve({ slug: "nope" }),
    });
    expect(res.status).toBe(404);
    expect(formData).not.toHaveBeenCalled();
  });
});

describe("GET /api/events/[eventId]/registrations/[registrationId]/resident-letter", () => {
  const okPath = "/uploads/resident-letters/evt1/3f8b21ca-9d44-4e11-8a20-1f0b7c6d5e33.pdf";

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "ORGANIZER", organizationId: "org1" } });
    mockDb.event.findFirst.mockResolvedValue({ id: "evt1", organizationId: "org1" });
    mockDb.registration.findFirst.mockResolvedValue({
      residentLetterUrl: okPath,
      residentLetterFilename: "letter.pdf",
    });
    mockRealpath.mockImplementation(async (p: string) => p);
    mockReadFile.mockResolvedValue(Buffer.from("%PDF-1.7 body"));
  });

  async function get() {
    const { GET } = await import(
      "@/app/api/events/[eventId]/registrations/[registrationId]/resident-letter/route"
    );
    return GET({} as Request, {
      params: Promise.resolve({ eventId: "evt1", registrationId: "reg1" }),
    });
  }

  it("streams the letter to authorised staff", async () => {
    const res = (await get()) as unknown as { status: number; headers: Record<string, string> };
    expect(res.status).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/pdf");
    expect(res.headers["Cache-Control"]).toBe("private, no-store");
    // Never cached by a shared proxy, never sniffed into something executable.
    expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("401s an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(401);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("404s when the event is not one the caller may access", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(404);
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
  });

  it("404s when no letter is on file", async () => {
    mockDb.registration.findFirst.mockResolvedValue({
      residentLetterUrl: null,
      residentLetterFilename: null,
    });
    const res = await get();
    expect(res.status).toBe(404);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("REFUSES to resolve a stored path outside the letters directory", async () => {
    // Defence in depth: the register POST validates on write, but a read path
    // that trusts the column is one bad write away from arbitrary file
    // disclosure. Nothing reaches the filesystem here.
    mockDb.registration.findFirst.mockResolvedValue({
      residentLetterUrl: "/uploads/speaker-docs/evt1/passport.pdf",
      residentLetterFilename: "x.pdf",
    });
    const res = await get();
    expect(res.status).toBe(404);
    expect(mockRealpath).not.toHaveBeenCalled();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("REFUSES a symlink that escapes the letters directory", async () => {
    // The path passes the string check, so only realpath can catch this.
    mockRealpath.mockResolvedValue("/etc/passwd");
    const res = await get();
    expect(res.status).toBe(404);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("reports a missing file distinctly, so support is not left guessing", async () => {
    mockRealpath.mockRejectedValue(new Error("ENOENT"));
    const res = await get();
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("FILE_MISSING");
  });
});

describe("public /uploads catch-all — resident-letters prefix blocked", () => {
  // This is the ONLY path to public/uploads in production: `output: standalone`
  // does not serve public/ statically (that is why this catch-all exists at
  // all), so the route IS the block. Note that in `next dev` the framework's
  // own static handler shadows this route, which makes every private prefix —
  // reimbursements, speaker-docs, crm-deal-docs and now this one — readable by
  // URL on a developer machine. That is a pre-existing dev-only property, and
  // it is exactly why the guarantee is pinned at the route level here rather
  // than by curling a running dev server.
  it("403s any path under uploads/resident-letters/", async () => {
    const { GET } = await import("@/app/uploads/[...path]/route");
    const res = (await GET({} as never, {
      params: Promise.resolve({ path: ["resident-letters", "evt1", "letter.pdf"] }),
    } as never)) as unknown as { status: number };
    expect(res.status).toBe(403);
  });
});
