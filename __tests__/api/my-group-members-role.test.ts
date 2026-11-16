/**
 * The coordinator's "add people" door takes Role only as one of the answers
 * (review of 6739135d, Nov 16, 2026).
 *
 * Until Role became text in the database, this route took any text and the
 * database's fixed list refused the rest with a 500. Now nothing below the
 * route refuses an unknown answer, so a hand-made request with role "Doctor"
 * would have been stored, copied to the contact, and then made every staff
 * save of that registration fail.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockAddMembers } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockAddMembers: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/tenant/resolver", () => ({ resolveRequestOrgId: vi.fn(async () => "org-1") }));
vi.mock("@/lib/tenant-lane", () => ({
  runWithTenantLane: (_org: string, _ctx: unknown, run: () => Promise<unknown>) => run(),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "127.0.0.1",
}));
vi.mock("@/services/group-registration-service", () => ({ addGroupMembers: mockAddMembers }));

import { POST } from "@/app/api/registrant/my-group/[groupId]/members/route";

const params = { params: Promise.resolve({ groupId: "group-1" }) };

function request(role: unknown) {
  const attendee: Record<string, unknown> = { firstName: "Ana", lastName: "Member", email: "ana@example.test" };
  if (role !== undefined) attendee.role = role;
  return new Request("http://localhost/api/registrant/my-group/group-1/members", {
    method: "POST",
    body: JSON.stringify({ members: [{ ticketTypeId: "tt-1", attendee }] }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1", role: "REGISTRANT" } });
  mockAddMembers.mockResolvedValue({ ok: true, added: 1 });
});

describe("POST /api/registrant/my-group/[groupId]/members, Role", () => {
  // Since step 1c the route takes any key and the SERVICE refuses one the
  // organisation does not offer (it knows the event); the route says 400.
  it("hands a role to the service, and answers 400 when the service says it is not offered", async () => {
    mockAddMembers.mockResolvedValueOnce({ ok: false, code: "ROLE_NOT_OFFERED", message: "Choose one of the roles listed" });
    const res = await POST(request("Doctor"), params);
    expect(mockAddMembers.mock.calls[0][0].members[0].attendee.role).toBe("Doctor");
    expect(res.status).toBe(400);
  });

  it("refuses a malformed role before the service", async () => {
    const res = await POST(request("x".repeat(101)), params);
    expect(res.status).toBe(400);
    expect(mockAddMembers).not.toHaveBeenCalled();
  });

  it("takes one of the answers", async () => {
    await POST(request("PHYSICIAN"), params);
    expect(mockAddMembers).toHaveBeenCalledTimes(1);
    expect(mockAddMembers.mock.calls[0][0].members[0].attendee.role).toBe("PHYSICIAN");
  });

  it("takes an empty role as no role, and no role at all", async () => {
    await POST(request(""), params);
    await POST(request(null), params);
    await POST(request(undefined), params);
    const roles = mockAddMembers.mock.calls.map((call) => call[0].members[0].attendee.role ?? null);
    expect(roles).toEqual([null, null, null]);
  });
});
