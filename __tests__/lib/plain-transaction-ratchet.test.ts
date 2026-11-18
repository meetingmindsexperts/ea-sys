/**
 * A plain interactive transaction is not a tenant transaction (the sweep of
 * Nov 18, 2026).
 *
 * What `db.$transaction(async (tx) => ...)` does under row security, measured
 * on the tenancy harness as the non-owner role:
 *   - with NO tenant lane, nothing inside it names a tenant: every policied
 *     read returns nothing and every policied write is refused, and a refused
 *     statement aborts the whole transaction;
 *   - INSIDE a lane, each model call is run on its own with the tenant named,
 *     OUTSIDE the transaction (a write followed by a throw was not rolled
 *     back), and a raw query still names no tenant.
 * Either way it is not what its author meant. `tenantTransaction`
 * (src/lib/db.ts) is: it names the lane's tenant on the transaction's own
 * connection, so the statements see their rows and stand or fall together.
 * Two were dangerous: the sponsor tier save (called with no lane) counted
 * "sponsors holding this tier" as 0 and removed a tier in use, and the
 * recording of a DTCM reversal was not one transaction.
 *
 * So a new one fails this test. The ones listed are the sign-in and account
 * doors, which run with no lane; they are not safe, they are KNOWN (see each
 * reason). The batch form, `$transaction([a, b])`, is a different thing and is
 * not counted.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
/** Any receiver (`db`, `prisma`, `client`, `dbOperator`), any callback (an arrow, a function, a variable), a type argument or not: everything but the batch form, which opens with `[`. */
const PLAIN = /\b\w+\s*\.\s*\$transaction\s*(?:<[^>(]*>)?\s*\(\s*(?!\[)/g;

/** file -> how many plain interactive transactions it holds, and why they are left. */
const KNOWN: Record<string, { count: number; why: string }> = {
  "src/lib/db.ts": { count: 1, why: "tenantTransaction itself" },
  "src/app/api/auth/register/route.ts": { count: 1, why: "creates the organisation and its first user: neither table has a policy" },
  "src/app/api/auth/verify-email/route.ts": { count: 1, why: "User and VerificationToken only: neither has a policy" },
  "src/app/api/auth/accept-invitation/route.ts": {
    count: 1,
    why: "User and VerificationToken, plus an audit row. AuditLog HAS a policy: under row security that write is refused and takes the transaction with it (ROADMAP, Row security rehearsal, item 25)",
  },
  "src/app/api/auth/forgot-password/route.ts": { count: 1, why: "as accept-invitation: an audit row inside the transaction (item 25)" },
  "src/app/api/auth/reset-password/route.ts": { count: 1, why: "as accept-invitation: an audit row inside the transaction (item 25)" },
  "src/app/api/organization/users/route.ts": {
    count: 3,
    why: "User and VerificationToken; two of the three (inviting, and creating a user) also write an audit row inside the transaction (item 25)",
  },
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("plain interactive transactions", () => {
  const found: Record<string, number> = {};
  for (const file of [...sourceFiles(path.join(ROOT, "src")), ...sourceFiles(path.join(ROOT, "worker"))]) {
    const text = fs.readFileSync(file, "utf8").replace(/^\s*(\/\/|\*).*$/gm, "");
    const count = (text.match(PLAIN) ?? []).length;
    if (count > 0) found[path.relative(ROOT, file)] = count;
  }

  it("the scan sees the ones that exist (or every assertion below is empty)", () => {
    expect(found["src/lib/db.ts"]).toBe(1);
  });

  it("there are none outside the known list: use tenantTransaction", () => {
    const unknown = Object.keys(found).filter((file) => !(file in KNOWN));
    expect(unknown).toEqual([]);
  });

  it("the known list is exact: a file that gained one, or lost its last, changes this list", () => {
    expect(found).toEqual(Object.fromEntries(Object.entries(KNOWN).map(([file, { count }]) => [file, count])));
  });
});
