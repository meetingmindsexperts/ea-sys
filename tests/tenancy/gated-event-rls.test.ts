/**
 * Event RLS step 2 against the REAL pilot Event policy (Nov 16, 2026): the
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
import { findGatedEvent } from "@/lib/tenant/event-tenant";
import { updateEventSettings } from "@/lib/event-settings";
import { ORG_A_ID, ORG_B_ID, EVENT_A_SHARED_ID, EVENT_B_ONLY_ID, UPLOADER_A_ID } from "./constants";

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

  it("STEP 6 MARKER: a reviewer, submitter or registrant is not found until discovery moves to the privileged client", async () => {
    // Their event is found by `resolveEventTenant`, the ONE read made before a
    // lane exists. It reads through `db` today (Event has no policy in
    // production), so under the policy it finds nothing. When step 6 moves
    // that one read to the privileged client, this expectation flips to the
    // event: change it then, in the same commit.
    const linked = { organizationId: null, baseRole: "SUBMITTER", fromApiKey: false };
    const where = { id: EVENT_A_SHARED_ID, speakers: { some: { userId: UPLOADER_A_ID } } };
    expect(await findGatedEvent({ principal: linked, eventWhere: where }, { select: { id: true } })).toBeNull();
    expect(await findGatedEvent({ principal: linked, eventWhere: { id: EVENT_A_SHARED_ID } }, { select: { id: true, name: true } })).toBeNull();
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
