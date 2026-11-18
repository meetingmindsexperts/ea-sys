/**
 * Three things the alert changes of Nov 18, 2026 lean on, none of which a
 * behaviour test can see (review of 2b8a7b08).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isClientCall } from "@/lib/alert-bookkeeping";

const read = (file: string) => fs.readFileSync(path.resolve(__dirname, "../..", file), "utf8");

describe("the database client is never built inside the bookkeeping mark", () => {
  // Prisma's engine keeps the async context the client was BUILT in for its
  // own log lines. Built inside the marked scope, every engine error for the
  // life of the process would be taken for the alert system's bookkeeping and
  // would stop alerting. So claimAlertSend loads db.ts first.
  const source = read("src/lib/admin-alert.ts");
  const claim = source.slice(source.indexOf("export async function claimAlertSend"), source.indexOf("async function claimFromDatabase"));
  const marked = source.slice(source.indexOf("async function claimFromDatabase"), source.indexOf("export async function setAlertSilence"));

  it("claimAlertSend loads db.ts before it enters the mark", () => {
    const loadsDb = claim.indexOf('await import("./db")');
    const entersMark = claim.indexOf("inAlertBookkeeping(() =>");
    expect(loadsDb).toBeGreaterThan(-1);
    expect(entersMark).toBeGreaterThan(-1);
    expect(loadsDb).toBeLessThan(entersMark);
  });

  it("nothing is imported inside the marked work", () => {
    expect(marked.length).toBeGreaterThan(500);
    // (`typeof import("./db")` in its signature is a type, not a load.)
    expect(marked).not.toMatch(/await import\(/);
  });
});

describe("the mark is honoured for a client call only", () => {
  it.each(["alertState.findUnique", "$queryRaw", "$executeRaw", "event.findFirst"])("%s is a client call", (target) => {
    expect(isClientCall(target)).toBe(true);
  });

  it.each(["quaint::connector::metrics", "query_engine::server", "sql_query_connector::database::operations"])(
    "%s is an engine line, never downgraded by the mark",
    (target) => {
      expect(isClientCall(target)).toBe(false);
    },
  );

  it("an event with no target is not a client call: unknown keeps alerting", () => {
    expect(isClientCall(undefined)).toBe(false);
    expect(isClientCall("")).toBe(false);
  });

  it("the handler asks both questions", () => {
    expect(read("src/lib/db.ts")).toContain("(isAlertBookkeeping() && isClientCall(e.target))");
  });
});

describe("every image CI ships carries its commit", () => {
  // The safety half of "a local instance never emails alerts": an instance is
  // local only when its build has NO deployed commit. If an image stopped
  // carrying GIT_SHA, a production server whose address was ever set to
  // localhost would go quiet.
  it.each(["Dockerfile", "Dockerfile.worker"])("%s takes GIT_SHA as a build argument and keeps it in the environment", (file) => {
    const text = read(file);
    expect(text).toMatch(/^ARG GIT_SHA=/m);
    expect(text).toMatch(/^ENV GIT_SHA=\$GIT_SHA$/m);
  });

  it("the deploy workflow passes the commit to the build", () => {
    expect(read(".github/workflows/deploy.yml")).toMatch(/GIT_SHA=\$\{\{\s*github\.sha\s*\}\}/);
  });
});
