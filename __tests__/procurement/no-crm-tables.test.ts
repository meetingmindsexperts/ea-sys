/**
 * Procurement never reads a CRM table (CRM product review P1-7, Nov 6, 2026).
 * The CRM's revenue arrives through src/lib/contracts/crm-revenue.ts; a
 * `db.crmDeal` (or any CRM delegate) reappearing under src/procurement/ would
 * tie the budget to the CRM's tables again, which is what the contract undid.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("the Procurement boundary with the CRM", () => {
  it("no Procurement file uses a CRM Prisma delegate", () => {
    const root = path.join(__dirname, "../../src/procurement");
    const offenders = files(root).filter((f) => /\.(crm[A-Z]\w*)\.(find|count|aggregate|groupBy|create|update|upsert|delete)/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });
});
