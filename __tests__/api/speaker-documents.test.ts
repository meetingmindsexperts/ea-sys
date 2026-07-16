/**
 * Speaker documents routes (July 16, 2026) — upload/list/delete of the
 * signed-agreement copy + arbitrary per-speaker files.
 *
 * Load-bearing properties:
 *   - PDF/DOC/DOCX only, magic-byte validated (a spoofed Content-Type can't
 *     smuggle another file type onto disk), 10MB cap.
 *   - SIGNED_AGREEMENT is one-per-speaker: a new upload REPLACES the
 *     previous row inside the transaction (old file unlinked after commit).
 *   - Uploading never touches Speaker.agreementAcceptedAt (owner decision).
 *   - RBAC: writes are staff-only (denyReviewer); GET additionally allows
 *     MEMBER; org-scoping via buildEventAccessWhere; DELETE binds the row
 *     through speaker + event.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockTx, mockFs } = vi.hoisted(() => {
  const mockTx = {
    speakerDocument: { findFirst: vi.fn(), delete: vi.fn(), create: vi.fn() },
  };
  return {
    mockAuth: vi.fn(),
    mockTx,
    mockDb: {
      $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(mockTx)),
      event: { findFirst: vi.fn() },
      speaker: { findFirst: vi.fn(), update: vi.fn() },
      speakerDocument: { findMany: vi.fn(), findFirst: vi.fn(), delete: vi.fn() },
      auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
    },
    mockFs: { mkdir: vi.fn(), writeFile: vi.fn(), unlink: vi.fn().mockResolvedValue(undefined) },
  };
});

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Map<string, string>(),
    }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/security", () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true }),
  getClientIp: vi.fn(() => "127.0.0.1"),
}));
vi.mock("fs/promises", () => ({ default: mockFs, ...mockFs }));

import { GET, POST } from "@/app/api/events/[eventId]/speakers/[speakerId]/documents/route";
import { DELETE } from "@/app/api/events/[eventId]/speakers/[speakerId]/documents/[documentId]/route";

const adminSession = { user: { id: "u1", role: "ADMIN", organizationId: "org-1" } };

function makeParams(documentId?: string) {
  return {
    params: Promise.resolve({ eventId: "evt-1", speakerId: "spk-1", ...(documentId && { documentId }) }),
  } as never;
}

const PDF_BYTES = Buffer.from("%PDF-1.7 fake pdf body");

function makeUploadRequest(opts: {
  fileType?: string;
  fileName?: string;
  bytes?: Buffer;
  size?: number;
  kind?: string;
  label?: string;
  noFile?: boolean;
}) {
  const bytes = opts.bytes ?? PDF_BYTES;
  const file = opts.noFile
    ? null
    : {
        name: opts.fileName ?? "signed.pdf",
        type: opts.fileType ?? "application/pdf",
        size: opts.size ?? bytes.length,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
  const fields: Record<string, unknown> = {
    file,
    kind: opts.kind ?? "OTHER",
    ...(opts.label !== undefined && { label: opts.label }),
  };
  return {
    formData: async () => ({ get: (k: string) => fields[k] ?? null }),
    headers: new Map(),
  } as never;
}

const CREATED_ROW = {
  id: "doc-1",
  kind: "OTHER",
  url: "/uploads/speaker-docs/evt-1/x.pdf",
  filename: "signed.pdf",
  label: null,
  mimeType: "application/pdf",
  size: PDF_BYTES.length,
  createdAt: new Date(),
  uploadedBy: { firstName: "A", lastName: "B" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(adminSession);
  mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
  mockDb.speaker.findFirst.mockResolvedValue({ id: "spk-1" });
  mockDb.speakerDocument.findMany.mockResolvedValue([]);
  mockDb.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(mockTx));
  mockTx.speakerDocument.findFirst.mockResolvedValue(null);
  mockTx.speakerDocument.create.mockResolvedValue(CREATED_ROW);
  mockDb.auditLog.create.mockReturnValue({ catch: () => {} });
  mockFs.mkdir.mockResolvedValue(undefined);
  mockFs.writeFile.mockResolvedValue(undefined);
  mockFs.unlink.mockResolvedValue(undefined);
});

describe("GET /documents — RBAC + scoping", () => {
  it("401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET({} as never, makeParams());
    expect(res.status).toBe(401);
  });

  it("MEMBER may read (documents are a staff+viewer surface)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", organizationId: "org-1" } });
    const res = await GET({} as never, makeParams());
    expect(res.status).toBe(200);
  });

  it("SUBMITTER is blocked from browsing speaker files", async () => {
    mockAuth.mockResolvedValue({ user: { id: "s1", role: "SUBMITTER", organizationId: null } });
    const res = await GET({} as never, makeParams());
    expect(res.status).toBe(403);
  });

  it("404 when the speaker is not in this event", async () => {
    mockDb.speaker.findFirst.mockResolvedValue(null);
    const res = await GET({} as never, makeParams());
    expect(res.status).toBe(404);
  });
});

describe("POST /documents — validation", () => {
  it("403 for MEMBER (read-only viewer cannot upload)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", organizationId: "org-1" } });
    const res = await POST(makeUploadRequest({}), makeParams());
    expect(res.status).toBe(403);
  });

  it("400 when no file provided", async () => {
    const res = await POST(makeUploadRequest({ noFile: true }), makeParams());
    expect(res.status).toBe(400);
  });

  it("400 for an unknown kind", async () => {
    const res = await POST(makeUploadRequest({ kind: "PASSPORT" }), makeParams());
    expect(res.status).toBe(400);
  });

  it("400 for a disallowed MIME type", async () => {
    const res = await POST(makeUploadRequest({ fileType: "image/png" }), makeParams());
    expect(res.status).toBe(400);
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it("400 when the file exceeds 10MB", async () => {
    const res = await POST(makeUploadRequest({ size: 11 * 1024 * 1024 }), makeParams());
    expect(res.status).toBe(400);
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it("400 when the bytes don't match the declared type (spoofed Content-Type)", async () => {
    const res = await POST(
      makeUploadRequest({ fileType: "application/pdf", bytes: Buffer.from("MZ not a pdf") }),
      makeParams(),
    );
    expect(res.status).toBe(400);
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });
});

describe("POST /documents — behavior", () => {
  it("uploads an OTHER document: writes the file, creates the row, audits", async () => {
    const res = await POST(makeUploadRequest({ label: "Bio" }), makeParams());
    expect(res.status).toBe(201);
    expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
    const created = mockTx.speakerDocument.create.mock.calls[0][0].data;
    expect(created.kind).toBe("OTHER");
    expect(created.label).toBe("Bio");
    expect(created.speakerId).toBe("spk-1");
    expect(created.url).toMatch(/^\/uploads\/speaker-docs\/evt-1\/.+\.pdf$/);
    expect(mockDb.auditLog.create).toHaveBeenCalled();
  });

  it("SIGNED_AGREEMENT replaces the previous copy (row deleted in-tx, old file unlinked)", async () => {
    mockTx.speakerDocument.findFirst.mockResolvedValue({
      id: "old-doc",
      url: "/uploads/speaker-docs/evt-1/old.pdf",
    });
    const res = await POST(makeUploadRequest({ kind: "SIGNED_AGREEMENT" }), makeParams());
    expect(res.status).toBe(201);
    expect(mockTx.speakerDocument.delete).toHaveBeenCalledWith({ where: { id: "old-doc" } });
    expect(mockFs.unlink).toHaveBeenCalledTimes(1);
  });

  it("never touches Speaker.agreementAcceptedAt (owner decision: upload ≠ acceptance)", async () => {
    await POST(makeUploadRequest({ kind: "SIGNED_AGREEMENT" }), makeParams());
    expect(mockDb.speaker.update).not.toHaveBeenCalled();
  });
});

describe("DELETE /documents/[documentId]", () => {
  it("binds the row through speaker + event — a foreign documentId 404s", async () => {
    mockDb.speakerDocument.findFirst.mockResolvedValue(null);
    const res = await DELETE({} as never, makeParams("someone-elses-doc"));
    expect(res.status).toBe(404);
    const where = mockDb.speakerDocument.findFirst.mock.calls[0][0].where;
    expect(where).toEqual({
      id: "someone-elses-doc",
      speakerId: "spk-1",
      speaker: { eventId: "evt-1" },
    });
  });

  it("deletes the row, unlinks the file, audits", async () => {
    mockDb.speakerDocument.findFirst.mockResolvedValue({
      id: "doc-1",
      kind: "OTHER",
      url: "/uploads/speaker-docs/evt-1/x.pdf",
      filename: "bio.pdf",
    });
    mockDb.speakerDocument.delete.mockResolvedValue({});
    const res = await DELETE({} as never, makeParams("doc-1"));
    expect(res.status).toBe(200);
    expect(mockDb.speakerDocument.delete).toHaveBeenCalledWith({ where: { id: "doc-1" } });
    expect(mockFs.unlink).toHaveBeenCalledTimes(1);
    expect(mockDb.auditLog.create).toHaveBeenCalled();
  });

  it("403 for restricted roles", async () => {
    mockAuth.mockResolvedValue({ user: { id: "r1", role: "REVIEWER", organizationId: null } });
    const res = await DELETE({} as never, makeParams("doc-1"));
    expect(res.status).toBe(403);
  });
});
