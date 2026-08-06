/**
 * The shared public-credential guard (group review M7).
 *
 * What these pin is the SECURITY BEHAVIOUR, not the plumbing:
 *   - a flood never reaches bcrypt (the throttle is checked first),
 *   - a failed attempt is charged AND recorded, so a spray against a public
 *     door is visible in Sign-in Activity instead of invisible,
 *   - "known address, wrong password" stays distinguishable from "address
 *     matches nothing" — collapsing them would tell an admin nobody is under
 *     attack while somebody is,
 *   - a success clears the email bucket (two typos then a success leaves no
 *     trace) but NOT the IP bucket,
 *   - SUCCESS is only recorded when this pass IS the authentication event —
 *     the abstract-start door hands off to NextAuth signIn(), which records
 *     its own, and double-counting every sign-in would corrupt the one screen
 *     an admin reads.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { compareSpy, recordLoginEventSpy } = vi.hoisted(() => ({
  compareSpy: vi.fn(),
  recordLoginEventSpy: vi.fn(),
}));

vi.mock("bcryptjs", () => ({ default: { compare: (...a: unknown[]) => compareSpy(...a) } }));
vi.mock("@/lib/login-audit", () => ({
  recordLoginEvent: (...a: unknown[]) => recordLoginEventSpy(...a),
  readUserAgent: () => null,
}));
vi.mock("@/lib/logger", () => ({
  authLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { verifyPublicCredentials } from "@/lib/public-credential-door";
import {
  __resetLoginThrottleForTests,
  isLoginBlocked,
  EMAIL_FAILURE_LIMIT,
} from "@/lib/login-throttle";

const USER = { id: "u1", passwordHash: "hash", organizationId: "org1" };
const base = {
  email: "jane@example.com",
  password: "secret",
  ipAddress: "1.2.3.4",
  userAgent: "UA",
  surface: "EVENT_PAGE" as const,
  logLabel: "public/test-door",
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetLoginThrottleForTests();
  compareSpy.mockResolvedValue(true);
});

describe("verifyPublicCredentials — happy path", () => {
  it("returns the caller's own row on success (so `ok` implies an account)", async () => {
    const richUser = { ...USER, role: "SUBMITTER", firstName: "Jane" };
    const res = await verifyPublicCredentials({ ...base, user: richUser, recordSuccess: true });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.user.firstName).toBe("Jane");
  });

  it("records SUCCESS when the pass IS the authentication event", async () => {
    await verifyPublicCredentials({ ...base, user: USER, recordSuccess: true });
    expect(recordLoginEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "SUCCESS", userId: "u1", organizationId: "org1", surface: "EVENT_PAGE" }),
    );
  });

  it("records NOTHING on success when the client hands off to NextAuth signIn()", async () => {
    await verifyPublicCredentials({ ...base, user: USER, recordSuccess: false });
    expect(recordLoginEventSpy).not.toHaveBeenCalled();
  });
});

describe("verifyPublicCredentials — failures are charged and recorded", () => {
  it("wrong password on a KNOWN address → FAILED_PASSWORD, attributed to the user + org", async () => {
    compareSpy.mockResolvedValue(false);
    const res = await verifyPublicCredentials({ ...base, user: USER, recordSuccess: true });
    expect(res).toEqual({ ok: false, reason: "bad-credentials" });
    expect(recordLoginEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "FAILED_PASSWORD", userId: "u1", organizationId: "org1" }),
    );
  });

  it("an address matching NO account → FAILED_UNKNOWN_EMAIL with no user id (spray, not targeting)", async () => {
    const res = await verifyPublicCredentials({ ...base, user: null, recordSuccess: true });
    expect(res).toEqual({ ok: false, reason: "bad-credentials" });
    expect(recordLoginEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "FAILED_UNKNOWN_EMAIL", userId: null }),
    );
    // Never reaches bcrypt — there is no hash to compare against.
    expect(compareSpy).not.toHaveBeenCalled();
  });

  it("a known account with NO password hash counts as FAILED_PASSWORD (the address is real)", async () => {
    const res = await verifyPublicCredentials({
      ...base,
      user: { ...USER, passwordHash: null },
      recordSuccess: true,
    });
    expect(res).toEqual({ ok: false, reason: "bad-credentials" });
    expect(recordLoginEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "FAILED_PASSWORD", userId: "u1" }),
    );
  });

  it("charges the throttle so repeated failures eventually lock the address out", async () => {
    compareSpy.mockResolvedValue(false);
    for (let i = 0; i < EMAIL_FAILURE_LIMIT; i++) {
      await verifyPublicCredentials({ ...base, user: USER, recordSuccess: true });
    }
    expect(isLoginBlocked(base.email, base.ipAddress).blocked).toBe(true);
  });
});

describe("verifyPublicCredentials — the throttle runs BEFORE bcrypt", () => {
  it("a locked-out attempt is refused without ever hashing, and is recorded", async () => {
    compareSpy.mockResolvedValue(false);
    for (let i = 0; i < EMAIL_FAILURE_LIMIT; i++) {
      await verifyPublicCredentials({ ...base, user: USER, recordSuccess: true });
    }
    compareSpy.mockClear();
    recordLoginEventSpy.mockClear();

    const res = await verifyPublicCredentials({ ...base, user: USER, recordSuccess: true });
    expect(res.ok).toBe(false);
    if (!res.ok && res.reason === "throttled") {
      expect(res.retryAfterSeconds).toBeGreaterThan(0);
    } else {
      throw new Error("expected a throttled result");
    }
    // bcrypt is deliberately expensive — a flood must not reach it.
    expect(compareSpy).not.toHaveBeenCalled();
    expect(recordLoginEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "BLOCKED_RATE_LIMIT" }),
    );
  });
});

describe("verifyPublicCredentials — success clears the email bucket only", () => {
  it("typos followed by a correct password leave a clean slate", async () => {
    compareSpy.mockResolvedValue(false);
    await verifyPublicCredentials({ ...base, user: USER, recordSuccess: true });
    await verifyPublicCredentials({ ...base, user: USER, recordSuccess: true });

    compareSpy.mockResolvedValue(true);
    await verifyPublicCredentials({ ...base, user: USER, recordSuccess: true });

    // Eight more failures would trip the limit if the earlier two still counted.
    compareSpy.mockResolvedValue(false);
    for (let i = 0; i < EMAIL_FAILURE_LIMIT - 1; i++) {
      await verifyPublicCredentials({ ...base, user: USER, recordSuccess: true });
    }
    expect(isLoginBlocked(base.email, base.ipAddress).blocked).toBe(false);
  });
});
