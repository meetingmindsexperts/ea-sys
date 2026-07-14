/**
 * Tests for the cross-process admin-alert claim.
 *
 * The behaviour that matters here is not "does it dedupe" — the old in-memory
 * Map did that. It is:
 *
 *   1. the claim is made in POSTGRES, so blue + green + worker share one dedup
 *      state instead of three (which is why one error could page you 3x);
 *   2. suppressed occurrences are COUNTED, so the email can say "this fired 240
 *      times" — the number the old pipeline never had;
 *   3. a global hourly ceiling exists, and blowing it sends exactly one digest
 *      rather than going quietly dark;
 *   4. when the DATABASE IS DOWN, alerting degrades to noisy rather than to
 *      silent. A DB outage is when errors storm; if the dedup claim needs the DB
 *      then the alert pipeline dies exactly when you need it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const findUnique = vi.fn();
const queryRaw = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    alertState: {
      findUnique: (...a: unknown[]) => findUnique(...a),
    },
    $queryRaw: (...a: unknown[]) => queryRaw(...a),
  },
}));

/** Import fresh each time so the module-level in-memory fallback map is clean. */
async function loadModule() {
  vi.resetModules();
  return import("@/lib/admin-alert");
}

/**
 * The claim makes up to three $queryRaw calls in order:
 *   1. record occurrence → [{ counter }]
 *   2. claim hourly slot → [] (lost) or [{ key }] (won)
 *   3. spend global budget → [{ counter }]
 */
function mockClaimSequence(opts: {
  occurrences: number;
  wonSlot: boolean;
  budgetSpent?: number;
}) {
  queryRaw
    .mockResolvedValueOnce([{ counter: opts.occurrences }])
    .mockResolvedValueOnce(opts.wonSlot ? [{ key: "k" }] : [])
    .mockResolvedValueOnce([{ counter: opts.budgetSpent ?? 1 }]);
}

describe("claimAlertSend", () => {
  beforeEach(() => {
    // mockReset, NOT clearAllMocks: clearAllMocks leaves the mockResolvedValueOnce
    // QUEUE intact, so a test that consumes fewer values than it queued (any test
    // where the hourly claim is lost, and so the budget call never happens) leaks
    // its leftover into the next test and silently shifts every response by one.
    queryRaw.mockReset();
    findUnique.mockReset();
    findUnique.mockResolvedValue(null); // not silenced
    delete process.env.ALERTS_SILENCED_UNTIL;
  });

  afterEach(() => {
    delete process.env.ALERTS_SILENCED_UNTIL;
  });

  it("sends on the first occurrence of a fingerprint", async () => {
    const { claimAlertSend } = await loadModule();
    mockClaimSequence({ occurrences: 1, wonSlot: true });

    const claim = await claimAlertSend("logger:api:boom");

    expect(claim.send).toBe(true);
    expect(claim.suppressed).toBe(0);
    expect(claim.ceilingDigest).toBeUndefined();
  });

  it("suppresses a repeat within the window and reports how many were swallowed", async () => {
    const { claimAlertSend } = await loadModule();
    // 241 occurrences recorded, and the conditional UPDATE matched no row →
    // another container already alerted on this fingerprint this hour.
    mockClaimSequence({ occurrences: 241, wonSlot: false });

    const claim = await claimAlertSend("logger:api:boom");

    expect(claim.send).toBe(false);
    // 240 suppressed since the last email — this is the number that tells an
    // operator "this is a storm", not "this happened once".
    expect(claim.suppressed).toBe(240);
  });

  it("carries the suppressed count into the next send after the window rolls", async () => {
    const { claimAlertSend } = await loadModule();
    mockClaimSequence({ occurrences: 500, wonSlot: true });

    const claim = await claimAlertSend("logger:api:boom");

    expect(claim.send).toBe(true);
    expect(claim.suppressed).toBe(499);
  });

  it("sends exactly ONE digest when the global hourly budget is exhausted", async () => {
    const { claimAlertSend } = await loadModule();
    // ALERT_HOURLY_CEILING defaults to 30, so the 31st spend is the digest.
    mockClaimSequence({ occurrences: 1, wonSlot: true, budgetSpent: 31 });

    const claim = await claimAlertSend("logger:api:something-else");

    expect(claim.send).toBe(true);
    expect(claim.ceilingDigest).toBe(true);
  });

  it("goes quiet once the digest has already been sent", async () => {
    const { claimAlertSend } = await loadModule();
    mockClaimSequence({ occurrences: 1, wonSlot: true, budgetSpent: 32 });

    const claim = await claimAlertSend("logger:api:yet-another");

    expect(claim.send).toBe(false);
    expect(claim.ceilingDigest).toBeUndefined();
  });

  it("suppresses everything while an operator silence window is open", async () => {
    const { claimAlertSend } = await loadModule();
    findUnique.mockResolvedValue({
      key: "__silence__",
      silencedUntil: new Date(Date.now() + 60 * 60_000),
    });

    const claim = await claimAlertSend("logger:api:boom");

    expect(claim.send).toBe(false);
    // Silenced means silenced — we don't even record the occurrence.
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("resumes alerting once the silence window has expired", async () => {
    const { claimAlertSend } = await loadModule();
    findUnique.mockResolvedValue({
      key: "__silence__",
      silencedUntil: new Date(Date.now() - 1000), // expired a second ago
    });
    mockClaimSequence({ occurrences: 1, wonSlot: true });

    const claim = await claimAlertSend("logger:api:boom");

    expect(claim.send).toBe(true);
  });

  it("honours the ALERTS_SILENCED_UNTIL break-glass env var", async () => {
    const { claimAlertSend } = await loadModule();
    process.env.ALERTS_SILENCED_UNTIL = new Date(Date.now() + 3_600_000).toISOString();

    const claim = await claimAlertSend("logger:api:boom");

    expect(claim.send).toBe(false);
    expect(findUnique).not.toHaveBeenCalled();
  });

  // ── The one that matters most ──────────────────────────────────────────────
  it("still alerts when the DATABASE IS DOWN (degrades noisy, not silent)", async () => {
    const { claimAlertSend } = await loadModule();
    findUnique.mockRejectedValue(new Error("Can't reach database server"));

    const first = await claimAlertSend("logger:database:P1001");
    expect(first.send).toBe(true);

    // ...and the in-memory fallback still dedupes the repeat, so a DB outage
    // doesn't turn into thousands of emails either.
    const second = await claimAlertSend("logger:database:P1001");
    expect(second.send).toBe(false);
  });

  it("falls back per-fingerprint, so a DB outage doesn't mask unrelated errors", async () => {
    const { claimAlertSend } = await loadModule();
    findUnique.mockRejectedValue(new Error("Can't reach database server"));

    expect((await claimAlertSend("logger:database:P1001")).send).toBe(true);
    expect((await claimAlertSend("logger:api:unrelated-thing")).send).toBe(true);
  });
});
