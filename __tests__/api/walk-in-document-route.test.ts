/**
 * POST /api/events/[eventId]/registrations/walk-in/document: the desk's
 * supporting-document upload (review of 26c17807, MED 4). Staff-only, per
 * person, and the same checks and storage as the public form's upload.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockUpload, mockRateLimit } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { event: { findFirst: vi.fn() } },
  mockUpload: vi.fn(),
  mockRateLimit: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/security", () => ({ checkRateLimit: (...a: unknown[]) => mockRateLimit(...a) }));
vi.mock("@/lib/storage", () => ({ uploadFile: (...a: unknown[]) => mockUpload(...a) }));

import { POST } from "@/app/api/events/[eventId]/registrations/walk-in/document/route";

const params = { params: Promise.resolve({ eventId: "evt-1" }) };
const session = { user: { id: "user-1", role: "ADMIN", organizationId: "org-1" } };

function upload(bytes: number[], type: string, name = "letter.pdf") {
  const body = new FormData();
  body.append("file", new File([new Uint8Array(bytes)], name, { type }));
  return POST(new Request("http://x/api/events/evt-1/registrations/walk-in/document", { method: "POST", body }), params);
}

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31];

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(session);
  mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
  mockRateLimit.mockReturnValue({ allowed: true });
  mockUpload.mockResolvedValue("/uploads/resident-letters/evt-1/abc.pdf");
});

describe("POST walk-in/document", () => {
  it("stores a real PDF under the event's folder and returns its path", async () => {
    const res = await upload(PDF, "application/pdf");
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ url: "/uploads/resident-letters/evt-1/abc.pdf", filename: "letter.pdf" });
    expect(mockUpload.mock.calls[0][3]).toMatch(/\/evt-1$/);
  });

  it("refuses a file whose bytes do not match its declared type", async () => {
    const res = await upload([0x00, 0x01, 0x02, 0x03, 0x04], "application/pdf");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_MAGIC_BYTES" });
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("refuses a type that is not PDF, JPG or PNG", async () => {
    const res = await upload(PDF, "text/html", "x.html");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_MIME" });
  });

  it("needs a sign-in, and an event inside the caller's grant", async () => {
    mockAuth.mockResolvedValueOnce(null);
    expect((await upload(PDF, "application/pdf")).status).toBe(401);
    mockDb.event.findFirst.mockResolvedValueOnce(null);
    expect((await upload(PDF, "application/pdf")).status).toBe(404);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("is limited per person, not per IP", async () => {
    await upload(PDF, "application/pdf");
    expect(mockRateLimit).toHaveBeenCalledWith(expect.objectContaining({ key: "walk-in-document:user-1" }));
  });
});
