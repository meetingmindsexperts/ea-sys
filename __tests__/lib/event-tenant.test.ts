/**
 * Event tenant discovery (src/lib/tenant/event-tenant.ts): the one sanctioned
 * pre-lane read of Event.
 *
 * Pinned: it builds the public filter through publicEventWhere (so the host's
 * tenant stays bound), it selects ONLY id and organisation (the contract that
 * makes moving it onto the privileged lane safe later), and a miss is null.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { findFirst, operatorFindFirst, publicEventWhere } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  operatorFindFirst: vi.fn(),
  publicEventWhere: vi.fn(),
}));

// The app's client and the privileged one, told apart (Event RLS step 6).
vi.mock("@/lib/db", () => ({ db: { event: { findFirst } }, dbOperator: { event: { findFirst: operatorFindFirst } } }));
vi.mock("@/lib/public-event", () => ({ publicEventWhere }));

import { resolveEventTenant, resolvePublicEventOrg } from "@/lib/tenant/event-tenant";

beforeEach(() => {
  findFirst.mockReset();
  operatorFindFirst.mockReset();
  publicEventWhere.mockReset();
});

describe("resolveEventTenant", () => {
  it("selects only the id and the organisation, on the privileged client", async () => {
    operatorFindFirst.mockResolvedValue({ id: "ev_1", organizationId: "org_1" });
    const where = { id: "ev_1", organizationId: "org_1" };
    await expect(resolveEventTenant(where)).resolves.toEqual({ id: "ev_1", organizationId: "org_1" });
    expect(operatorFindFirst).toHaveBeenCalledWith({ where, select: { id: true, organizationId: true } });
    // The app's client cannot read an event before a lane exists once Event has a policy.
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("returns null when nothing matches", async () => {
    operatorFindFirst.mockResolvedValue(null);
    await expect(resolveEventTenant({ id: "missing" })).resolves.toBeNull();
  });
});

describe("resolvePublicEventOrg", () => {
  // A public address says whose it is, so it is read on the app's client inside that lane: never the privileged one.
  afterEach(() => expect(operatorFindFirst).not.toHaveBeenCalled());

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
