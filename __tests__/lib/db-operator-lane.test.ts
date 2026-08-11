/**
 * The privileged maintenance lane (`dbOperator`): multi-tenancy item 5.
 *
 * Two properties are load-bearing and neither is visible by reading the code
 * at a call site:
 *
 *  1. ON MASTER IT IS THE SAME OBJECT AS `db`. `DATABASE_URL_OPERATOR` is unset
 *     here, so there must be exactly one client and one connection pool. If a
 *     future refactor makes this build a second client against the same URL,
 *     every deployment silently doubles its Postgres connection footprint,
 *     and this codebase has already had one P2024 pool-exhaustion incident.
 *
 *  2. IT MUST NOT CARRY `tenant-set-local`. That extension issues
 *     `SET LOCAL app.current_org`, which re-imposes the very tenant lane this
 *     client exists to step outside of. A client that silently acquired it
 *     would return ZERO rows for every cross-tenant scan on the platform,
 *     and zero rows is not an error, so `email-log-prune` would simply stop
 *     reaping while every dashboard stayed green. That is the exact failure
 *     shape of the advisory-lock bug (AGENTS.md rule 7), so it gets a test
 *     rather than a comment.
 *
 * It must still carry `audit-org-stamp`: a worker job writing an audit row
 * through this client has to stamp its org like any other writer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { constructorCalls, extensionNames } = vi.hoisted(() => ({
  constructorCalls: [] as Array<{ datasourceUrl?: string }>,
  extensionNames: [] as string[],
}));

vi.mock("@/lib/logger", () => ({
  dbLogger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
  apiLogger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
}));

// Each `$extends` returns a NEW object carrying the accumulated extension
// names, so the test can tell the two clients apart by identity AND inspect
// which extensions each one actually received.
vi.mock("@prisma/client", () => {
  class FakePrismaClient {
    __extensions: string[] = [];
    constructor(options?: { datasourceUrl?: string }) {
      constructorCalls.push({ datasourceUrl: options?.datasourceUrl });
    }
    $on() {}
    $extends(ext: { name?: string }) {
      if (ext?.name) extensionNames.push(ext.name);
      const next = Object.create(this) as FakePrismaClient;
      next.__extensions = [...this.__extensions, ext?.name ?? "anonymous"];
      return next;
    }
  }
  return { PrismaClient: FakePrismaClient, Prisma: {} };
});

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  constructorCalls.length = 0;
  extensionNames.length = 0;
  // db.ts caches both clients on globalThis in non-production (the HMR net).
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (globalThis as any).prisma = undefined;
  (globalThis as any).prismaOperator = undefined;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  vi.resetModules();
  process.env.DATABASE_URL = "postgres://app@localhost:5432/ea";
  delete process.env.DATABASE_URL_OPERATOR;
  delete process.env.RLS_SET_LOCAL;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("dbOperator on master (no separate owner connection)", () => {
  it("is the SAME object as db (one client, one pool)", async () => {
    const { db, dbOperator } = await import("@/lib/db");
    expect(dbOperator).toBe(db);
  });

  it("constructs exactly one PrismaClient", async () => {
    await import("@/lib/db");
    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0].datasourceUrl).toBe("postgres://app@localhost:5432/ea");
  });

  it("treats an operator URL identical to DATABASE_URL as no split", async () => {
    process.env.DATABASE_URL_OPERATOR = process.env.DATABASE_URL;
    const { db, dbOperator } = await import("@/lib/db");
    expect(dbOperator).toBe(db);
    expect(constructorCalls).toHaveLength(1);
  });
});

describe("dbOperator on the platform (distinct owner connection)", () => {
  beforeEach(() => {
    process.env.DATABASE_URL_OPERATOR = "postgres://owner@localhost:5432/ea";
  });

  it("is a DIFFERENT client, built from the operator URL", async () => {
    const { db, dbOperator } = await import("@/lib/db");
    expect(dbOperator).not.toBe(db);
    expect(constructorCalls).toHaveLength(2);
    expect(constructorCalls[1].datasourceUrl).toBe("postgres://owner@localhost:5432/ea");
  });

  it("does NOT carry tenant-set-local, but DOES carry audit-org-stamp", async () => {
    const { dbOperator } = await import("@/lib/db");
    const applied = (dbOperator as unknown as { __extensions: string[] }).__extensions;
    expect(applied).toContain("audit-org-stamp");
    expect(applied).not.toContain("tenant-set-local");
  });

  it("leaves the normal client's extensions untouched", async () => {
    const { db } = await import("@/lib/db");
    const applied = (db as unknown as { __extensions: string[] }).__extensions;
    expect(applied).toEqual(["tenant-set-local", "audit-org-stamp"]);
  });
});
