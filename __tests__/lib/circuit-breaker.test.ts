import { describe, it, expect } from "vitest";
import { CircuitBreaker, getBreaker, __resetAllBreakersForTest } from "@/lib/circuit-breaker";

// A fixed clock so tests never touch the real time (deterministic cooldowns).
function at(t: number) {
  return t;
}

describe("CircuitBreaker state machine", () => {
  it("stays CLOSED and lets calls through until the threshold of consecutive failures", () => {
    const b = new CircuitBreaker("t", { failureThreshold: 3, cooldownMs: 1000 });
    expect(b.getState()).toBe("closed");
    b.recordFailure(at(0));
    b.recordFailure(at(1));
    expect(b.getState()).toBe("closed"); // 2 < 3
    expect(b.canRequest(at(2))).toBe(true);
    b.recordFailure(at(2)); // 3rd → trip
    expect(b.getState()).toBe("open");
  });

  it("a SUCCESS resets the consecutive-failure count (bounces don't accumulate to a trip)", () => {
    const b = new CircuitBreaker("t", { failureThreshold: 3, cooldownMs: 1000 });
    b.recordFailure(at(0));
    b.recordFailure(at(1));
    b.recordSuccess(at(2)); // reset
    b.recordFailure(at(3));
    b.recordFailure(at(4));
    expect(b.getState()).toBe("closed"); // only 2 consecutive since the reset
  });

  it("OPEN short-circuits (canRequest=false) until the cooldown elapses", () => {
    const b = new CircuitBreaker("t", { failureThreshold: 1, cooldownMs: 1000 });
    b.recordFailure(at(0)); // trip
    expect(b.getState()).toBe("open");
    expect(b.canRequest(at(500))).toBe(false); // within cooldown
    expect(b.canRequest(at(999))).toBe(false);
  });

  it("transitions OPEN → HALF_OPEN after the cooldown and admits exactly ONE probe", () => {
    const b = new CircuitBreaker("t", { failureThreshold: 1, cooldownMs: 1000 });
    b.recordFailure(at(0));
    // cooldown elapsed → first caller becomes the probe
    expect(b.canRequest(at(1000))).toBe(true);
    expect(b.getState()).toBe("half_open");
    // concurrent callers during the in-flight probe are refused
    expect(b.canRequest(at(1000))).toBe(false);
    expect(b.canRequest(at(1001))).toBe(false);
  });

  it("HALF_OPEN probe SUCCESS closes the breaker", () => {
    const b = new CircuitBreaker("t", { failureThreshold: 1, cooldownMs: 1000 });
    b.recordFailure(at(0));
    b.canRequest(at(1000)); // claim probe
    b.recordSuccess(at(1001));
    expect(b.getState()).toBe("closed");
    expect(b.canRequest(at(1002))).toBe(true);
  });

  it("HALF_OPEN probe FAILURE re-opens and restarts the cooldown", () => {
    const b = new CircuitBreaker("t", { failureThreshold: 1, cooldownMs: 1000 });
    b.recordFailure(at(0));
    b.canRequest(at(1000)); // probe
    b.recordFailure(at(1000)); // probe failed → re-open at t=1000
    expect(b.getState()).toBe("open");
    expect(b.canRequest(at(1500))).toBe(false); // new cooldown from 1000
    expect(b.canRequest(at(2000))).toBe(true); // elapsed again
  });

  it("fires onTransition for every state change (and never lets a throwing callback break it)", () => {
    const seen: string[] = [];
    const b = new CircuitBreaker("mykey", {
      failureThreshold: 1,
      cooldownMs: 1000,
      onTransition: (from, to, key) => {
        seen.push(`${key}:${from}->${to}`);
        throw new Error("observer blew up"); // must be swallowed
      },
    });
    b.recordFailure(at(0)); // closed->open
    b.canRequest(at(1000)); // open->half_open
    b.recordSuccess(at(1001)); // half_open->closed
    expect(seen).toEqual([
      "mykey:closed->open",
      "mykey:open->half_open",
      "mykey:half_open->closed",
    ]);
  });

  it("simulated bulk outage: 25 concurrent callers past the trip all short-circuit, one probe recovers", () => {
    const b = new CircuitBreaker("email:bulk", { failureThreshold: 5, cooldownMs: 1000 });
    // 5 infra-faults trip it
    for (let i = 0; i < 5; i++) b.recordFailure(at(i));
    expect(b.getState()).toBe("open");
    // a batch of 25 concurrent sends all fail fast
    const admitted = Array.from({ length: 25 }, () => b.canRequest(at(100)));
    expect(admitted.every((x) => x === false)).toBe(true);
    // after cooldown, exactly one probe, and its success reopens the gate
    expect(b.canRequest(at(1100))).toBe(true);
    b.recordSuccess(at(1101));
    expect(b.getState()).toBe("closed");
  });
});

describe("getBreaker registry", () => {
  it("returns the SAME instance per key and INDEPENDENT instances across keys", () => {
    __resetAllBreakersForTest();
    const bulk1 = getBreaker("email:bulk", { failureThreshold: 1, cooldownMs: 1000 });
    const bulk2 = getBreaker("email:bulk");
    const txn = getBreaker("email:transactional", { failureThreshold: 1, cooldownMs: 1000 });
    expect(bulk1).toBe(bulk2); // same key → same breaker
    expect(bulk1).not.toBe(txn); // different key → independent

    // Tripping bulk must NOT affect transactional — the load-bearing property.
    bulk1.recordFailure(at(0));
    expect(bulk1.getState()).toBe("open");
    expect(txn.getState()).toBe("closed");
    expect(txn.canRequest(at(0))).toBe(true);
  });
});
