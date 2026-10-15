/**
 * /api/organization/sponsor-tiers (Oct 15, 2026). Pins who may read and who
 * may change the organisation's tiers, with the real permission check:
 *  - changing them needs sponsors.manage on EVERY event (owner ruling), so a
 *    role that manages sponsors only on webinars is refused (review of b5ce5414);
 *  - a no-organisation account is refused before anything runs;
 *  - the service's refusal reaches the client with its code and `inUse`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, saveSponsorTiers } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  saveSponsorTiers: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/sponsors", () => ({
  getSponsorTiers: async () => (await import("@/lib/sponsor-tiers")).sponsorTierList([{ key: "associate", label: "Associate" }]),
}));
vi.mock("@/services/sponsor-tier-service", () => ({ saveSponsorTiers }));

import { GET, PUT } from "@/app/api/organization/sponsor-tiers/route";

const ORG = "org-1";
const user = (role: string, extra: Record<string, unknown> = {}) => ({ user: { id: "u1", role, organizationId: ORG, ...extra } });
const put = (body: unknown) => PUT({ json: async () => body } as unknown as Request);

beforeEach(() => {
  vi.clearAllMocks();
  saveSponsorTiers.mockResolvedValue({ ok: true, tiers: [] });
});

describe("GET", () => {
  it("returns the standard tiers then the organisation's own", async () => {
    mockAuth.mockResolvedValue(user("ADMIN"));
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tiers.map((t: { key: string }) => t.key).slice(-2)).toEqual(["exhibitor", "associate"]);
  });

  it("refuses an account with no organisation", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: null } });
    expect((await GET()).status).toBe(403);
  });
});

describe("PUT", () => {
  it("lets an admin change the tiers", async () => {
    mockAuth.mockResolvedValue(user("ADMIN"));
    const res = await put({ tiers: [{ label: "Associate" }] });
    expect(res.status).toBe(200);
    expect(saveSponsorTiers).toHaveBeenCalledWith({ organizationId: ORG, actorUserId: "u1", tiers: [{ label: "Associate" }] });
  });

  it("lets an organizer change them (sponsor management on every event)", async () => {
    mockAuth.mockResolvedValue(user("ORGANIZER"));
    expect((await put({ tiers: [] })).status).toBe(200);
  });

  it("refuses a role that manages sponsors only on webinars, before the service runs", async () => {
    mockAuth.mockResolvedValue(user("MEMBER", { procurementPermissions: ["sponsors.manage@WEBINAR"] }));
    const res = await put({ tiers: [{ label: "Anything" }] });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "NOT_ORG_WIDE" });
    expect(saveSponsorTiers).not.toHaveBeenCalled();
  });

  it("refuses a role without sponsor management at all", async () => {
    mockAuth.mockResolvedValue(user("MEMBER"));
    expect((await put({ tiers: [] })).status).toBe(403);
    expect(saveSponsorTiers).not.toHaveBeenCalled();
  });

  it("passes the in-use refusal through with its code and counts", async () => {
    mockAuth.mockResolvedValue(user("ADMIN"));
    saveSponsorTiers.mockResolvedValue({
      ok: false,
      code: "TIER_IN_USE",
      message: "Move the sponsors off these tiers before deleting them: Associate (2).",
      inUse: [{ key: "associate", label: "Associate", sponsors: 2 }],
    });
    const res = await put({ tiers: [] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "TIER_IN_USE", inUse: [{ key: "associate", sponsors: 2 }] });
  });

  it("refuses a malformed body", async () => {
    mockAuth.mockResolvedValue(user("ADMIN"));
    expect((await put({ tiers: "Associate" })).status).toBe(400);
    expect(saveSponsorTiers).not.toHaveBeenCalled();
  });
});
