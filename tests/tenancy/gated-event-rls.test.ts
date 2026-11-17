/**
 * Event RLS against the REAL Event policy (prisma/rls/event.sql; it was the
 * harness-only pilot until step 6, Nov 17 2026). First written Nov 16 for the
 * read every per-event route opens with (`findGatedEvent`) and the settings
 * merge about fifteen routes write through (`updateEventSettings`). Runs as
 * the non-owner app_user through pgbouncer with RLS_SET_LOCAL=1, like rls.test.ts.
 *
 * The unit tests pin WHICH lane each caller reads in. Only this file can show
 * that the read then actually returns the row, and that the write lands,
 * under a policy: the two findings of the review of 2db57e7f (the settings
 * merge's raw row lock, and discovery having one place to move from) were
 * invisible to every mocked test.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { findGatedEvent, findPublicEvent, inHostLane, inOwnLane, inScopeLane, resolvePublicEventOrg } from "@/lib/tenant/event-tenant";
import { clearTenantResolverCache } from "@/lib/tenant/resolver";
import { updateEventSettings } from "@/lib/event-settings";
import { ORG_A_ID, ORG_B_ID, EVENT_A_SHARED_ID, EVENT_B_SHARED_ID, EVENT_B_ONLY_ID, HOST_A, HOST_B, SHARED_SLUG, ORG_B_ONLY_SLUG } from "./constants";

const staffA = { organizationId: ORG_A_ID, baseRole: "ORGANIZER", fromApiKey: false };
const keyA = { organizationId: ORG_A_ID, baseRole: null, fromApiKey: true };
const OWN = { id: EVENT_A_SHARED_ID, organizationId: ORG_A_ID };

let owner: PrismaClient;
let settingsBefore: unknown;

beforeAll(async () => {
  process.env.RLS_SET_LOCAL = "1";
  // The owner role bypasses the policy: used only to read and restore the fixture.
  owner = new PrismaClient({ datasourceUrl: process.env.TENANCY_DIRECT_URL });
  settingsBefore = (await owner.event.findUnique({ where: { id: EVENT_A_SHARED_ID }, select: { settings: true } }))?.settings ?? {};
});
afterAll(async () => {
  await owner.event.update({ where: { id: EVENT_A_SHARED_ID }, data: { settings: settingsBefore as object } });
  delete process.env.RLS_SET_LOCAL;
  await owner.$disconnect();
  await db.$disconnect();
});

describe("findGatedEvent under the Event policy", () => {
  it("THE BUG IT REPLACES: the same read made bare, outside a lane, finds nothing and says nothing", async () => {
    // What 238 routes did: under a policy the route answers 404 with nothing logged.
    expect(await db.event.findFirst({ where: OWN, select: { id: true } })).toBeNull();
  });

  it("a team member reads their organisation's event: the id, and its content", async () => {
    expect(await findGatedEvent({ principal: staffA, eventWhere: OWN }, { select: { id: true } })).toEqual({ id: EVENT_A_SHARED_ID });
    const full = await findGatedEvent({ principal: staffA, eventWhere: OWN }, { select: { id: true, organizationId: true, slug: true, name: true } });
    expect(full).toMatchObject({ id: EVENT_A_SHARED_ID, organizationId: ORG_A_ID });
    expect(typeof full?.name).toBe("string");
  });

  it("an organisation's API key reads as its staff do", async () => {
    expect(await findGatedEvent({ principal: keyA, eventWhere: OWN }, { select: { id: true } })).toEqual({ id: EVENT_A_SHARED_ID });
  });

  it("DEFENCE BEHIND THE GATE: a filter that wrongly names another tenant's event still finds nothing", async () => {
    // The reason a team member reads inside their OWN lane rather than through
    // discovery: a mistake in a gate's filter cannot reach another tenant.
    expect(await findGatedEvent({ principal: staffA, eventWhere: { id: EVENT_B_ONLY_ID } }, { select: { id: true, name: true } })).toBeNull();
    expect(await findGatedEvent({ principal: keyA, eventWhere: {} }, { select: { organizationId: true } })).toEqual({ organizationId: ORG_A_ID });
  });

  it("leaves no lane behind: the next bare read is still outside one", async () => {
    await findGatedEvent({ principal: staffA, eventWhere: OWN }, { select: { id: true } });
    expect(await db.event.findMany({ select: { id: true } })).toHaveLength(0);
  });

  it("a reviewer, submitter or registrant is found through the privileged discovery, and reads the content inside the event's lane", async () => {
    // Step 6 (Nov 17, 2026): `resolveEventTenant`, the ONE read made before a
    // lane exists, is on the privileged client. Until then this found nothing.
    const linked = { organizationId: null, baseRole: "SUBMITTER", fromApiKey: false };
    expect(await findGatedEvent({ principal: linked, eventWhere: { id: EVENT_A_SHARED_ID } }, { select: { id: true } })).toEqual({ id: EVENT_A_SHARED_ID });
    const full = await findGatedEvent({ principal: linked, eventWhere: { id: EVENT_A_SHARED_ID } }, { select: { id: true, organizationId: true, name: true } });
    expect(full).toMatchObject({ id: EVENT_A_SHARED_ID, organizationId: ORG_A_ID });
    expect(typeof full?.name).toBe("string");
    // The account's own organisation is not its lane: an event of another organisation is found the same way.
    const attached = { organizationId: ORG_A_ID, baseRole: "REVIEWER", fromApiKey: false };
    expect(await findGatedEvent({ principal: attached, eventWhere: { id: EVENT_B_ONLY_ID } }, { select: { id: true, slug: true } })).toMatchObject({ id: EVENT_B_ONLY_ID });
  });

  it("the gate's filter still decides: a link that does not exist finds nothing, privileged client or not", async () => {
    const linked = { organizationId: null, baseRole: "REGISTRANT", fromApiKey: false };
    const where = { id: EVENT_A_SHARED_ID, registrations: { some: { userId: "nobody-is-linked-like-this" } } };
    expect(await findGatedEvent({ principal: linked, eventWhere: where }, { select: { id: true } })).toBeNull();
    expect(await findGatedEvent({ principal: linked, eventWhere: where }, { select: { id: true, name: true } })).toBeNull();
  });

  it("a team role or a key with NO organisation is not answered by the privileged read: it finds nothing", async () => {
    // Owner, Aug 11 2026 (PLATFORM_DECISIONS item 5). An operator's gate filter is the bare id.
    for (const principal of [
      { organizationId: null, baseRole: "SUPER_ADMIN", fromApiKey: false },
      { organizationId: null, baseRole: "ORGANIZER", fromApiKey: false },
      { organizationId: null, baseRole: null, fromApiKey: true },
    ]) {
      expect(await findGatedEvent({ principal, eventWhere: { id: EVENT_A_SHARED_ID } }, { select: { id: true } }), JSON.stringify(principal)).toBeNull();
      expect(await findGatedEvent({ principal, eventWhere: { id: EVENT_A_SHARED_ID } }, { select: { id: true, name: true } }), JSON.stringify(principal)).toBeNull();
    }
  });
});

describe("a public address under the Event policy (findPublicEvent, the public lists)", () => {
  const req = (host: string) => new Request(`https://${host}/e/${SHARED_SLUG}`, { headers: { host } });
  beforeAll(() => clearTenantResolverCache());

  it("each host finds its OWN organisation's event behind the slug both organisations use", async () => {
    const a = await findPublicEvent(req(HOST_A), SHARED_SLUG, {}, { select: { id: true, organizationId: true, name: true } });
    const b = await findPublicEvent(req(HOST_B), SHARED_SLUG, {}, { select: { id: true, organizationId: true, name: true } });
    expect(a).toMatchObject({ id: EVENT_A_SHARED_ID, organizationId: ORG_A_ID });
    expect(b).toMatchObject({ id: EVENT_B_SHARED_ID, organizationId: ORG_B_ID });
  });

  it("a host cannot reach another organisation's event, by slug or by id", async () => {
    expect(await findPublicEvent(req(HOST_A), ORG_B_ONLY_SLUG, {}, { select: { id: true } })).toBeNull();
    expect(await findPublicEvent(req(HOST_A), EVENT_B_ONLY_ID, { allowIdFallback: true }, { select: { id: true } })).toBeNull();
    expect(await resolvePublicEventOrg(req(HOST_A), ORG_B_ONLY_SLUG)).toBeNull();
    expect(await resolvePublicEventOrg(req(HOST_B), ORG_B_ONLY_SLUG)).toBe(ORG_B_ID);
  });

  it("a host that names no organisation has no lane, so with row security on it finds nothing", async () => {
    // A deployment that cannot say whose page this is. The platform refuses such a host outright.
    expect(await findPublicEvent(req("unknown.tenancy.test"), SHARED_SLUG, {}, { select: { id: true } })).toBeNull();
  });

  it("a public list reads the host's organisation's events and no other", async () => {
    const listed = await inHostLane(req(HOST_A), () => db.event.findMany({ select: { organizationId: true } }));
    expect(listed.length).toBeGreaterThan(0);
    expect(new Set(listed.map((e) => e.organizationId))).toEqual(new Set([ORG_A_ID]));
    // The catalogue's loaders are handed the scope; a refused host's is the sentinel, which is nobody's lane.
    expect(await inScopeLane({ organizationId: ORG_B_ID }, () => db.event.count())).toBeGreaterThan(1);
    expect(await inScopeLane({ organizationId: "__tenant_unresolved__" }, () => db.event.count())).toBe(0);
  });

  it("a list behind a gate: staff in their own lane whatever the host, a linked role in the host's", async () => {
    const count = () => db.event.count();
    expect(await inOwnLane({ principal: staffA }, req(HOST_B), count)).toBe(await runWithTenant(ORG_A_ID, count));
    const linked = { organizationId: null, baseRole: "REGISTRANT", fromApiKey: false };
    expect(await inOwnLane({ principal: linked }, req(HOST_B), count)).toBe(await runWithTenant(ORG_B_ID, count));
  });
});

describe("updateEventSettings under the Event policy (the settings merge is a tenant transaction)", () => {
  it("WHY: a raw row lock in a PLAIN transaction is told nothing about whose rows it may see", async () => {
    // A raw query is not a model operation, so the query extension never sets
    // the organisation for it. This is what the merge did before: no row.
    const rows = await runWithTenant(ORG_A_ID, () =>
      db.$transaction((tx) => tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Event" WHERE "id" = ${EVENT_A_SHARED_ID} FOR UPDATE`),
    );
    expect(rows).toHaveLength(0);
  });

  it("merges a key into the organisation's own event, keeps the others, and does not wait on its own lock", async () => {
    const started = Date.now();
    const merged = await runWithTenant(ORG_A_ID, () => updateEventSettings(EVENT_A_SHARED_ID, { laneProof: "first" }));
    expect(merged.laneProof).toBe("first");
    const again = await runWithTenant(ORG_A_ID, () => updateEventSettings(EVENT_A_SHARED_ID, (current) => ({ ...current, second: 2 })));
    expect(again).toMatchObject({ laneProof: "first", second: 2 });
    // The hazard the review described is a second backend waiting on the first's row lock until the 5 s timeout.
    expect(Date.now() - started).toBeLessThan(4000);
    const stored = await owner.event.findUnique({ where: { id: EVENT_A_SHARED_ID }, select: { settings: true } });
    expect(stored?.settings).toMatchObject({ ...(settingsBefore as object), laneProof: "first", second: 2 });
  });

  it("cannot write another tenant's event from this lane, with or without its organisation named", async () => {
    await expect(runWithTenant(ORG_A_ID, () => updateEventSettings(EVENT_B_ONLY_ID, { stolen: true }))).rejects.toThrow("EVENT_NOT_FOUND");
    await expect(runWithTenant(ORG_A_ID, () => updateEventSettings(EVENT_B_ONLY_ID, { stolen: true }, { organizationId: ORG_B_ID }))).rejects.toThrow("EVENT_NOT_FOUND");
    const untouched = await owner.event.findUnique({ where: { id: EVENT_B_ONLY_ID }, select: { settings: true } });
    expect(JSON.stringify(untouched?.settings ?? {})).not.toContain("stolen");
  });

  it("outside any lane it fails closed", async () => {
    await expect(updateEventSettings(EVENT_A_SHARED_ID, { orphan: true })).rejects.toThrow("EVENT_NOT_FOUND");
  });
});
