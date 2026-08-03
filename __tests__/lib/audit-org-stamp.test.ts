/**
 * Domain #19 — resolveAuditOrganizationId, the resolution core of the
 * withAuditOrgStamp client extension (src/lib/db.ts).
 *
 * The happy paths (ambient lane, eventId 1-hop, explicit-wins) are ALSO
 * proven end-to-end against real Postgres — through the extension chain, the
 * pgbouncer transaction pooler, and the RLS policy — in
 * tests/tenancy/auditlog-rls.test.ts. What this file pins is the ORDER and
 * the failure semantics the harness can't reach:
 *   - explicit beats ambient beats lookup, and empty-string values fall
 *     through instead of stamping "" (the legacy `?? ""` wrap class),
 *   - a lookup failure degrades to an unstamped row and NEVER throws (a
 *     stamping blip must not become a lost audit write),
 *   - non-string / absent eventId skips the lookup entirely.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runWithTenant } from "@/lib/tenant-context";
import { resolveAuditOrganizationId } from "@/lib/db";

vi.mock("@/lib/logger", () => ({
  dbLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { dbLogger } from "@/lib/logger";

type FakeBase = { event: { findUnique: ReturnType<typeof vi.fn> } };

function fakeBase(findUnique = vi.fn()): FakeBase {
  return { event: { findUnique } };
}

// The function's `base` param is typed against the real client factory; the
// only surface it touches is event.findUnique.
const asBase = (b: FakeBase) => b as unknown as Parameters<typeof resolveAuditOrganizationId>[1];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveAuditOrganizationId", () => {
  it("explicit organizationId in the data wins — no ambient read, no lookup", async () => {
    const base = fakeBase();
    const org = await runWithTenant("ambient-org", () =>
      resolveAuditOrganizationId({ organizationId: "explicit-org", eventId: "evt-1" }, asBase(base)),
    );
    expect(org).toBe("explicit-org");
    expect(base.event.findUnique).not.toHaveBeenCalled();
  });

  it("empty-string explicit falls through to the ambient lane (never stamps \"\")", async () => {
    const org = await runWithTenant("ambient-org", () =>
      resolveAuditOrganizationId({ organizationId: "" }, asBase(fakeBase())),
    );
    expect(org).toBe("ambient-org");
  });

  it("ambient lane beats the eventId lookup (no query when a store is present)", async () => {
    const base = fakeBase();
    const org = await runWithTenant("ambient-org", () =>
      resolveAuditOrganizationId({ eventId: "evt-1" }, asBase(base)),
    );
    expect(org).toBe("ambient-org");
    expect(base.event.findUnique).not.toHaveBeenCalled();
  });

  it("an empty-string ambient store (the legacy `?? \"\"` wrap class) is skipped, not stamped", async () => {
    const base = fakeBase(vi.fn().mockResolvedValue({ organizationId: "event-org" }));
    const org = await runWithTenant("", () =>
      resolveAuditOrganizationId({ eventId: "evt-1" }, asBase(base)),
    );
    expect(org).toBe("event-org");
  });

  it("no ambient store → eventId 1-hop lookup resolves the event's org", async () => {
    const findUnique = vi.fn().mockResolvedValue({ organizationId: "event-org" });
    const org = await resolveAuditOrganizationId({ eventId: "evt-1" }, asBase(fakeBase(findUnique)));
    expect(org).toBe("event-org");
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "evt-1" },
      select: { organizationId: true },
    });
  });

  it("event not found → null (deleted-event orphans stay honestly unattributed)", async () => {
    const org = await resolveAuditOrganizationId(
      { eventId: "evt-gone" },
      asBase(fakeBase(vi.fn().mockResolvedValue(null))),
    );
    expect(org).toBeNull();
  });

  it("lookup failure NEVER throws — degrades to null and warn-logs", async () => {
    const org = await resolveAuditOrganizationId(
      { eventId: "evt-1" },
      asBase(fakeBase(vi.fn().mockRejectedValue(new Error("pooler blip")))),
    );
    expect(org).toBeNull();
    expect(dbLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringContaining("event-lookup-failed") }),
    );
  });

  it("absent or non-string eventId skips the lookup and resolves null", async () => {
    const base = fakeBase();
    expect(await resolveAuditOrganizationId({}, asBase(base))).toBeNull();
    expect(await resolveAuditOrganizationId({ eventId: 42 }, asBase(base))).toBeNull();
    expect(base.event.findUnique).not.toHaveBeenCalled();
  });
});
