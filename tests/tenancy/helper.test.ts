/**
 * publicEventWhere against REAL data — the where-shape half of isolation,
 * deliberately queried as the OWNER role (bypasses the pilot RLS) so these
 * assertions isolate the org-bind in the WHERE itself from the RLS layer
 * (rls.test.ts owns that). Both tenants hold an event on SHARED_SLUG — the
 * per-org-unique collision this whole cut exists for.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { clearTenantResolverCache } from "@/lib/tenant/resolver";
import { publicEventWhereForHost } from "@/lib/public-event";
import {
  HOST_A,
  HOST_B,
  SHARED_SLUG,
  ORG_B_ONLY_SLUG,
  EVENT_A_SHARED_ID,
  EVENT_B_SHARED_ID,
} from "./constants";

let owner: PrismaClient;

beforeAll(() => {
  owner = new PrismaClient({ datasourceUrl: process.env.TENANCY_DIRECT_URL });
});
afterAll(async () => {
  await owner.$disconnect();
});
beforeEach(() => {
  clearTenantResolverCache();
  delete process.env.DEFAULT_ORG_ID;
  delete process.env.TENANCY_ENFORCE_HOST;
});

describe("host-scoped where over the shared slug", () => {
  it("host A finds org A's event; host B finds org B's — same slug, different rows", async () => {
    const a = await owner.event.findFirst({
      where: await publicEventWhereForHost(HOST_A, SHARED_SLUG),
      select: { id: true },
    });
    const b = await owner.event.findFirst({
      where: await publicEventWhereForHost(HOST_B, SHARED_SLUG),
      select: { id: true },
    });
    expect(a?.id).toBe(EVENT_A_SHARED_ID);
    expect(b?.id).toBe(EVENT_B_SHARED_ID);
    expect(a?.id).not.toBe(b?.id);
  });

  it("host A + org B's unique slug → miss (cross-tenant read impossible via the builder)", async () => {
    const hit = await owner.event.findFirst({
      where: await publicEventWhereForHost(HOST_A, ORG_B_ONLY_SLUG),
      select: { id: true },
    });
    expect(hit).toBeNull();
  });

  it("UNSCOPED resolution on the shared slug is genuinely ambiguous (the latent bug, demonstrated)", async () => {
    const hit = await owner.event.findFirst({
      where: await publicEventWhereForHost("stranger.tenancy.test", SHARED_SLUG),
      select: { id: true },
    });
    // findFirst returns whichever row it likes — the point is BOTH are
    // possible, which is exactly why unscoped mode is only acceptable on a
    // single-tenant deployment.
    expect([EVENT_A_SHARED_ID, EVENT_B_SHARED_ID]).toContain(hit?.id);
  });
});
