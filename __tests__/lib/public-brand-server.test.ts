/**
 * Loading the attendee-facing brand by organisation (Nov 10, 2026 review): the
 * brand is wording, so a failed lookup falls back instead of cancelling the
 * confirmation email or the reviewer invitation, and the failure is not cached.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { findUnique, warn } = vi.hoisted(() => ({ findUnique: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { organization: { findUnique } } }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn, info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant/resolver", () => ({ normalizeHost: vi.fn(), resolveTenantOrg: vi.fn() }));

import { forgetBrand, loadPublicBrandForOrg } from "@/lib/public-brand-server";
import { NO_ORGANISATION_BRAND } from "@/lib/public-brand";

describe("loadPublicBrandForOrg", () => {
  beforeEach(() => {
    findUnique.mockReset();
    warn.mockReset();
    forgetBrand("org-1");
  });

  it("never throws: a failed lookup gives the default brand and logs", async () => {
    findUnique.mockRejectedValueOnce(new Error("connection reset"));
    await expect(loadPublicBrandForOrg("org-1")).resolves.toEqual(NO_ORGANISATION_BRAND);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "public-brand:org-load-failed", orgId: "org-1" }));
  });

  it("does not cache the failure: the next call reads again", async () => {
    findUnique.mockRejectedValueOnce(new Error("connection reset"));
    await loadPublicBrandForOrg("org-1");
    findUnique.mockResolvedValueOnce({ name: "MM Group", logo: null, settings: { publicBrand: { name: "Meeting Minds Experts" } } });
    await expect(loadPublicBrandForOrg("org-1")).resolves.toMatchObject({ name: "Meeting Minds Experts" });
  });
});
