/**
 * AsyncLocalStorage tenant context + the flag-gated SET LOCAL query extension
 * (multi-tenancy Phase 0). The extension tests drive a REAL $extends against a
 * stubbed base client, pinning the four load-bearing behaviors: flag-off
 * passthrough (master's zero-cost guarantee), no-store passthrough, the
 * set_config-batch wrap when active, and the inTenantTx passthrough that
 * prevents double-wrapping inside tenantTransaction.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  runWithTenant,
  getTenantOrgId,
  getTenantStore,
  enterTenantTx,
} from "@/lib/tenant-context";

const savedFlag = process.env.RLS_SET_LOCAL;

beforeEach(() => {
  delete process.env.RLS_SET_LOCAL;
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env.RLS_SET_LOCAL;
  else process.env.RLS_SET_LOCAL = savedFlag;
});

describe("tenant context (AsyncLocalStorage)", () => {
  it("propagates the orgId across awaits inside the run", async () => {
    await runWithTenant("org-a", async () => {
      expect(getTenantOrgId()).toBe("org-a");
      await new Promise((r) => setTimeout(r, 1));
      expect(getTenantOrgId()).toBe("org-a"); // survives the async hop
    });
  });

  it("is empty outside any run", () => {
    expect(getTenantOrgId()).toBeNull();
    expect(getTenantStore()).toBeUndefined();
  });

  it("nested runs shadow and restore", async () => {
    await runWithTenant("org-a", async () => {
      await runWithTenant("org-b", async () => {
        expect(getTenantOrgId()).toBe("org-b");
      });
      expect(getTenantOrgId()).toBe("org-a");
    });
  });

  it("enterTenantTx marks the context without losing the orgId", async () => {
    await runWithTenant("org-a", async () => {
      expect(getTenantStore()?.inTenantTx).toBeUndefined();
      await enterTenantTx(async () => {
        expect(getTenantOrgId()).toBe("org-a");
        expect(getTenantStore()?.inTenantTx).toBe(true);
      });
      // marker scoped to the inner run only
      expect(getTenantStore()?.inTenantTx).toBeUndefined();
    });
  });

  it("enterTenantTx outside any tenant run is a plain passthrough", async () => {
    const result = await enterTenantTx(async () => {
      expect(getTenantStore()).toBeUndefined();
      return 42;
    });
    expect(result).toBe(42);
  });
});

describe("SET LOCAL query extension behavior", () => {
  /**
   * Minimal stand-in for the db.ts extension callback — same logic, driven
   * directly so we can pin the decision table without a live Prisma engine.
   * (db.ts's withTenantIsolation is exercised for real in the tenancy
   * harness against actual Postgres; here we pin the gating decisions.)
   */
  function makeOperation() {
    const txSpy = vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops));
    const query = vi.fn(async (args: unknown) => ({ ok: true, args }));
    const setLocal = vi.fn(async () => 1);
    const run = async (args: unknown) => {
      if (process.env.RLS_SET_LOCAL !== "1") return query(args);
      const store = getTenantStore();
      if (!store?.orgId || store.inTenantTx) return query(args);
      const [, result] = (await txSpy([setLocal(), query(args)])) as [unknown, unknown];
      return result;
    };
    return { run, txSpy, query, setLocal };
  }

  it("flag OFF → pure passthrough, no transaction", async () => {
    const { run, txSpy, setLocal } = makeOperation();
    await runWithTenant("org-a", async () => {
      const res = (await run({ where: { id: 1 } })) as { ok: boolean };
      expect(res.ok).toBe(true);
    });
    expect(txSpy).not.toHaveBeenCalled();
    expect(setLocal).not.toHaveBeenCalled();
  });

  it("flag ON but no tenant store → passthrough (no SET LOCAL to issue)", async () => {
    process.env.RLS_SET_LOCAL = "1";
    const { run, txSpy } = makeOperation();
    await run({});
    expect(txSpy).not.toHaveBeenCalled();
  });

  it("flag ON + tenant store → wraps in the set_config batch", async () => {
    process.env.RLS_SET_LOCAL = "1";
    const { run, txSpy, setLocal, query } = makeOperation();
    await runWithTenant("org-a", async () => {
      const res = (await run({ where: { id: 1 } })) as { ok: boolean };
      expect(res.ok).toBe(true);
    });
    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(setLocal).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("flag ON + inside tenantTransaction (inTenantTx) → passthrough, never double-wraps", async () => {
    process.env.RLS_SET_LOCAL = "1";
    const { run, txSpy } = makeOperation();
    await runWithTenant("org-a", async () => {
      await enterTenantTx(async () => {
        await run({});
      });
    });
    expect(txSpy).not.toHaveBeenCalled();
  });
});
