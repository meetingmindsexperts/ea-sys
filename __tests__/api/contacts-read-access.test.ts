/**
 * Contacts review H1 + H2 (July 14, 2026).
 *
 * H1 — the four contacts READ routes authorized on `getOrgContext` alone
 *      (`denyReviewer` guards only the writes), so ONSITE desk temps and
 *      internal-domain REGISTRANTs — both org-bound — could pull, and EXPORT,
 *      the entire organization's CRM including private notes. Owner decision:
 *      staff + MEMBER may read; ONSITE / REGISTRANT / REVIEWER / SUBMITTER may not.
 *      The export is additionally audited + rate-limited.
 *
 * H2 — the REST contact-create path was the only writer that didn't lowercase
 *      the email, while `@@unique([organizationId, email])` is case-sensitive →
 *      duplicate contacts for one person. Also asserts the create race (P2002)
 *      is a 409, not a 500 echoing the raw Prisma message.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { canViewContacts, canExportContacts } from "@/lib/contact-visibility";

const { mockGetOrgContext, mockDb, mockRateLimit } = vi.hoisted(() => ({
  mockGetOrgContext: vi.fn(),
  mockDb: {
    contact: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    speaker: { findMany: vi.fn() },
    registration: { findMany: vi.fn() },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
  },
  mockRateLimit: vi.fn((): { allowed: boolean; retryAfterSeconds: number } => ({
    allowed: true,
    retryAfterSeconds: 0,
  })),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Map<string, string>(Object.entries(init?.headers ?? {})),
    }),
  },
}));

vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/api-auth", () => ({ getOrgContext: () => mockGetOrgContext() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/security", () => ({
  getClientIp: vi.fn(() => "127.0.0.1"),
  checkRateLimit: () => mockRateLimit(),
}));

// The guard under test is REAL (not mocked) — that's the point of the suite.

import { GET as listContacts, POST as createContact } from "@/app/api/contacts/route";
import { GET as exportContacts } from "@/app/api/contacts/export/route";
import { GET as listTags } from "@/app/api/contacts/tags/route";
import { GET as getContact, PUT as updateContact } from "@/app/api/contacts/[contactId]/route";

const ORG = "org_1";

function ctxFor(role: string | null, fromApiKey = false) {
  return {
    organizationId: ORG,
    userId: fromApiKey ? null : "user_1",
    role,
    fromApiKey,
    fromMobile: false,
  };
}

const req = (url = "http://x/api/contacts") => new Request(url);

/** The four read routes, driven through one shape so every role is tested against all of them. */
const READ_ROUTES: { name: string; call: () => Promise<{ status: number }> }[] = [
  { name: "list", call: () => listContacts(req()) as Promise<{ status: number }> },
  { name: "export", call: () => exportContacts(req()) as unknown as Promise<{ status: number }> },
  { name: "tags", call: () => listTags(req()) as Promise<{ status: number }> },
  {
    name: "detail",
    call: () =>
      getContact(req(), { params: Promise.resolve({ contactId: "c1" }) }) as Promise<{ status: number }>,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  mockDb.contact.findMany.mockResolvedValue([]);
  mockDb.contact.count.mockResolvedValue(0);
  mockDb.contact.findFirst.mockResolvedValue({ id: "c1", email: "a@b.com", tags: [] });
  mockDb.speaker.findMany.mockResolvedValue([]);
  mockDb.registration.findMany.mockResolvedValue([]);
  mockDb.auditLog.create.mockReturnValue({ catch: () => {} });
});

describe("canViewContacts — the boundary (staff + MEMBER + CRM_USER; fails closed)", () => {
  it.each(["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER", "CRM_USER"])("allows %s", (role) => {
    expect(canViewContacts(role)).toBe(true);
  });

  it.each(["ONSITE", "REGISTRANT", "REVIEWER", "SUBMITTER"])("blocks %s", (role) => {
    expect(canViewContacts(role)).toBe(false);
  });

  it("allows API-key callers (admin-equivalent)", () => {
    expect(canViewContacts(null, true)).toBe(true);
  });

  it("fails closed on an unknown or absent role", () => {
    expect(canViewContacts(null)).toBe(false);
    expect(canViewContacts(undefined)).toBe(false);
    expect(canViewContacts("SOME_FUTURE_ROLE")).toBe(false);
  });
});

describe("canExportContacts — narrower than read (M-A, July 16, 2026)", () => {
  it.each(["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER"])("allows %s", (role) => {
    expect(canExportContacts(role)).toBe(true);
  });

  it("blocks CRM_USER — may read/search the store but not pull the whole book", () => {
    expect(canExportContacts("CRM_USER")).toBe(false);
  });

  it.each(["ONSITE", "REGISTRANT", "REVIEWER", "SUBMITTER"])("blocks %s", (role) => {
    expect(canExportContacts(role)).toBe(false);
  });

  it("allows API-key callers (admin-equivalent)", () => {
    expect(canExportContacts(null, true)).toBe(true);
  });

  it("fails closed on an unknown or absent role", () => {
    expect(canExportContacts(null)).toBe(false);
    expect(canExportContacts(undefined)).toBe(false);
    expect(canExportContacts("SOME_FUTURE_ROLE")).toBe(false);
  });
});

describe("H1 — contacts read routes are gated", () => {
  for (const role of ["ONSITE", "REGISTRANT", "REVIEWER", "SUBMITTER"]) {
    for (const route of READ_ROUTES) {
      it(`403s ${role} on the ${route.name} route`, async () => {
        mockGetOrgContext.mockResolvedValue(ctxFor(role));
        const res = await route.call();
        expect(res.status).toBe(403);
      });
    }
  }

  for (const role of ["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER"]) {
    for (const route of READ_ROUTES) {
      it(`allows ${role} on the ${route.name} route`, async () => {
        mockGetOrgContext.mockResolvedValue(ctxFor(role));
        const res = await route.call();
        expect(res.status).toBe(200);
      });
    }
  }

  it("allows an API-key caller on the export route", async () => {
    mockGetOrgContext.mockResolvedValue(ctxFor(null, true));
    const res = await exportContacts(req());
    expect(res.status).toBe(200);
  });

  it("CRM_USER may read the list but is 403'd on the export route (M-A)", async () => {
    mockGetOrgContext.mockResolvedValue(ctxFor("CRM_USER"));
    const listRes = await listContacts(req());
    expect(listRes.status).toBe(200);

    const exportRes = await exportContacts(req());
    expect(exportRes.status).toBe(403);
    // Blocked before the rate-limit budget and the DB query.
    expect(mockDb.contact.findMany).toHaveBeenCalledTimes(1); // the list call only
  });

  it("401s an unauthenticated caller before the role gate", async () => {
    mockGetOrgContext.mockResolvedValue(null);
    const res = await listContacts(req());
    expect(res.status).toBe(401);
  });

  it("ONSITE never reaches the database on a blocked read", async () => {
    mockGetOrgContext.mockResolvedValue(ctxFor("ONSITE"));
    await exportContacts(req());
    expect(mockDb.contact.findMany).not.toHaveBeenCalled();
  });
});

describe("H1 — the export is audited and rate-limited", () => {
  it("writes an EXPORT audit row carrying the row count and role", async () => {
    mockGetOrgContext.mockResolvedValue(ctxFor("ADMIN"));
    mockDb.contact.findMany.mockResolvedValue([
      { title: null, firstName: "A", lastName: "B", email: "a@b.com", organization: null, jobTitle: null, specialty: null, registrationType: null, bio: null, phone: null, tags: [], notes: null },
    ]);

    await exportContacts(req());

    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
    const arg = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(arg.action).toBe("EXPORT");
    expect(arg.entityType).toBe("Contact");
    expect(arg.changes).toMatchObject({ rowCount: 1, role: "ADMIN" });
  });

  it("429s when the export rate limit is exhausted, without touching the DB", async () => {
    mockGetOrgContext.mockResolvedValue(ctxFor("ADMIN"));
    mockRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 900 });

    const res = await exportContacts(req());

    expect(res.status).toBe(429);
    expect(mockDb.contact.findMany).not.toHaveBeenCalled();
  });
});

describe("H2 — contact create normalizes the email", () => {
  const body = (email: string) => ({
    email,
    firstName: "Jane",
    lastName: "Doe",
  });

  function postWith(email: string) {
    const r = new Request("http://x/api/contacts", {
      method: "POST",
      body: JSON.stringify(body(email)),
      headers: { "content-type": "application/json" },
    });
    return createContact(r);
  }

  beforeEach(() => {
    mockGetOrgContext.mockResolvedValue(ctxFor("ADMIN"));
    mockDb.contact.findUnique.mockResolvedValue(null);
    mockDb.contact.create.mockResolvedValue({ id: "c_new" });
  });

  it("lowercases + trims before the duplicate check (so the check can actually find the row)", async () => {
    await postWith("  John@Hospital.COM ");

    expect(mockDb.contact.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId_email: { organizationId: ORG, email: "john@hospital.com" } },
      }),
    );
  });

  it("persists the lowercased email", async () => {
    await postWith("John@Hospital.com");

    expect(mockDb.contact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: "john@hospital.com" }),
      }),
    );
  });

  it("409s a case-variant of an existing contact (the duplicate it used to mint)", async () => {
    mockDb.contact.findUnique.mockResolvedValue({ id: "existing" });

    const res = await postWith("JOHN@hospital.com");

    expect(res.status).toBe(409);
    expect(mockDb.contact.create).not.toHaveBeenCalled();
  });

  it("maps the concurrent-create race (P2002) to 409, not a 500 leaking Prisma internals", async () => {
    const { Prisma } = await import("@prisma/client");
    const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "x",
    });
    mockDb.contact.create.mockRejectedValue(p2002);

    const res = await postWith("john@hospital.com");
    const json = await (res as unknown as { json: () => Promise<{ error: string; detail?: string }> }).json();

    expect(res.status).toBe(409);
    expect(json.detail).toBeUndefined();
  });
});

describe("contact PUT — honest saves (review R2-M3 + R2-M4, July 16 2026)", () => {
  // additionalEmail was missing from the update schema entirely — Zod stripped
  // the key, so the detail sheet's field was a dead write (success toast, value
  // reverts). And clears (null) must actually persist.
  function putWith(body: Record<string, unknown>) {
    const r = new Request("http://x/api/contacts/c1", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
    return updateContact(r, { params: Promise.resolve({ contactId: "c1" }) });
  }

  beforeEach(() => {
    mockGetOrgContext.mockResolvedValue(ctxFor("ADMIN"));
    mockDb.contact.findFirst.mockResolvedValue({ id: "c1" });
    mockDb.contact.update.mockResolvedValue({ id: "c1" });
  });

  it("persists additionalEmail (was silently stripped by the schema)", async () => {
    const res = await putWith({ additionalEmail: "assistant@x.com" });
    expect(res.status).toBe(200);
    expect(mockDb.contact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ additionalEmail: "assistant@x.com" }),
      }),
    );
  });

  it("clears additionalEmail on empty string (→ null) and on explicit null", async () => {
    await putWith({ additionalEmail: "" });
    expect(mockDb.contact.update.mock.calls[0][0].data.additionalEmail).toBeNull();

    await putWith({ additionalEmail: null });
    expect(mockDb.contact.update.mock.calls[1][0].data.additionalEmail).toBeNull();
  });

  it("rejects an invalid additionalEmail with a 400", async () => {
    const res = await putWith({ additionalEmail: "not-an-email" });
    expect(res.status).toBe(400);
    expect(mockDb.contact.update).not.toHaveBeenCalled();
  });

  it("a null clear on phone/bio/notes persists null (the sheet now sends null, not undefined)", async () => {
    const res = await putWith({ phone: null, bio: null, notes: null });
    expect(res.status).toBe(200);
    expect(mockDb.contact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ phone: null, bio: null, notes: null }),
      }),
    );
  });
});
