/**
 * GET /api/admin/infra — WHOSE numbers does it return?
 *
 * The infra cards (CPU, disk, alarms, SES) are the same for everyone, but the
 * business counters are not. Since multi-tenancy item 5 the snapshot's
 * policied reads run on the privileged lane for the platform view, so getting
 * the audience wrong here is a cross-tenant disclosure rather than a cosmetic
 * bug: a tenant's ADMIN would be shown registrations, payments and email
 * volumes belonging to every other tenant on the instance.
 *
 * The route is the only place that decides, and it decides from the role, so
 * this pins the mapping directly. It is asserted on the ARGUMENT passed to
 * getInfraSnapshot rather than on the response body, because the body looks
 * identical either way. That is precisely why the mistake would be invisible
 * in review and in manual testing on master, where there is only one org and
 * both scopes return the same numbers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockGetSnapshot, mockCheckRateLimit, warnCalls } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockGetSnapshot: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  warnCalls: [] as Array<Record<string, unknown>>,
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
vi.mock("@/lib/security", () => ({ checkRateLimit: () => mockCheckRateLimit() }));
vi.mock("@/lib/logger", () => ({
  apiLogger: {
    warn: (payload: Record<string, unknown>) => warnCalls.push(payload),
    error: () => undefined,
    info: () => undefined,
    debug: () => undefined,
  },
}));
// A plain mock, NOT the importOriginal spread used elsewhere in this suite:
// importing the real aws-ops for its exports would also run its module side
// effects, which construct a Prisma client and trip the INC-002 dev guard. The
// only runtime export the route needs is getInfraSnapshot; `InfraScope` is a
// type and is erased before this ever runs.
vi.mock("@/lib/infra/aws-ops", () => ({
  getInfraSnapshot: (...args: unknown[]) => mockGetSnapshot(...args),
}));

const call = async () => {
  const { GET } = await import("@/app/api/admin/infra/route");
  return GET(new Request("http://x/api/admin/infra"));
};

beforeEach(() => {
  vi.clearAllMocks();
  warnCalls.length = 0;
  mockCheckRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  mockGetSnapshot.mockResolvedValue({ generatedAt: "now" });
});

describe("infra snapshot scope", () => {
  it("SUPER_ADMIN gets the platform view (totals across every tenant)", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "sa", role: "SUPER_ADMIN", organizationId: "org1" },
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mockGetSnapshot).toHaveBeenCalledWith(false, { kind: "platform" });
  });

  it("ADMIN gets their OWN org's numbers, never the platform's", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "a1", role: "ADMIN", organizationId: "org1" },
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mockGetSnapshot).toHaveBeenCalledWith(false, { kind: "org", orgId: "org1" });
  });

  it("an ADMIN with no org is refused rather than widened to the platform view", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "a2", role: "ADMIN", organizationId: null },
    });

    const res = await call();

    expect(res.status).toBe(403);
    expect(mockGetSnapshot).not.toHaveBeenCalled();
    expect(warnCalls.some((w) => w.userId === "a2")).toBe(true);
  });

  it("still refuses every role below ADMIN", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "o1", role: "ORGANIZER", organizationId: "org1" },
    });

    const res = await call();

    expect(res.status).toBe(403);
    expect(mockGetSnapshot).not.toHaveBeenCalled();
  });

  it("401s with no session", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
  });
});
