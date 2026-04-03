import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockAuth, mockDb, mockApiLogger, mockUploadMedia, mockDeleteMedia } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    mediaFile: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
  },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  mockUploadMedia: vi.fn(),
  mockDeleteMedia: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/auth-guards", () => ({
  denyReviewer: vi.fn((session: { user: { role: string } }) => {
    if (["REVIEWER", "SUBMITTER"].includes(session.user.role)) {
      return { status: 403, json: async () => ({ error: "Forbidden" }) };
    }
    return null;
  }),
}));
vi.mock("@/lib/event-access", () => ({
  buildEventAccessWhere: vi.fn(() => ({ organizationId: "org-1" })),
}));
vi.mock("@/lib/storage", () => ({
  uploadMedia: (...args: unknown[]) => mockUploadMedia(...args),
  deleteMedia: (...args: unknown[]) => mockDeleteMedia(...args),
  storageProvider: "local",
}));
vi.mock("@/lib/security", () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true, retryAfterSeconds: 0 }),
}));
vi.mock("crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("crypto")>();
  return { ...actual, randomUUID: vi.fn(() => "test-uuid-1234") };
});

import { GET, POST } from "@/app/api/events/[eventId]/media/route";
import { DELETE } from "@/app/api/events/[eventId]/media/[mediaId]/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeParams(eventId = "evt-1") {
  return { params: Promise.resolve({ eventId }) };
}

function makeMediaParams(eventId = "evt-1", mediaId = "media-1") {
  return { params: Promise.resolve({ eventId, mediaId }) };
}

function makeGetRequest(query = "") {
  return new Request(`http://localhost/api/events/evt-1/media${query}`, { method: "GET" });
}

const adminSession = { user: { id: "user-1", role: "ADMIN", organizationId: "org-1" } };
const reviewerSession = { user: { id: "rev-1", role: "REVIEWER", organizationId: null } };

// Build a fake JPEG file with correct magic bytes (FF D8 FF)
function makeFakeJpegFile(name = "photo.jpg", size = 1024): File {
  const buffer = new Uint8Array(size);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  buffer[3] = 0xe0;
  return new File([buffer], name, { type: "image/jpeg" });
}

// Build a fake PNG file with correct magic bytes
function makeFakePngFile(name = "image.png", size = 1024): File {
  const buffer = new Uint8Array(size);
  buffer[0] = 0x89;
  buffer[1] = 0x50;
  buffer[2] = 0x4e;
  buffer[3] = 0x47;
  buffer[4] = 0x0d;
  buffer[5] = 0x0a;
  buffer[6] = 0x1a;
  buffer[7] = 0x0a;
  return new File([buffer], name, { type: "image/png" });
}

// Build a fake file with no valid magic bytes but with an allowed MIME type
function makeSpoofedFile(name = "evil.jpg"): File {
  const buffer = new Uint8Array(100).fill(0x00);
  return new File([buffer], name, { type: "image/jpeg" });
}

async function makePostRequest(file: File): Promise<Request> {
  const formData = new FormData();
  formData.append("file", file);
  return new Request("http://localhost/api/events/evt-1/media", {
    method: "POST",
    body: formData,
  });
}

const sampleMediaFiles = [
  {
    id: "media-1",
    filename: "photo.jpg",
    url: "/uploads/media/2026/04/test-uuid.jpg",
    mimeType: "image/jpeg",
    size: 1024,
    createdAt: new Date("2026-04-01"),
    uploadedBy: { firstName: "Alice", lastName: "Smith" },
  },
];

// ── GET: list event media ─────────────────────────────────────────────────────

describe("GET /events/[eventId]/media: authentication", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(makeGetRequest(), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 403 for REVIEWER", async () => {
    mockAuth.mockResolvedValue(reviewerSession);
    const res = await GET(makeGetRequest(), makeParams());
    expect(res.status).toBe(403);
  });
});

describe("GET /events/[eventId]/media: listing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.mediaFile.findMany.mockResolvedValue(sampleMediaFiles);
    mockDb.mediaFile.count.mockResolvedValue(1);
  });

  it("returns 404 when event not found", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await GET(makeGetRequest(), makeParams());
    expect(res.status).toBe(404);
  });

  it("returns paginated media files", async () => {
    const res = await GET(makeGetRequest(), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mediaFiles).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(50);
  });

  it("uses default page=1 and limit=50 when params missing", async () => {
    const res = await GET(makeGetRequest(), makeParams());
    const body = await res.json();
    expect(body.page).toBe(1);
    expect(body.limit).toBe(50);
  });
});

describe("GET /events/[eventId]/media: NaN-safe pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.mediaFile.findMany.mockResolvedValue([]);
    mockDb.mediaFile.count.mockResolvedValue(0);
  });

  it("falls back to page=1 when page param is NaN", async () => {
    const res = await GET(makeGetRequest("?page=abc"), makeParams());
    const body = await res.json();
    expect(body.page).toBe(1);
  });

  it("falls back to limit=50 when limit param is NaN", async () => {
    const res = await GET(makeGetRequest("?limit=xyz"), makeParams());
    const body = await res.json();
    expect(body.limit).toBe(50);
  });

  it("clamps limit to max 100", async () => {
    const res = await GET(makeGetRequest("?limit=500"), makeParams());
    const body = await res.json();
    expect(body.limit).toBe(100);
  });

  it("clamps page to min 1 for zero value", async () => {
    const res = await GET(makeGetRequest("?page=0"), makeParams());
    const body = await res.json();
    expect(body.page).toBe(1);
  });
});

// ── POST: upload event media ──────────────────────────────────────────────────

describe("POST /events/[eventId]/media: authentication", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = await makePostRequest(makeFakeJpegFile());
    const res = await POST(req, makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 403 for REVIEWER", async () => {
    mockAuth.mockResolvedValue(reviewerSession);
    const req = await makePostRequest(makeFakeJpegFile());
    const res = await POST(req, makeParams());
    expect(res.status).toBe(403);
  });
});

describe("POST /events/[eventId]/media: file validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
  });

  it("returns 400 when no file is provided", async () => {
    const formData = new FormData();
    const req = new Request("http://localhost/api/events/evt-1/media", { method: "POST", body: formData });
    const res = await POST(req, makeParams());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "No file provided" });
  });

  it("returns 400 for disallowed MIME type", async () => {
    const gifFile = new File([new Uint8Array(100)], "image.gif", { type: "image/gif" });
    const req = await makePostRequest(gifFile);
    const res = await POST(req, makeParams());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("JPEG") });
  });

  it("returns 400 when file exceeds 2MB", async () => {
    const largeBuffer = new Uint8Array(3 * 1024 * 1024);
    largeBuffer[0] = 0xff; largeBuffer[1] = 0xd8; largeBuffer[2] = 0xff;
    const bigFile = new File([largeBuffer], "big.jpg", { type: "image/jpeg" });
    const req = await makePostRequest(bigFile);
    const res = await POST(req, makeParams());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("2MB") });
  });

  it("returns 400 when magic bytes do not match claimed MIME type (spoofed file)", async () => {
    const req = await makePostRequest(makeSpoofedFile());
    const res = await POST(req, makeParams());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("valid") });
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringContaining("magic bytes mismatch") })
    );
  });
});

describe("POST /events/[eventId]/media: filename sanitization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockUploadMedia.mockResolvedValue("/uploads/media/2026/04/test-uuid-1234.jpg");
    mockDb.mediaFile.create.mockResolvedValue({
      id: "media-new",
      url: "/uploads/media/2026/04/test-uuid-1234.jpg",
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      size: 1024,
      createdAt: new Date(),
    });
  });

  it("strips path separators from filename", async () => {
    const file = makeFakeJpegFile("subdir/photo.jpg");
    const req = await makePostRequest(file);
    await POST(req, makeParams());
    const createCall = mockDb.mediaFile.create.mock.calls[0][0];
    const savedFilename: string = createCall.data.filename;
    expect(savedFilename).not.toContain("/");
    expect(savedFilename).not.toContain("\\");
  });

  it("truncates filename to 255 characters", async () => {
    const longName = "a".repeat(300) + ".jpg";
    const file = makeFakeJpegFile(longName);
    const req = await makePostRequest(file);
    await POST(req, makeParams());
    const createCall = mockDb.mediaFile.create.mock.calls[0][0];
    expect((createCall.data.filename as string).length).toBeLessThanOrEqual(255);
  });

  it("saved filename is non-empty for a normally-named file", async () => {
    const file = makeFakeJpegFile("photo.jpg");
    const req = await makePostRequest(file);
    await POST(req, makeParams());
    const createCall = mockDb.mediaFile.create.mock.calls[0][0];
    const savedFilename: string = createCall.data.filename;
    expect(savedFilename.length).toBeGreaterThan(0);
  });
});

describe("POST /events/[eventId]/media: storage orphan cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockUploadMedia.mockResolvedValue("/uploads/media/2026/04/test-uuid-1234.jpg");
    mockDeleteMedia.mockResolvedValue(undefined);
  });

  it("deletes uploaded file when DB create fails", async () => {
    const dbError = new Error("DB constraint violation");
    mockDb.mediaFile.create.mockRejectedValue(dbError);
    const req = await makePostRequest(makeFakeJpegFile());
    const res = await POST(req, makeParams());
    expect(res.status).toBe(500);
    expect(mockDeleteMedia).toHaveBeenCalledWith("/uploads/media/2026/04/test-uuid-1234.jpg");
  });

  it("logs error when orphaned file cleanup fails", async () => {
    mockDb.mediaFile.create.mockRejectedValue(new Error("DB error"));
    mockDeleteMedia.mockRejectedValue(new Error("Storage unreachable"));
    const req = await makePostRequest(makeFakeJpegFile());
    await POST(req, makeParams());
    expect(mockApiLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringContaining("orphaned") })
    );
  });
});

describe("POST /events/[eventId]/media: success", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockUploadMedia.mockResolvedValue("/uploads/media/2026/04/test-uuid-1234.jpg");
    mockDb.mediaFile.create.mockResolvedValue({
      id: "media-new",
      url: "/uploads/media/2026/04/test-uuid-1234.jpg",
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      size: 1024,
      createdAt: new Date(),
    });
  });

  it("returns 201 with media file record on successful JPEG upload", async () => {
    const req = await makePostRequest(makeFakeJpegFile());
    const res = await POST(req, makeParams());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe("media-new");
    expect(body.url).toContain("/uploads/media/");
  });

  it("returns 201 with media file record on successful PNG upload", async () => {
    mockDb.mediaFile.create.mockResolvedValue({
      id: "media-png",
      url: "/uploads/media/2026/04/test-uuid-1234.png",
      filename: "image.png",
      mimeType: "image/png",
      size: 1024,
      createdAt: new Date(),
    });
    const req = await makePostRequest(makeFakePngFile());
    const res = await POST(req, makeParams());
    expect(res.status).toBe(201);
  });

  it("logs success info with event context", async () => {
    const req = await makePostRequest(makeFakeJpegFile());
    await POST(req, makeParams());
    expect(mockApiLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "Event media file uploaded", eventId: "evt-1" })
    );
  });

  it("stores eventId on the created media file", async () => {
    const req = await makePostRequest(makeFakeJpegFile());
    await POST(req, makeParams());
    const createCall = mockDb.mediaFile.create.mock.calls[0][0];
    expect(createCall.data.eventId).toBe("evt-1");
  });
});

describe("POST /events/[eventId]/media: rate limiting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
  });

  it("returns 429 when rate limit exceeded", async () => {
    const { checkRateLimit } = await import("@/lib/security");
    vi.mocked(checkRateLimit).mockReturnValueOnce({ allowed: false, remaining: 0, retryAfterSeconds: 3600 });
    const req = await makePostRequest(makeFakeJpegFile());
    const res = await POST(req, makeParams());
    expect(res.status).toBe(429);
  });
});

// ── DELETE: delete event media ────────────────────────────────────────────────

describe("DELETE /events/[eventId]/media/[mediaId]: authentication", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = new Request("http://localhost/api/events/evt-1/media/media-1", { method: "DELETE" });
    const res = await DELETE(req, makeMediaParams());
    expect(res.status).toBe(401);
  });

  it("returns 403 for REVIEWER", async () => {
    mockAuth.mockResolvedValue(reviewerSession);
    const req = new Request("http://localhost/api/events/evt-1/media/media-1", { method: "DELETE" });
    const res = await DELETE(req, makeMediaParams());
    expect(res.status).toBe(403);
  });
});

describe("DELETE /events/[eventId]/media/[mediaId]: not found cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession);
  });

  it("returns 404 with log when event not found", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    mockDb.mediaFile.findFirst.mockResolvedValue({ id: "media-1", url: "/uploads/media/test.jpg", filename: "test.jpg" });
    const req = new Request("http://localhost/api/events/evt-1/media/media-1", { method: "DELETE" });
    const res = await DELETE(req, makeMediaParams());
    expect(res.status).toBe(404);
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringContaining("event not found") })
    );
  });

  it("returns 404 with log when media file not found", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.mediaFile.findFirst.mockResolvedValue(null);
    const req = new Request("http://localhost/api/events/evt-1/media/media-1", { method: "DELETE" });
    const res = await DELETE(req, makeMediaParams());
    expect(res.status).toBe(404);
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringContaining("file not found") })
    );
  });
});

describe("DELETE /events/[eventId]/media/[mediaId]: success", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.mediaFile.findFirst.mockResolvedValue({
      id: "media-1",
      url: "/uploads/media/2026/04/test.jpg",
      filename: "test.jpg",
    });
    mockDeleteMedia.mockResolvedValue(undefined);
    mockDb.mediaFile.delete.mockResolvedValue({});
  });

  it("returns success:true", async () => {
    const req = new Request("http://localhost/api/events/evt-1/media/media-1", { method: "DELETE" });
    const res = await DELETE(req, makeMediaParams());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });
  });

  it("deletes from storage and DB", async () => {
    const req = new Request("http://localhost/api/events/evt-1/media/media-1", { method: "DELETE" });
    await DELETE(req, makeMediaParams());
    expect(mockDeleteMedia).toHaveBeenCalledWith("/uploads/media/2026/04/test.jpg");
    expect(mockDb.mediaFile.delete).toHaveBeenCalledWith({ where: { id: "media-1" } });
  });

  it("still deletes DB record even if storage deletion fails", async () => {
    mockDeleteMedia.mockRejectedValue(new Error("Storage error"));
    const req = new Request("http://localhost/api/events/evt-1/media/media-1", { method: "DELETE" });
    const res = await DELETE(req, makeMediaParams());
    expect(res.status).toBe(200);
    expect(mockDb.mediaFile.delete).toHaveBeenCalled();
  });

  it("logs info on successful delete", async () => {
    const req = new Request("http://localhost/api/events/evt-1/media/media-1", { method: "DELETE" });
    await DELETE(req, makeMediaParams());
    expect(mockApiLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "Event media file deleted", mediaId: "media-1" })
    );
  });
});

describe("DELETE /events/[eventId]/media/[mediaId]: ownership check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
  });

  it("looks up media scoped to the correct eventId", async () => {
    mockDb.mediaFile.findFirst.mockResolvedValue({
      id: "media-1",
      url: "/uploads/media/test.jpg",
      filename: "test.jpg",
    });
    mockDeleteMedia.mockResolvedValue(undefined);
    mockDb.mediaFile.delete.mockResolvedValue({});
    const req = new Request("http://localhost/api/events/evt-1/media/media-1", { method: "DELETE" });
    await DELETE(req, makeMediaParams("evt-1", "media-1"));
    expect(mockDb.mediaFile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "media-1", eventId: "evt-1" }) })
    );
  });
});
