/**
 * POST /api/events/[eventId]/email-attachments: the multipart upload that
 * mints a storage reference for a speaker email attachment (Sep 8, 2026).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockUploadFile, mockCheckRateLimit } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { event: { findFirst: vi.fn() } },
  mockUploadFile: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/auth-guards", () => ({ denyReviewer: () => null, WEBINAR_STAFF_ALLOW: [] }));
vi.mock("@/lib/event-access", () => ({ buildEventAccessWhere: (_u: unknown, id: string) => ({ id }) }));
vi.mock("@/lib/security", () => ({ checkRateLimit: (a: unknown) => mockCheckRateLimit(a) }));
vi.mock("@/lib/storage", () => ({ uploadFile: (...a: unknown[]) => mockUploadFile(...a) }));

import { POST } from "@/app/api/events/[eventId]/email-attachments/route";

const params = { params: Promise.resolve({ eventId: "ev1" }) };
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
function req(file?: File) {
  const fd = new FormData();
  if (file) fd.append("file", file);
  return new Request("http://localhost/api/x", { method: "POST", body: fd });
}
const pdf = (name = "agenda.pdf", pad = 100, type = "application/pdf") =>
  new File([Buffer.concat([Buffer.from(PDF_MAGIC), Buffer.alloc(pad, 0x20)])], name, { type });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  mockCheckRateLimit.mockReturnValue({ allowed: true, remaining: 59, retryAfterSeconds: 3600 });
  mockUploadFile.mockResolvedValue("/uploads/email-attachments/ev1/abc.pdf");
});

describe("POST email-attachments", () => {
  it("stores a valid PDF under the event's private prefix and returns a reference", async () => {
    const res = await POST(req(pdf("../../etc/agenda.pdf")), params);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({
      storedPath: "/uploads/email-attachments/ev1/abc.pdf",
      name: "agenda.pdf",
      contentType: "application/pdf",
      size: 105,
    });
    // Subdirectory keyed by event: the resolver later refuses any other prefix.
    expect(mockUploadFile).toHaveBeenCalledWith(expect.any(Buffer), expect.stringMatching(/\.pdf$/), "application/pdf", "email-attachments/ev1");
  });

  it("resolves the type from the extension when the browser reports none (.docx on some OSes)", async () => {
    const zip = new File([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])], "form.docx", { type: "" });
    mockUploadFile.mockResolvedValueOnce("/uploads/email-attachments/ev1/x.docx");
    const res = await POST(req(zip), params);
    expect(res.status).toBe(201);
    expect((await res.json()).contentType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("refuses the wrong type, a spoofed type, and an over-size file before touching storage", async () => {
    expect((await POST(req(new File([Buffer.from([0x89, 0x50, 0x4e, 0x47])], "p.png", { type: "image/png" })), params)).status).toBe(400);
    const spoofed = new File([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])], "evil.pdf", { type: "application/pdf" });
    expect((await POST(req(spoofed), params)).status).toBe(400);
    expect((await POST(req(pdf("big.pdf", 5 * 1024 * 1024)), params)).status).toBe(400);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it("401 without a session, 404 without event access, 400 without a file, 429 when limited", async () => {
    mockAuth.mockResolvedValueOnce(null);
    expect((await POST(req(pdf()), params)).status).toBe(401);
    mockDb.event.findFirst.mockResolvedValueOnce(null);
    expect((await POST(req(pdf()), params)).status).toBe(404);
    expect((await POST(req(), params)).status).toBe(400);
    mockCheckRateLimit.mockReturnValueOnce({ allowed: false, remaining: 0, retryAfterSeconds: 60 });
    const limited = await POST(req(pdf()), params);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(mockUploadFile).not.toHaveBeenCalled();
  });
});
