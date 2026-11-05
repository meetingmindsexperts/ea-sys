/**
 * The Event lane shadow detector (src/lib/tenant/lane-shadow.ts).
 *
 * Its whole value is an accurate inventory, so the properties pinned here are
 * the ones that would make the inventory lie: reporting when it should be off,
 * reporting laned queries (noise that buries the real gaps), reporting the
 * sanctioned discovery read, repeating a call site, or growing without bound.
 * And the one property that matters for a live system: it never throws.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { info, warn } = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));

vi.mock("@/lib/logger", () => ({
  dbLogger: { info, warn, error: vi.fn(), debug: vi.fn() },
}));

import {
  asEventDiscovery,
  noteUnlanedEventQuery,
  resetLaneShadowForTests,
  SHADOW_MAX_SITES,
} from "@/lib/tenant/lane-shadow";
import { runWithTenant } from "@/lib/tenant-context";

const ORIGINAL = process.env.RLS_SHADOW;

function reported() {
  return info.mock.calls.filter(([o]) => o?.msg === "tenant:event-query-no-lane");
}

beforeEach(() => {
  info.mockClear();
  warn.mockClear();
  resetLaneShadowForTests();
  process.env.RLS_SHADOW = "1";
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.RLS_SHADOW;
  else process.env.RLS_SHADOW = ORIGINAL;
});

describe("noteUnlanedEventQuery", () => {
  it("is silent unless RLS_SHADOW=1", () => {
    delete process.env.RLS_SHADOW;
    noteUnlanedEventQuery("Event", "findFirst");
    process.env.RLS_SHADOW = "true";
    noteUnlanedEventQuery("Event", "findFirst");
    expect(info).not.toHaveBeenCalled();
  });

  it("reports an Event query with no lane", () => {
    noteUnlanedEventQuery("Event", "findFirst");
    const calls = reported();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ operation: "findFirst" });
    expect(typeof calls[0][0].callsite).toBe("string");
  });

  it("ignores every other model", () => {
    noteUnlanedEventQuery("Registration", "findMany");
    noteUnlanedEventQuery(undefined, "$queryRaw");
    expect(info).not.toHaveBeenCalled();
  });

  it("ignores an Event query inside a tenant lane", async () => {
    await runWithTenant("org_1", async () => {
      noteUnlanedEventQuery("Event", "findFirst");
    });
    expect(info).not.toHaveBeenCalled();
  });

  it("treats the empty-string lane as no lane, as the policy does", async () => {
    // runWithTenant("") matches no row under RLS; it must not hide a gap here.
    await runWithTenant("", async () => {
      noteUnlanedEventQuery("Event", "findFirst");
    });
    expect(reported()).toHaveLength(1);
  });

  it("does not report the sanctioned discovery read", async () => {
    await asEventDiscovery(async () => {
      noteUnlanedEventQuery("Event", "findFirst");
    });
    expect(info).not.toHaveBeenCalled();
    // ...and the marker does not leak past its scope.
    noteUnlanedEventQuery("Event", "findFirst");
    expect(reported()).toHaveLength(1);
  });

  it("returns the discovery read's result", async () => {
    await expect(asEventDiscovery(async () => ({ id: "ev_1" }))).resolves.toEqual({ id: "ev_1" });
  });

  it("restores the process stack depth after capturing", () => {
    const before = Error.stackTraceLimit;
    noteUnlanedEventQuery("Event", "findFirst");
    expect(Error.stackTraceLimit).toBe(before);
  });

  it("reports each call site once", () => {
    const site = () => noteUnlanedEventQuery("Event", "findMany");
    site();
    site();
    site();
    expect(reported()).toHaveLength(1);
  });

  it("keeps operations at one call site apart", () => {
    const at = (op: string) => noteUnlanedEventQuery("Event", op);
    at("findFirst");
    at("count");
    expect(reported().map(([o]) => o.operation).sort()).toEqual(["count", "findFirst"]);
  });

  it("stops at the site cap and says so once", () => {
    for (let i = 0; i < SHADOW_MAX_SITES + 5; i++) noteUnlanedEventQuery("Event", `op${i}`);
    expect(reported()).toHaveLength(SHADOW_MAX_SITES);
    expect(info.mock.calls.filter(([o]) => o?.msg === "tenant:event-shadow-capped")).toHaveLength(1);
  });

  it("never throws, even when the logger does", () => {
    info.mockImplementationOnce(() => {
      throw new Error("logger down");
    });
    warn.mockImplementationOnce(() => {
      throw new Error("logger still down");
    });
    expect(() => noteUnlanedEventQuery("Event", "findFirst")).not.toThrow();
  });

  it("warns once on a persistent fault, then goes quiet", () => {
    info.mockImplementation(() => {
      throw new Error("logger down");
    });
    for (let i = 0; i < 5; i++) noteUnlanedEventQuery("Event", `op${i}`);
    expect(warn).toHaveBeenCalledTimes(1);
    info.mockReset();
  });

  it("keeps one state per process, shared across module copies", async () => {
    // The dev-server case: db's extension holds the first graph's copy while a
    // second graph's event-tenant.ts marks discovery. Both must see one store.
    vi.resetModules();
    const second = await import("@/lib/tenant/lane-shadow");
    await second.asEventDiscovery(async () => {
      noteUnlanedEventQuery("Event", "findFirst");
    });
    expect(reported()).toHaveLength(0);
  });
});
