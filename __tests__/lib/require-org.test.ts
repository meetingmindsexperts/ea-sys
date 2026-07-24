/**
 * requireOrgId — the shared guard for the `organizationId!` footgun
 * (JAVASCRIPT-NEXTJS-1N). Returns the orgId for an org-bound user, or a 403
 * NextResponse for an org-independent (null-org) user.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
const warn = vi.fn();
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: (...a: unknown[]) => warn(...a), info: vi.fn(), error: vi.fn() } }));

import { requireOrgId } from "@/lib/require-org";

describe("requireOrgId", () => {
  it("returns { orgId } for an org-bound user", () => {
    const r = requireOrgId({ user: { id: "u1", role: "ADMIN", organizationId: "org-1" } });
    expect(r).toEqual({ orgId: "org-1" });
    expect("error" in r).toBe(false);
  });

  it("403 + warn for a null-org user (SUBMITTER)", () => {
    warn.mockClear();
    const r = requireOrgId({ user: { id: "u2", role: "SUBMITTER", organizationId: null } }, { route: "x", eventId: "ev-1" });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error.status).toBe(403);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u2", role: "SUBMITTER", route: "x", eventId: "ev-1" }),
      "require-org:no-org",
    );
  });

  it("403 for a null session / missing user (defensive)", () => {
    expect("error" in requireOrgId(null)).toBe(true);
    expect("error" in requireOrgId({})).toBe(true);
    expect("error" in requireOrgId({ user: {} })).toBe(true);
  });
});
