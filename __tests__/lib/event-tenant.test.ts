/**
 * Event tenant discovery (src/lib/tenant/event-tenant.ts): the one sanctioned
 * pre-lane read of Event.
 *
 * Pinned: it builds the public filter through publicEventWhere (so the host's
 * tenant stays bound), it selects ONLY id and organisation (the contract that
 * makes moving it onto the privileged lane safe later), and a miss is null.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { findFirst, publicEventWhere } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  publicEventWhere: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { event: { findFirst } } }));
vi.mock("@/lib/public-event", () => ({ publicEventWhere }));

import { resolveEventTenant, resolvePublicEventOrg } from "@/lib/tenant/event-tenant";

beforeEach(() => {
  findFirst.mockReset();
  publicEventWhere.mockReset();
});

describe("resolveEventTenant", () => {
  it("selects only the id and the organisation", async () => {
    findFirst.mockResolvedValue({ id: "ev_1", organizationId: "org_1" });
    const where = { id: "ev_1", organizationId: "org_1" };
    await expect(resolveEventTenant(where)).resolves.toEqual({ id: "ev_1", organizationId: "org_1" });
    expect(findFirst).toHaveBeenCalledWith({ where, select: { id: true, organizationId: true } });
  });

  it("returns null when nothing matches", async () => {
    findFirst.mockResolvedValue(null);
    await expect(resolveEventTenant({ id: "missing" })).resolves.toBeNull();
  });
});

describe("resolvePublicEventOrg", () => {
  it("scopes by the request host through publicEventWhere", async () => {
    const req = new Request("https://events.example.com/e/conf");
    const hostWhere = { organizationId: "org_1", slug: "conf" };
    publicEventWhere.mockResolvedValue(hostWhere);
    findFirst.mockResolvedValue({ id: "ev_1", organizationId: "org_1" });

    await expect(resolvePublicEventOrg(req, "conf")).resolves.toBe("org_1");
    expect(publicEventWhere).toHaveBeenCalledWith(req, "conf", undefined);
    expect(findFirst).toHaveBeenCalledWith({ where: hostWhere, select: { id: true, organizationId: true } });
  });

  it("passes scope options through", async () => {
    const req = new Request("https://events.example.com/e/conf");
    publicEventWhere.mockResolvedValue({ slug: "conf" });
    findFirst.mockResolvedValue(null);
    await resolvePublicEventOrg(req, "conf", { statuses: ["PUBLISHED"] });
    expect(publicEventWhere).toHaveBeenCalledWith(req, "conf", { statuses: ["PUBLISHED"] });
  });

  it("returns null when the slug does not resolve on this host", async () => {
    publicEventWhere.mockResolvedValue({ slug: "nope" });
    findFirst.mockResolvedValue(null);
    await expect(resolvePublicEventOrg(new Request("https://x.test/"), "nope")).resolves.toBeNull();
  });
});
