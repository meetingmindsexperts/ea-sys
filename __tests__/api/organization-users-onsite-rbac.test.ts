/**
 * RBAC tests for the ORGANIZER access to temp/onsite staff account lifecycle
 * (July 20, 2026): organizers may CREATE and DELETE user accounts via
 * /api/organization/users — but ONLY for the ONSITE role. Any other requested
 * role (create) or target role (delete) must 403 with code ONSITE_ONLY, so an
 * organizer can never invite an admin or remove a peer/admin account.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockTx } = vi.hoisted(() => {
  const mockTx = {
    user: { create: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  return {
    mockAuth: vi.fn(),
    mockDb: {
      user: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      speaker: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      organization: { findUnique: vi.fn() },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockTx)),
    },
    mockTx,
  };
});

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
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn().mockResolvedValue({ success: true }),
  emailTemplates: {
    userInvitation: vi.fn().mockReturnValue({ subject: "s", htmlContent: "h", textContent: "t" }),
  },
}));
vi.mock("@/lib/security", () => ({
  getClientIp: vi.fn().mockReturnValue("1.2.3.4"),
  hashVerificationToken: vi.fn().mockReturnValue("hashed"),
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true, remaining: 9, retryAfterSeconds: 3600 }),
}));
vi.mock("bcryptjs", () => ({ default: { hash: vi.fn().mockResolvedValue("bcrypt-hash") } }));

import { POST } from "@/app/api/organization/users/route";
import { DELETE } from "@/app/api/organization/users/[userId]/route";

const organizerSession = {
  user: { id: "org-user-1", role: "ORGANIZER", organizationId: "org-1", email: "o@x.com" },
};
const adminSession = {
  user: { id: "admin-1", role: "ADMIN", organizationId: "org-1", email: "a@x.com" },
};

function postReq(body: Record<string, unknown>) {
  return new Request("http://localhost/api/organization/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const onsiteBody = {
  email: "desk@example.com",
  firstName: "Desk",
  lastName: "Temp",
  role: "ONSITE",
  password: "temppass123",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.user.findUnique.mockResolvedValue(null); // no existing account
  mockTx.user.create.mockResolvedValue({
    id: "new-1", email: onsiteBody.email, firstName: "Desk", lastName: "Temp",
    role: "ONSITE", createdAt: new Date(),
  });
  mockTx.auditLog.create.mockResolvedValue({});
});

describe("POST /api/organization/users — ORGANIZER creates ONSITE only", () => {
  it("ORGANIZER can create an ONSITE account with a password", async () => {
    mockAuth.mockResolvedValue(organizerSession);
    const res = await POST(postReq(onsiteBody));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.passwordSet).toBe(true);
    expect(mockTx.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: "ONSITE", organizationId: "org-1" }) }),
    );
  });

  it("ORGANIZER requesting any non-ONSITE role → 403 ONSITE_ONLY, nothing created", async () => {
    mockAuth.mockResolvedValue(organizerSession);
    for (const role of ["ADMIN", "ORGANIZER", "MEMBER", "REVIEWER", "CRM_USER"]) {
      const res = await POST(postReq({ ...onsiteBody, role }));
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("ONSITE_ONLY");
    }
    expect(mockTx.user.create).not.toHaveBeenCalled();
    expect(mockDb.user.update).not.toHaveBeenCalled(); // promote branch never reached
  });

  it("MEMBER still cannot create anything", async () => {
    mockAuth.mockResolvedValue({ user: { id: "m", role: "MEMBER", organizationId: "org-1" } });
    const res = await POST(postReq(onsiteBody));
    expect(res.status).toBe(403);
    expect(mockTx.user.create).not.toHaveBeenCalled();
  });

  it("ADMIN can still create non-ONSITE roles", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockTx.user.create.mockResolvedValue({
      id: "new-2", email: onsiteBody.email, firstName: "Desk", lastName: "Temp",
      role: "MEMBER", createdAt: new Date(),
    });
    const res = await POST(postReq({ ...onsiteBody, role: "MEMBER" }));
    expect(res.status).toBe(201);
  });
});

describe("DELETE /api/organization/users/[userId] — ORGANIZER deletes ONSITE only", () => {
  const params = { params: Promise.resolve({ userId: "target-1" }) };
  const delReq = () => new Request("http://localhost/api/organization/users/target-1", { method: "DELETE" });

  it("ORGANIZER can delete an ONSITE account", async () => {
    mockAuth.mockResolvedValue(organizerSession);
    mockDb.user.findFirst.mockResolvedValue({ id: "target-1", role: "ONSITE", email: "desk@example.com" });
    mockDb.user.delete.mockResolvedValue({});
    const res = await DELETE(delReq(), params);
    expect(res.status).toBe(200);
    expect(mockDb.user.delete).toHaveBeenCalledWith({ where: { id: "target-1" } });
  });

  it("ORGANIZER deleting a non-ONSITE account → 403 ONSITE_ONLY, no delete", async () => {
    mockAuth.mockResolvedValue(organizerSession);
    for (const role of ["ADMIN", "ORGANIZER", "MEMBER", "SUPER_ADMIN"]) {
      mockDb.user.findFirst.mockResolvedValue({ id: "target-1", role, email: "x@x.com" });
      const res = await DELETE(delReq(), params);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("ONSITE_ONLY");
    }
    expect(mockDb.user.delete).not.toHaveBeenCalled();
  });

  it("ADMIN can still delete non-ONSITE accounts", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.user.findFirst.mockResolvedValue({ id: "target-1", role: "MEMBER", email: "m@x.com" });
    mockDb.user.delete.mockResolvedValue({});
    const res = await DELETE(delReq(), params);
    expect(res.status).toBe(200);
  });

  it("MEMBER still cannot delete", async () => {
    mockAuth.mockResolvedValue({ user: { id: "m", role: "MEMBER", organizationId: "org-1" } });
    const res = await DELETE(delReq(), params);
    expect(res.status).toBe(403);
    expect(mockDb.user.delete).not.toHaveBeenCalled();
  });
});
