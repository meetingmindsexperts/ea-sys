/**
 * `runWithTenantLane` — the fail-closed-but-legible tenant wrap.
 *
 * The property that matters is not what it does with an org. It is what it
 * does WITHOUT one: it must still fail closed (an empty lane resolves nothing
 * under RLS) and it must leave a trace, because otherwise a platform operator
 * meets a 404 with no way to tell "this row does not exist" from "you have no
 * lane to see it through".
 *
 * The other property is that it changes NOTHING on master. `RLS_SET_LOCAL` is
 * off there, so the callback runs either way and an org-null SUPER_ADMIN keeps
 * working exactly as before. If that ever stopped being true, this helper
 * would have silently broken 33 live routes, so it is asserted rather than
 * assumed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { warnCalls, runWithTenantSpy } = vi.hoisted(() => ({
  warnCalls: [] as Array<Record<string, unknown>>,
  runWithTenantSpy: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  apiLogger: {
    warn: (payload: Record<string, unknown>) => warnCalls.push(payload),
    info: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

// Record the org the lane was entered with, and still run the callback, which
// is what runWithTenant does with the flag off.
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (orgId: string, fn: () => unknown) => {
    runWithTenantSpy(orgId);
    return fn();
  },
}));

import { runWithTenantLane } from "@/lib/tenant-lane";

beforeEach(() => {
  warnCalls.length = 0;
  runWithTenantSpy.mockClear();
});

describe("with an org", () => {
  it("enters that org's lane and logs nothing", async () => {
    const out = await runWithTenantLane("org1", { route: "r" }, async () => "done");

    expect(out).toBe("done");
    expect(runWithTenantSpy).toHaveBeenCalledWith("org1");
    expect(warnCalls).toHaveLength(0);
  });
});

describe("without an org", () => {
  it.each([null, undefined, ""])("(%s) enters an EMPTY lane, which resolves nothing under RLS", async (orgId) => {
    await runWithTenantLane(orgId, { route: "r" }, async () => null);
    expect(runWithTenantSpy).toHaveBeenCalledWith("");
  });

  it("still runs the callback, so master behaviour is unchanged", async () => {
    const fn = vi.fn(async () => "ran");
    const out = await runWithTenantLane(null, { route: "r" }, fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(out).toBe("ran");
  });

  it("names the route and the caller, so a platform 404 is traceable", async () => {
    await runWithTenantLane(null, { route: "registrations:check-in", userId: "u9" }, async () => null);

    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toMatchObject({
      msg: "tenant:no-org-lane",
      route: "registrations:check-in",
      userId: "u9",
    });
  });

  it("records a null userId rather than omitting it (webhooks have no caller)", async () => {
    await runWithTenantLane(null, { route: "stripe-webhook-handler" }, async () => null);
    expect(warnCalls[0]).toMatchObject({ route: "stripe-webhook-handler", userId: null });
  });

  it("propagates the callback's rejection untouched", async () => {
    await expect(
      runWithTenantLane(null, { route: "r" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
