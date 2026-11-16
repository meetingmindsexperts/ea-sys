/**
 * findGatedEvent (src/lib/tenant/event-tenant.ts; Event RLS step 2, Nov 16
 * 2026): the read every per-event route opens with. Pinned here: it is the
 * same query the routes made before (so master is unchanged), a caller with an
 * organisation reads inside that organisation's lane, a caller with none goes
 * through the sanctioned discovery, and event CONTENT is never returned by a
 * read made outside a lane.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { findFirst, info } = vi.hoisted(() => ({ findFirst: vi.fn(), info: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { event: { findFirst } } }));
vi.mock("@/lib/logger", () => ({
  dbLogger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { findGatedEvent } from "@/lib/tenant/event-tenant";
import { getTenantOrgId } from "@/lib/tenant-context";
import { noteUnlanedEventQuery, resetLaneShadowForTests } from "@/lib/tenant/lane-shadow";

const WHERE = { id: "ev1", organizationId: "org1" };
const staff = { principal: { organizationId: "org1", baseRole: "ORGANIZER", fromApiKey: false }, eventWhere: WHERE };
const LINKED = { id: "ev1", speakers: { some: { userId: "u1" } } };
const orgNull = { principal: { organizationId: null, baseRole: "SUBMITTER", fromApiKey: false }, eventWhere: LINKED };

/** What each read saw: its arguments, the lane it ran in, and whether the detector would report it. */
let reads: { args: { where: unknown; select?: unknown }; lane: string | undefined; reported: boolean }[];
const ORIGINAL = process.env.RLS_SHADOW;

beforeEach(() => {
  reads = [];
  info.mockClear();
  resetLaneShadowForTests();
  process.env.RLS_SHADOW = "1";
  findFirst.mockReset();
  findFirst.mockImplementation(async (args) => {
    const before = info.mock.calls.length;
    // What the query extension does for every Event operation.
    noteUnlanedEventQuery("Event", `findFirst#${reads.length}`);
    reads.push({ args, lane: getTenantOrgId() ?? undefined, reported: info.mock.calls.length > before });
    return { id: "ev1", organizationId: "org9", name: "Congress" };
  });
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.RLS_SHADOW;
  else process.env.RLS_SHADOW = ORIGINAL;
});

describe("findGatedEvent", () => {
  it("for a caller with an organisation: ONE read, the gate's filter and the route's select, inside that organisation's lane", async () => {
    const event = await findGatedEvent(staff, { select: { id: true, name: true } });
    expect(event).toMatchObject({ id: "ev1" });
    expect(reads).toHaveLength(1);
    expect(reads[0].args).toEqual({ where: WHERE, select: { id: true, name: true } });
    expect(reads[0]).toMatchObject({ lane: "org1", reported: false });
  });

  it("is the same query the routes made before: nothing added to it, nothing dropped", async () => {
    await findGatedEvent(staff, { select: { id: true }, orderBy: { createdAt: "desc" } });
    expect(findFirst).toHaveBeenCalledWith({ where: WHERE, select: { id: true }, orderBy: { createdAt: "desc" } });
    await findGatedEvent(staff, {});
    expect(findFirst).toHaveBeenLastCalledWith({ where: WHERE });
  });

  it("for a caller with no organisation asking only id and organisation: one read, the sanctioned discovery", async () => {
    for (const select of [{ id: true }, { id: true, organizationId: true }, { organizationId: true }] as const) {
      reads = [];
      await findGatedEvent(orgNull, { select });
      expect(reads, JSON.stringify(select)).toHaveLength(1);
      expect(reads[0].args).toEqual({ where: orgNull.eventWhere, select });
      // No lane yet, and the detector treats it as the sanctioned discovery.
      expect(reads[0]).toMatchObject({ lane: undefined, reported: false });
    }
  });

  it("for a caller with no organisation asking for more: found first, then read inside the EVENT's organisation's lane", async () => {
    const event = await findGatedEvent(orgNull, { select: { id: true, organizationId: true, settings: true } });
    expect(event).toMatchObject({ name: "Congress" });
    expect(reads).toHaveLength(2);
    // The read outside a lane asks for the id and the organisation only ...
    expect(reads[0].args).toEqual({ where: orgNull.eventWhere, select: { id: true, organizationId: true } });
    expect(reads[0]).toMatchObject({ lane: undefined, reported: false });
    // ... and the content comes from a read inside the lane, still under the gate's filter.
    expect(reads[1].args).toEqual({
      where: { AND: [orgNull.eventWhere, { id: "ev1" }] },
      select: { id: true, organizationId: true, settings: true },
    });
    expect(reads[1]).toMatchObject({ lane: "org9", reported: false });
  });

  it("never treats a read with a relation, an include or no select as discovery", async () => {
    for (const args of [{ select: { id: true, organization: { select: { name: true } } } }, { include: { tracks: true } }, {}]) {
      reads = [];
      await findGatedEvent(orgNull, args as never);
      expect(reads, JSON.stringify(args)).toHaveLength(2);
      expect(reads[0].args.select).toEqual({ id: true, organizationId: true });
      expect(reads[1].lane).toBe("org9");
    }
  });

  it("answers null without a second read when the gate's filter matches no event", async () => {
    findFirst.mockResolvedValue(null);
    expect(await findGatedEvent(orgNull, { select: { id: true, settings: true } })).toBeNull();
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(await findGatedEvent(staff, { select: { id: true, settings: true } })).toBeNull();
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it("an organisation's API key reads in that organisation's lane, as its staff do", async () => {
    await findGatedEvent({ principal: { organizationId: "org1", baseRole: null, fromApiKey: true }, eventWhere: WHERE }, { select: { id: true, name: true } });
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ lane: "org1", reported: false });
  });

  it("a reviewer, submitter or registrant whose ACCOUNT carries an organisation is still discovered: the event may be another organisation's", async () => {
    // The internal-domain rule attaches an organisation to such an account; its
    // reach is still the events it is linked to, not that organisation's.
    for (const baseRole of ["REVIEWER", "SUBMITTER", "REGISTRANT"]) {
      reads = [];
      await findGatedEvent({ principal: { organizationId: "org1", baseRole, fromApiKey: false }, eventWhere: LINKED }, { select: { id: true, settings: true } });
      expect(reads, baseRole).toHaveLength(2);
      expect(reads[0]).toMatchObject({ lane: undefined, reported: false });
      // The lane is the EVENT's organisation (org9), never the account's (org1).
      expect(reads[1].lane, baseRole).toBe("org9");
    }
  });

  it("leaves no lane behind it", async () => {
    await findGatedEvent(staff, { select: { id: true } });
    expect(getTenantOrgId()).toBeFalsy();
  });
});
