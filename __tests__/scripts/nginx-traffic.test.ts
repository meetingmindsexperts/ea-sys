/**
 * CI wrapper for scripts/nginx-traffic.test.sh.
 *
 * The log parser and the archive merge are shell and awk, so without this they
 * would sit outside every gate we run. An ops script that only executes on the
 * box is exactly the kind that rots unnoticed.
 *
 * The properties it protects, in order of what a break would cost: a log line
 * that cannot be split reliably must be REJECTED rather than parsed into
 * plausible rubbish (found by feeding it a crafted path, which produced a junk
 * referrer on the card); an attacker-controlled request path must never break
 * the generated JSON; and the archive merge must not double count, lose
 * pre-window history, or let a stale bucket beat a fresh parse.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { join } from "path";

describe("nginx traffic parser + snapshot merge", () => {
  it("passes every case in scripts/nginx-traffic.test.sh", () => {
    const script = join(process.cwd(), "scripts/nginx-traffic.test.sh");
    let out = "";
    let failed = false;
    try {
      out = execFileSync("bash", [script], { encoding: "utf8", timeout: 60_000 });
    } catch (err) {
      failed = true;
      out = String((err as { stdout?: string }).stdout ?? err);
    }
    expect(out, out).toContain("FAIL=0");
    expect(failed, out).toBe(false);
  });
});
