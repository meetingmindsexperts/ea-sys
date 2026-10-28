/**
 * Adversarial test P1-4 (Oct 28, 2026), the route half: every procurement
 * write route takes its organisation from the session, never from the
 * request. The service half, that a foreign id is refused and changes
 * nothing, runs on a real Postgres in
 * tests/integration-db/procurement-cross-org.db.test.ts.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = "src/app/api/procurement";

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return routeFiles(p);
    return name === "route.ts" ? [p] : [];
  });
}

const writeRoutes = routeFiles(ROOT).filter((f) => /export async function (POST|PUT|PATCH|DELETE)\b/.test(readFileSync(f, "utf8")));

describe("procurement write routes take the organisation from the session", () => {
  it("finds the write routes", () => {
    expect(writeRoutes.length).toBeGreaterThan(30);
  });

  it.each(writeRoutes)("%s guards, runs in the session's tenant lane and passes the session's organisation", (file) => {
    const src = readFileSync(file, "utf8");
    expect(src).toContain("procurementGuard(");
    expect(src).toContain("runWithTenant(g.orgId");
    expect(src).toContain("organizationId: g.orgId");
    // An organisation read from the body, the query or the path would let a caller name someone else's.
    expect(src).not.toMatch(/organizationId:\s*(parsed|body|json|input|req|params|searchParams|url)\b/);
    expect(src).not.toMatch(/(parsed\.data|body)\.organizationId/);
  });
});
