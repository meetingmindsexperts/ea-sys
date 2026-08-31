/**
 * WHO MAY GRANT HR ACCESS (owner, Aug 31 2026).
 *
 * HR stopped being implied by ADMIN so that some admins can be kept out of it.
 * That only means anything if those admins cannot put themselves back in, so
 * the write is SUPER_ADMIN only. The self-grant case below is the one that
 * makes the whole change real rather than decorative: if it ever passes, the
 * feature is cosmetic and nobody would notice from the outside.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    user: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
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
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/security", () => ({ getClientIp: vi.fn().mockReturnValue("1.2.3.4") }));
vi.mock("@/lib/event-settings", () => ({ removeUserFromEventSettings: vi.fn() }));

const ORG = "org-1";
const TARGET = "user-vivek";

function session(role: string, id = "caller-1") {
  return { user: { id, role, organizationId: ORG } };
}

function req(body: unknown) {
  return { json: async () => body } as unknown as Request;
}

async function patch(body: unknown) {
  const { PUT } = await import("@/app/api/organization/users/[userId]/route");
  return PUT(req(body), { params: Promise.resolve({ userId: TARGET }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.HR_MODULE_ENABLED = "true";
  mockDb.user.findFirst.mockResolvedValue({
    id: TARGET, role: "ADMIN", organizationId: ORG, email: "vivek@example.com",
  });
  mockDb.user.findUnique.mockResolvedValue({
    id: TARGET, role: "ADMIN", organizationId: ORG, email: "vivek@example.com",
  });
  mockDb.user.update.mockResolvedValue({ id: TARGET, hrAccess: true, role: "ADMIN" });
});

describe("granting HR access", () => {
  it("lets a SUPER_ADMIN grant it", async () => {
    mockAuth.mockResolvedValue(session("SUPER_ADMIN"));
    const res = await patch({ hrAccess: true });
    expect(res.status).toBe(200);
    expect(mockDb.user.update).toHaveBeenCalled();
    expect(mockDb.user.update.mock.calls[0][0].data.hrAccess).toBe(true);
  });

  /**
   * The load-bearing one. An ADMIN may already change roles through this
   * endpoint, so without this the excluded admin simply grants themselves.
   */
  it("refuses an ADMIN, including on their own account", async () => {
    mockAuth.mockResolvedValue(session("ADMIN", TARGET));
    const res = await patch({ hrAccess: true });
    expect(res.status).toBe(403);
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });

  it("refuses an ADMIN granting somebody else", async () => {
    mockAuth.mockResolvedValue(session("ADMIN", "some-other-admin"));
    const res = await patch({ hrAccess: true });
    expect(res.status).toBe(403);
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });

  /** Revoking is the same power as granting: an admin must not be able to
   *  remove the HR operator's access either. */
  it("refuses an ADMIN revoking it", async () => {
    mockAuth.mockResolvedValue(session("ADMIN"));
    const res = await patch({ hrAccess: false });
    expect(res.status).toBe(403);
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });

  it("refuses when the module is not available on this deployment", async () => {
    delete process.env.HR_MODULE_ENABLED;
    mockAuth.mockResolvedValue(session("SUPER_ADMIN"));
    const res = await patch({ hrAccess: true });
    expect(res.status).toBe(400);
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });

  /** The flag would otherwise work on an org-null reviewer or a registrant,
   *  who have no HR screen and no business in one. */
  it("refuses a target who is not a team member", async () => {
    mockDb.user.findFirst.mockResolvedValue({
      id: TARGET, role: "REVIEWER", organizationId: ORG, email: "r@example.com",
    });
    mockAuth.mockResolvedValue(session("SUPER_ADMIN"));
    const res = await patch({ hrAccess: true });
    expect(res.status).toBe(400);
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });

  /** An unrelated edit must not be caught by any of the guards above. */
  it("leaves ordinary edits alone", async () => {
    mockAuth.mockResolvedValue(session("ADMIN"));
    mockDb.user.update.mockResolvedValue({ id: TARGET, firstName: "Vivek" });
    const res = await patch({ firstName: "Vivek" });
    expect(res.status).toBe(200);
  });
});
