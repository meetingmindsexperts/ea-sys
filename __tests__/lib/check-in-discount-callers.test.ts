/**
 * Every caller of the door's payment rule hands it the registration's discount
 * (Nov 13, 2026). `discountAmount` is optional on `checkInGate` and
 * `isPaymentAdmissible`, because leaving it out only refuses more; but a caller
 * that leaves it out disagrees with the others about a registration whose code
 * takes the whole fee: the desk admits and the badge route prints nothing, or
 * the agent refuses whom the door lets in. That drift is what the shared rule
 * exists to prevent (check-in.ts, review H1), so the callers are listed here
 * and a new one fails until it passes the discount and is added.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CALLERS = [
  "src/app/api/events/[eventId]/registrations/[registrationId]/check-in/route.ts",
  "src/app/api/events/[eventId]/registrations/badges/route.ts",
  "src/app/api/events/[eventId]/registrations/walk-in/route.ts",
  "src/lib/agent/tools/registrations.ts",
];
const CALL = /\b(checkInGate|isPaymentAdmissible)\(\s*\{[^}]*\}/g;

describe("the door's payment rule is always given the discount", () => {
  it("the list is every file that calls it", () => {
    const found = execSync("grep -rlE '\\b(checkInGate|isPaymentAdmissible)\\(' src worker --include=*.ts --include=*.tsx || true", { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      // The rule's own file defines them and calls one from the other with the whole input.
      .filter((file) => file !== "src/lib/check-in.ts")
      .sort();
    expect(found).toEqual([...CALLERS].sort());
  });

  for (const file of CALLERS) {
    it(`${file} passes discountAmount on every call`, () => {
      const source = readFileSync(join(ROOT, file), "utf8");
      const calls = source.match(CALL) ?? [];
      expect(calls.length, "no call found: the pattern no longer matches this file").toBeGreaterThan(0);
      for (const call of calls) expect(call, call).toContain("discountAmount:");
    });
  }
});
