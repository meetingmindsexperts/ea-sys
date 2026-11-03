/**
 * Seat counters move only in src/lib/registration-seat-db.ts (dependency
 * audit, Nov 3, 2026).
 *
 * Five creation paths (the completion form, the CSV and EventsAir imports,
 * import-contacts and the agent's bulk create) claimed a ticket-type seat with
 * their own `updateMany({ soldCount: { lt: quantity } })`, against a quantity
 * read earlier in the request, while every other path called claimSeat. They
 * agreed with it only until the seat rules changed: the Sep 8, 2026 type
 * ceiling had to be added to each copy by hand. They now call claimSeat /
 * claimSeats, and a new inline claim or release fails here.
 *
 * Fix a failure by calling claimSeat(s) / releaseSeat(s) (or adding the
 * operation to registration-seat-db.ts), never by an exemption.
 *
 * What the scan sees, with a probe for each: a Prisma `soldCount: { increment
 * | decrement }`, a capacity guard `soldCount: { lt | lte }`, and raw SQL
 * `"soldCount" + / -`. Comments are stripped first, so the many comments
 * describing the claims do not count.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const WRITER = path.join("src", "lib", "registration-seat-db.ts");

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "Prisma increment/decrement", re: /\bsoldCount\s*:\s*\{\s*(?:increment|decrement)\b/ },
  { name: "capacity guard", re: /\bsoldCount\s*:\s*\{\s*(?:lt|lte)\s*:/ },
  { name: "raw SQL arithmetic", re: /"soldCount"\s*[+-]/ },
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function offences(source: string): string[] {
  const code = stripComments(source);
  return PATTERNS.filter((p) => p.re.test(code)).map((p) => p.name);
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

describe("the scan", () => {
  it("catches each form of an inline seat write", () => {
    expect(offences(`tx.ticketType.updateMany({ data: { soldCount: { increment: 1 } } })`)).toEqual(["Prisma increment/decrement"]);
    expect(offences(`db.pricingTier.update({ data: { soldCount: {\n decrement: n } } })`)).toEqual(["Prisma increment/decrement"]);
    expect(offences(`where: { id, soldCount: { lt: type.quantity } }`)).toEqual(["capacity guard"]);
    expect(offences('tx.$executeRaw`UPDATE "TicketType" SET "soldCount" = "soldCount" + ${n}`')).toEqual(["raw SQL arithmetic"]);
  });

  it("ignores comments and reads", () => {
    expect(offences(`// soldCount: { increment: 1 }\n/* "soldCount" + 1 */\nselect: { soldCount: true }`)).toEqual([]);
  });
});

describe("src/ and worker/", () => {
  it("move seat counters only through registration-seat-db.ts", () => {
    const files = [...sourceFiles(path.join(ROOT, "src")), ...sourceFiles(path.join(ROOT, "worker"))];
    const hits = files
      .filter((f) => path.relative(ROOT, f) !== WRITER)
      .flatMap((f) => offences(readFileSync(f, "utf8")).map((name) => `${path.relative(ROOT, f)}: ${name}`));
    expect(hits).toEqual([]);
    // The writer itself still matches, so the patterns have not gone stale.
    expect(offences(readFileSync(path.join(ROOT, WRITER), "utf8")).length).toBeGreaterThan(0);
  });
});
