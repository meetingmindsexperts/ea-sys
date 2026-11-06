/**
 * PUT /api/organizations/[orgId]/crm-email: only the platform operator sets an
 * organisation's CRM email identity; a capture address can belong to one
 * organisation only; every change is audited in its own transaction.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, findFirst, findUnique, executeRaw, auditCreate } = vi.hoisted(() => ({
  auth: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  executeRaw: vi.fn(),
  auditCreate: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/db", () => ({
  db: { organization: { findFirst, findUnique } },
  tenantTransaction: (fn: (tx: unknown) => unknown) =>
    fn({ organization: { findUnique }, $executeRaw: executeRaw, auditLog: { create: auditCreate } }),
}));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { PUT } from "@/app/api/organizations/[orgId]/crm-email/route";

const call = (body: unknown) =>
  PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body) }), { params: Promise.resolve({ orgId: "org-b" }) });
const block = { fromAddress: "sales@b.com", captureAddress: "capture-b@reply.b.com" };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PLATFORM_ORG_ID;
  auth.mockResolvedValue({ user: { id: "op", role: "SUPER_ADMIN", organizationId: "org-a" } });
  findFirst.mockResolvedValue(null);
  findUnique.mockResolvedValue({ settings: {} });
});

describe("the CRM email identity route", () => {
  it("refuses an organisation's own admin, and a tenant SUPER_ADMIN on the platform", async () => {
    auth.mockResolvedValue({ user: { id: "a", role: "ADMIN", organizationId: "org-b" } });
    expect((await call({ crmEmail: block })).status).toBe(403);
    process.env.PLATFORM_ORG_ID = "org-platform";
    auth.mockResolvedValue({ user: { id: "s", role: "SUPER_ADMIN", organizationId: "org-b" } });
    expect((await call({ crmEmail: block })).status).toBe(403);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("refuses a capture address another organisation already holds", async () => {
    findFirst.mockResolvedValue({ id: "org-a" });
    const res = await call({ crmEmail: block });
    expect(res.status).toBe(409);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("saves the block and audits it; null clears it", async () => {
    expect((await call({ crmEmail: block })).status).toBe(200);
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "CRM_EMAIL_IDENTITY_SET" }) }));
    expect((await call({ crmEmail: null })).status).toBe(200);
    expect(auditCreate).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "CRM_EMAIL_IDENTITY_CLEARED" }) }));
  });

  it("refuses the deployment's own capture address for any other organisation", async () => {
    process.env.CRM_CAPTURE_ORG_ID = "org-master";
    process.env.CRM_CAPTURE_ADDRESS = "capture-b@reply.b.com";
    try {
      expect((await call({ crmEmail: block })).status).toBe(409);
      expect(executeRaw).not.toHaveBeenCalled();
    } finally {
      delete process.env.CRM_CAPTURE_ORG_ID;
      delete process.env.CRM_CAPTURE_ADDRESS;
    }
  });

  it("refuses a malformed block", async () => {
    expect((await call({ crmEmail: { fromAddress: "nope" } })).status).toBe(400);
  });
});
