/**
 * The ID and document request page's API (Nov 4, 2026). Unauthenticated: the
 * link is the credential, so what it may read and write is the whole point.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, tx } = vi.hoisted(() => {
  const tx = {
    verificationToken: { deleteMany: vi.fn() },
    attendee: { update: vi.fn() },
    registration: { update: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return {
    tx,
    mockDb: {
      verificationToken: { findUnique: vi.fn(), delete: vi.fn().mockResolvedValue({}) },
      registration: { findFirst: vi.fn() },
    },
  };
});

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (cb: (t: unknown) => unknown) => cb(tx),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api-errors", () => ({ rateLimited: () => ({ status: 429, json: async () => ({}) }) }));
vi.mock("@/lib/public-event", () => ({ eventMatchesRequestTenant: async () => true }));
vi.mock("@/lib/security", () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "1.2.3.4",
  hashVerificationToken: (t: string) => `hash:${t}`,
}));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, cb: () => unknown) => cb() }));
vi.mock("@/lib/tenant/resolver", () => ({ resolveTenantOrg: async () => ({ orgId: "org1" }), normalizeHost: (h: string) => h }));

import { GET, POST } from "@/app/api/public/events/[slug]/verify-details/route";
import { apiLogger } from "@/lib/logger";

const params = { params: Promise.resolve({ slug: "MEHF2027" }) };
const UPLOAD = "/uploads/resident-letters/ev1/0b6f3c1e-1111-4222-8333-944455556666.pdf";

function registration(over: Record<string, unknown> = {}) {
  return {
    id: "reg1",
    supportingDocumentUrl: null,
    ticketType: {
      name: "Student",
      requiresMemberId: false,
      requiresStudentId: true,
      requiresStudentIdExpiry: true,
      requiresDocument: true,
      documentRequired: true,
      documentLabel: "Valid Student ID",
      documentInstructions: null,
    },
    attendee: { id: "att1", firstName: "Jane", lastName: "Doe", email: "jane@x.org", memberId: null, studentId: null, studentIdExpiry: null },
    event: {
      id: "ev1", name: "MEHF", slug: "MEHF2027", organizationId: "org1", startDate: new Date("2027-01-15"),
      bannerImage: null, bannerImageMobile: null, organization: { name: "MMG" },
    },
    ...over,
  };
}

const get = (token = "tok") => GET(new Request(`http://x/api/public/events/MEHF2027/verify-details?token=${token}`), params);
const post = (body: Record<string, unknown>) =>
  POST(new Request("http://x/api/public/events/MEHF2027/verify-details", { method: "POST", body: JSON.stringify({ token: "tok", ...body }) }), params);

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.verificationToken.findUnique.mockResolvedValue({ identifier: "evidence:reg1", expires: new Date(Date.now() + 86_400_000) });
  mockDb.registration.findFirst.mockResolvedValue(registration());
  tx.verificationToken.deleteMany.mockResolvedValue({ count: 1 });
});

describe("GET", () => {
  it("returns only what is missing, and never a value on file", async () => {
    mockDb.registration.findFirst.mockResolvedValue(
      registration({ attendee: { ...registration().attendee, studentId: "SECRET-ID", studentIdExpiry: new Date("2027-06-30") } }),
    );
    const res = await get();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.missing).toEqual(["supportingDocument"]);
    expect(JSON.stringify(body)).not.toContain("SECRET-ID");
    expect(body.document).toEqual({ label: "Valid Student ID", instructions: null, required: true });
  });

  it("refuses another kind of token (a survey link cannot open this page)", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValue({ identifier: "survey:reg1", expires: new Date(Date.now() + 1000) });
    expect((await get()).status).toBe(400);
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
  });

  it("refuses, and deletes, an expired link", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValue({ identifier: "evidence:reg1", expires: new Date(Date.now() - 1000) });
    const res = await get();
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("LINK_EXPIRED");
    expect(mockDb.verificationToken.delete).toHaveBeenCalled();
  });

  it("refuses a link opened under another event's address", async () => {
    mockDb.registration.findFirst.mockResolvedValue(registration({ event: { ...registration().event, slug: "OTHER" } }));
    expect((await get()).status).toBe(400);
  });

  it("refuses an unknown link, and logs it", async () => {
    mockDb.verificationToken.findUnique.mockResolvedValue(null);
    expect((await get()).status).toBe(400);
    expect(apiLogger.info).toHaveBeenCalledWith(expect.objectContaining({ msg: "public/verify-details:GET:token-not-found" }));
  });
});

describe("POST", () => {
  it("refuses with every missing field named, and writes nothing", async () => {
    const res = await post({});
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.fields).toEqual(["studentId", "studentIdExpiry", "supportingDocument"]);
    expect(tx.attendee.update).not.toHaveBeenCalled();
    expect(tx.verificationToken.deleteMany).not.toHaveBeenCalled();
  });

  it("saves the ID, expiry and document, uses up the link and audits", async () => {
    const res = await post({ studentId: " S1 ", studentIdExpiry: "2027-06-30", supportingDocumentUrl: UPLOAD, supportingDocumentFilename: "card.pdf" });
    expect(res.status).toBe(200);
    expect((await res.json()).saved).toEqual(["studentId", "studentIdExpiry", "supportingDocument"]);
    expect(tx.verificationToken.deleteMany).toHaveBeenCalledWith({ where: { token: "hash:tok" } });
    expect(tx.attendee.update).toHaveBeenCalledWith({
      where: { id: "att1" },
      data: { studentId: "S1", studentIdExpiry: new Date("2027-06-30") },
    });
    expect(tx.registration.update).toHaveBeenCalledWith({
      where: { id: "reg1" },
      data: { supportingDocumentUrl: UPLOAD, supportingDocumentFilename: "card.pdf" },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "EVIDENCE_PROVIDED" }) }));
  });

  it("never overwrites what is on file, even when the request sends it", async () => {
    mockDb.registration.findFirst.mockResolvedValue(
      registration({ attendee: { ...registration().attendee, studentId: "ON-FILE", studentIdExpiry: new Date("2027-06-30") } }),
    );
    const res = await post({ studentId: "OVERWRITE", studentIdExpiry: "2030-01-01", supportingDocumentUrl: UPLOAD });
    expect(res.status).toBe(200);
    expect(tx.attendee.update).toHaveBeenCalledWith({ where: { id: "att1" }, data: {} });
  });

  it("refuses a document that is not this event's upload", async () => {
    const res = await post({ studentId: "S1", studentIdExpiry: "2027-06-30", supportingDocumentUrl: UPLOAD.replace("/ev1/", "/ev2/") });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("DOCUMENT_REQUIRED");
    expect(apiLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ dropped: "not-our-upload" }));
  });

  it("works once: a second tab finding the link already used saves nothing", async () => {
    tx.verificationToken.deleteMany.mockResolvedValue({ count: 0 });
    const res = await post({ studentId: "S1", studentIdExpiry: "2027-06-30", supportingDocumentUrl: UPLOAD });
    expect(res.status).toBe(400);
    expect(tx.attendee.update).not.toHaveBeenCalled();
  });
});
