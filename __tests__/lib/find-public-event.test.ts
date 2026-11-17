/**
 * The public reads of Event (src/lib/tenant/event-tenant.ts; Event RLS step 2,
 * third sweep, Nov 17 2026): `findPublicEvent` for one event behind a public
 * address, `inHostLane` / `inScopeLane` for a public list, and `inOwnLane` for
 * a list behind a gate. Pinned here: the query is the one the routes made
 * before, the lane is entered BEFORE the event is read, the lane is the one
 * the request's host names, and nothing privileged is used while the host
 * names an organisation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { findFirst, info, resolveTenantOrg } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  info: vi.fn(),
  resolveTenantOrg: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { event: { findFirst } } }));
vi.mock("@/lib/logger", () => ({
  dbLogger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/tenant/resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/resolver")>()),
  resolveTenantOrg,
}));

import { findPublicEvent, inHostLane, inOwnLane, inScopeLane } from "@/lib/tenant/event-tenant";
import { UNRESOLVED_TENANT_SENTINEL } from "@/lib/public-event";
import { getTenantOrgId } from "@/lib/tenant-context";
import { noteUnlanedEventQuery, resetLaneShadowForTests } from "@/lib/tenant/lane-shadow";

const req = (host: string) => new Request("https://x/y", { headers: { host } });

/** What each read saw: its arguments, the lane it ran in, and whether the detector would report it. */
let reads: { args: { where: unknown; select?: unknown }; lane: string | undefined; reported: boolean }[];
const ORIGINAL = process.env.RLS_SHADOW;

beforeEach(() => {
  reads = [];
  info.mockClear();
  resetLaneShadowForTests();
  process.env.RLS_SHADOW = "1";
  resolveTenantOrg.mockReset();
  resolveTenantOrg.mockResolvedValue({ orgId: "acme", source: "domain" });
  findFirst.mockReset();
  findFirst.mockImplementation(async (args) => {
    const before = info.mock.calls.length;
    // What the query extension does for every Event operation.
    noteUnlanedEventQuery("Event", `findFirst#${reads.length}`);
    reads.push({ args, lane: getTenantOrgId() ?? undefined, reported: info.mock.calls.length > before });
    return { id: "ev1", organizationId: "acme", name: "Congress" };
  });
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.RLS_SHADOW;
  else process.env.RLS_SHADOW = ORIGINAL;
});

describe("findPublicEvent", () => {
  it("is the query the public routes made: the host-bound filter and the route's select, in ONE read", async () => {
    const event = await findPublicEvent(req("acme.example"), "summit", { statuses: ["PUBLISHED", "LIVE"] }, { select: { id: true, name: true } });
    expect(event).toMatchObject({ id: "ev1", name: "Congress" });
    expect(reads).toHaveLength(1);
    expect(reads[0].args).toEqual({
      where: { organizationId: "acme", slug: "summit", status: { in: ["PUBLISHED", "LIVE"] } },
      select: { id: true, name: true },
    });
  });

  it("enters the lane of the organisation the host names BEFORE the read, so nothing reads Event outside a lane", async () => {
    await findPublicEvent(req("acme.example"), "summit", {}, { select: { id: true } });
    expect(reads[0]).toMatchObject({ lane: "acme", reported: false });
    expect(resolveTenantOrg).toHaveBeenCalledWith("acme.example");
  });

  it("takes the Host header itself from a server component, and an id where the slug belongs when asked", async () => {
    await findPublicEvent("ACME.example:3000", "ev1", { allowIdFallback: true }, { include: { tracks: true } });
    expect(resolveTenantOrg).toHaveBeenCalledWith("acme.example");
    expect(reads[0].args).toEqual({ where: { organizationId: "acme", OR: [{ slug: "ev1" }, { id: "ev1" }] }, include: { tracks: true } });
    expect(reads[0].lane).toBe("acme");
  });

  it("returns null when the slug is not this host's, without a second read", async () => {
    findFirst.mockResolvedValue(null);
    expect(await findPublicEvent(req("acme.example"), "other", {}, { select: { id: true } })).toBeNull();
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it("takes the row's shape only: which row is the address's to say", async () => {
    // @ts-expect-error a filter of its own is not part of what a route may pass
    await findPublicEvent(req("acme.example"), "summit", {}, { select: { id: true }, where: { id: "other" } });
    expect(reads[0].args.where).toEqual({ organizationId: "acme", slug: "summit" });
  });

  it("a host that names no organisation (a developer's machine) has no lane: the read runs as it always has, once", async () => {
    resolveTenantOrg.mockResolvedValue({ orgId: null, source: "unscoped" });
    const event = await findPublicEvent(req("localhost:3113"), "summit", {}, { select: { id: true, name: true } });
    expect(event).toMatchObject({ name: "Congress" });
    expect(reads).toHaveLength(1);
    expect(reads[0].args).toEqual({ where: { slug: "summit" }, select: { id: true, name: true } });
    // No lane, and the detector says so: with row security on, this read finds nothing.
    expect(reads[0]).toMatchObject({ lane: undefined, reported: true });
  });

  it("uses nothing privileged: the sanctioned discovery read is never made for a public address", async () => {
    for (const resolution of [{ orgId: "acme", source: "domain" }, { orgId: null, source: "unscoped" }, { orgId: null, source: "unknown-enforced" }]) {
      resolveTenantOrg.mockResolvedValue(resolution);
      await findPublicEvent(req("h.example"), "summit", {}, { select: { id: true, organizationId: true } });
    }
    // The discovery asks for exactly these two columns with its own select; every read here carried the route's.
    expect(reads).toHaveLength(3);
  });

  it("on a deployment that refused the host, the filter and the lane are the sentinel's: an organisation that does not exist", async () => {
    resolveTenantOrg.mockResolvedValue({ orgId: null, source: "unknown-enforced" });
    await findPublicEvent(req("evil.example"), "summit", {}, { select: { id: true } });
    expect(reads[0].args.where).toEqual({ organizationId: UNRESOLVED_TENANT_SENTINEL, slug: "summit" });
    expect(reads[0].lane).toBe(UNRESOLVED_TENANT_SENTINEL);
  });
});

describe("a public list: inHostLane and inScopeLane", () => {
  let lane: string | undefined;
  const probe = async () => {
    lane = getTenantOrgId() ?? undefined;
    return "rows";
  };
  beforeEach(() => {
    lane = "unset";
  });

  it("runs inside the lane of the organisation the host names, and returns what the query returned", async () => {
    expect(await inHostLane(req("acme.example"), probe)).toBe("rows");
    expect(lane).toBe("acme");
    await inHostLane("acme.example", probe);
    expect(lane).toBe("acme");
  });

  it("a refused host gets the sentinel's lane, where every policied table answers nothing", async () => {
    resolveTenantOrg.mockResolvedValue({ orgId: null, source: "unknown-enforced" });
    await inHostLane(req("evil.example"), probe);
    expect(lane).toBe(UNRESOLVED_TENANT_SENTINEL);
  });

  it("a host that names no organisation on a deployment that does not enforce hosts runs as it always has", async () => {
    resolveTenantOrg.mockResolvedValue({ orgId: null, source: "unscoped" });
    expect(await inHostLane(req("localhost"), probe)).toBe("rows");
    expect(lane).toBeUndefined();
  });

  it("inScopeLane takes the scope a caller already resolved, and never resolves the host again", async () => {
    await inScopeLane({ organizationId: "globex" }, probe);
    expect(lane).toBe("globex");
    await inScopeLane({}, probe);
    expect(lane).toBeUndefined();
    expect(resolveTenantOrg).not.toHaveBeenCalled();
  });
});

describe("inOwnLane: a list of events behind a gate", () => {
  let lane: string | undefined;
  const probe = async () => {
    lane = getTenantOrgId() ?? undefined;
    return "rows";
  };

  it("runs a team member's and an API key's list inside their own organisation's lane, whatever the host", async () => {
    resolveTenantOrg.mockResolvedValue({ orgId: "other-host-org", source: "domain" });
    expect(await inOwnLane({ principal: { organizationId: "org1", baseRole: "ORGANIZER", fromApiKey: false } }, req("x"), probe)).toBe("rows");
    expect(lane).toBe("org1");
    await inOwnLane({ principal: { organizationId: "org1", baseRole: null, fromApiKey: true } }, undefined, probe);
    expect(lane).toBe("org1");
    expect(resolveTenantOrg).not.toHaveBeenCalled();
  });

  it("runs a reviewer's, submitter's or registrant's list in the lane the HOST names, never their account's organisation", async () => {
    for (const principal of [
      { organizationId: null, baseRole: "SUBMITTER", fromApiKey: false },
      // The internal-domain rule attaches an organisation to a linked role; it is still not their lane.
      { organizationId: "org1", baseRole: "REVIEWER", fromApiKey: false },
      { organizationId: null, baseRole: "REGISTRANT", fromApiKey: false },
    ]) {
      lane = "unset";
      expect(await inOwnLane({ principal }, req("acme.example"), probe)).toBe("rows");
      expect(lane, JSON.stringify(principal)).toBe("acme");
    }
  });

  it("a team role with no organisation gets the host's lane too: on master that is the one organisation", async () => {
    await inOwnLane({ principal: { organizationId: null, baseRole: "SUPER_ADMIN", fromApiKey: false } }, "events.example", probe);
    expect(lane).toBe("acme");
  });
});
