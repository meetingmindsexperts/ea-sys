/**
 * /api/profile is the STAFF profile: a name and the email signature appended to
 * organiser emails.
 *
 * It used to be open to every authenticated user "because it only edits your
 * own row". True, but a submitter or registrant never sends an organiser email,
 * so the signature they could store was data that could never render — and the
 * page it belongs to is now staff-only. The route is the door; hiding the menu
 * entry is not a control.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    user: { findUnique: vi.fn(), update: vi.fn() },
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
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));

const patchRequest = () =>
  new Request("http://x/api/profile", {
    method: "PATCH",
    body: JSON.stringify({ emailSignature: "<p>Regards</p>" }),
  });

describe("/api/profile is staff-only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.user.findUnique.mockResolvedValue({ id: "u1", emailSignature: null });
    mockDb.user.update.mockResolvedValue({ id: "u1", emailSignature: "<p>Regards</p>" });
  });

  it.each(["SUBMITTER", "REVIEWER", "REGISTRANT"])("%s is refused on GET", async (role) => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role } });
    const { GET } = await import("@/app/api/profile/route");
    const res = await GET();
    expect(res.status).toBe(403);
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
  });

  it.each(["SUBMITTER", "REVIEWER", "REGISTRANT"])(
    "%s is refused on PATCH, and nothing is written",
    async (role) => {
      mockAuth.mockResolvedValue({ user: { id: "u1", role } });
      const { PATCH } = await import("@/app/api/profile/route");
      const res = await PATCH(patchRequest());
      expect(res.status).toBe(403);
      expect(mockDb.user.update).not.toHaveBeenCalled();
    },
  );

  it("fails closed on an unrecognised role", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "FUTURE_ROLE" } });
    const { GET } = await import("@/app/api/profile/route");
    expect((await GET()).status).toBe(403);
  });

  it.each(["ADMIN", "ORGANIZER", "MEMBER", "ONSITE", "CRM_USER", "WEBINARS", "SUPER_ADMIN"])(
    "%s still reads and writes their own signature",
    async (role) => {
      mockAuth.mockResolvedValue({ user: { id: "u1", role } });
      const { GET, PATCH } = await import("@/app/api/profile/route");
      expect((await GET()).status).toBe(200);
      expect((await PATCH(patchRequest())).status).toBe(200);
      expect(mockDb.user.update).toHaveBeenCalled();
    },
  );

  it("still 401s when signed out", async () => {
    mockAuth.mockResolvedValue(null);
    const { GET } = await import("@/app/api/profile/route");
    expect((await GET()).status).toBe(401);
  });
});
