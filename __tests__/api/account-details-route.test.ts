/**
 * /api/registrant/account-details (My Details, Nov 9, 2026): only the caller's
 * own account, the registration form's rules, and the delta taken against
 * what the page showed. The copy rules themselves are pinned in
 * __tests__/lib/registrant-details.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockScope, details, mockRateLimit } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockScope: vi.fn(),
  mockRateLimit: vi.fn(),
  details: {
    readAccountDetails: vi.fn(),
    saveAccountProfile: vi.fn(),
    copyToUpcomingRegistrations: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: { registration: { count: vi.fn(async () => 2) } } }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({ checkRateLimit: mockRateLimit, getClientIp: () => "1.1.1.1" }));
vi.mock("@/lib/tenant/resolver", () => ({ resolveRequestOrgId: vi.fn(async () => null) }));
vi.mock("@/lib/tenant-lane", () => ({ runWithTenantLane: (_o: unknown, _c: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/registrant-access", () => ({ loadRegistrantScope: mockScope }));
vi.mock("@/lib/registrant-details", async () => {
  const real = await vi.importActual<typeof import("@/lib/registrant-details")>("@/lib/registrant-details");
  return { ...real, ...details };
});

import { GET, PUT } from "@/app/api/registrant/account-details/route";

const VALID = {
  title: "DR", role: "PHYSICIAN", firstName: "Anna", lastName: "Lee", organization: "New Clinic", jobTitle: "Consultant",
  phone: "+971500000000", city: "Dubai", country: "UAE", specialty: "Cardiology",
};
const BEFORE = {
  firstName: "Anna", lastName: "Lee", title: "DR", role: "PHYSICIAN", organization: "Clinic", jobTitle: "Consultant",
  phone: "+971500000000", city: "Dubai", state: null, zipCode: null, country: "UAE", specialty: "Cardiology", customSpecialty: null,
};
const put = (body: unknown) => PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", tokenVersion: 0 } });
  mockScope.mockResolvedValue({ userId: "u1", email: "anna@example.com", confirmed: true });
  mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  details.readAccountDetails.mockResolvedValue({ details: BEFORE, source: "account", marketing: { consented: false, since: null } });
  details.copyToUpcomingRegistrations.mockResolvedValue({ updated: 1, skipped: 0, failed: 0 });
});

describe("account-details", () => {
  it("401 without a session, for both verbs", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET(new Request("http://x"))).status).toBe(401);
    expect((await put(VALID)).status).toBe(401);
    expect(details.saveAccountProfile).not.toHaveBeenCalled();
  });

  it("GET answers for the caller's own scope only, with the upcoming count", async () => {
    const res = await GET(new Request("http://x"));
    expect(await res.json()).toMatchObject({ email: "anna@example.com", source: "account", upcomingRegistrations: 2 });
    expect(mockScope).toHaveBeenCalledWith("u1", { sessionTokenVersion: 0 });
  });

  it("400 on a required field missing, and 'Others' without the specialty written in", async () => {
    expect((await put({ ...VALID, organization: "" })).status).toBe(400);
    expect((await put({ ...VALID, specialty: "Others" })).status).toBe(400);
    expect(details.saveAccountProfile).not.toHaveBeenCalled();
  });

  it("saves to the caller's account and copies only what changed", async () => {
    const res = await put({ ...VALID, marketingConsent: true });
    expect(res.status).toBe(200);
    expect(details.saveAccountProfile).toHaveBeenCalledWith("u1", expect.objectContaining({ organization: "New Clinic" }), true, "1.1.1.1");
    expect(details.copyToUpcomingRegistrations).toHaveBeenCalledWith("u1", ["organization"], expect.any(Object), expect.any(Date));
  });

  it("429 when saving too often", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 60 });
    expect((await put(VALID)).status).toBe(429);
  });
});
