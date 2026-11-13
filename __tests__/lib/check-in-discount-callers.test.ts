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
const NAMES = "(checkInGate|isPaymentAdmissible|isComplimentaryRegistration)";
const ANY_CALL = new RegExp(`\\b${NAMES}\\(`, "g");
/** A call whose first argument is written out as an object, up to its closing brace. */
const LITERAL_CALL = new RegExp(`\\b${NAMES}\\(\\s*\\{[^}]*\\}`, "g");
/** The row's own discount, not `undefined` or a constant. */
const PASSES_DISCOUNT = /\bdiscountAmount:\s*\w+\.discountAmount\b/;

/** Comments name these functions too (`checkInGate()` in a route's header). */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("the door's payment rule is always given the discount", () => {
  it("the list is every file that calls it", () => {
    const found = execSync(`grep -rlE '\\b${NAMES}\\(' src worker --include=*.ts --include=*.tsx || true`, { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      // The rule's own file defines them and calls one from the other with the whole input.
      .filter((file) => file !== "src/lib/check-in.ts")
      // A file that only names one in a comment is not a caller.
      .filter((file) => (code(readFileSync(join(ROOT, file), "utf8")).match(ANY_CALL) ?? []).length > 0)
      .sort();
    expect(found).toEqual([...CALLERS].sort());
  });

  for (const file of CALLERS) {
    it(`${file}: every call writes its input out and passes the row's discountAmount`, () => {
      const source = code(readFileSync(join(ROOT, file), "utf8"));
      const calls = source.match(ANY_CALL) ?? [];
      const literal = source.match(LITERAL_CALL) ?? [];
      expect(calls.length, "no call found: the pattern no longer matches this file").toBeGreaterThan(0);
      // A call handed a variable (`checkInGate(input)`) cannot be read here, so it is refused
      // (review of 5fc01136: one such call could drop the discount while another kept the file green).
      expect(literal.length, "a call does not write its input out as an object").toBe(calls.length);
      for (const call of literal) expect(call, call).toMatch(PASSES_DISCOUNT);
    });
  }
});
