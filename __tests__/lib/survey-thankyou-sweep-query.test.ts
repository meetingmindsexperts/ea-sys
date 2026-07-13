/**
 * runSurveyThankYouSweep — the CANDIDATE QUERY (review H3).
 *
 * The sweep used to fetch `take: 100` ordered `surveyCompletedAt: desc` and then
 * filter out already-thanked rows IN MEMORY. Once more than 100 completions
 * existed in the 24h window, the batch was permanently the newest 100 — all
 * already thanked after the first pass — so every subsequent tick did zero work
 * while the OLDER, un-thanked registrations sat below the slice, were never
 * fetched again, and aged out of the window unprocessed.
 *
 * On a conference with 400 completions, roughly 300 people silently never
 * received their thank-you — which is the email that carries their certificate.
 *
 * The existing suite only covered the pure `decideThankYouDelivery` decision;
 * the query that actually starved people had no test at all. This is that test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    registration: { findMany: vi.fn() },
    emailLog: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { runSurveyThankYouSweep } from "@/lib/certificates/survey-thankyou-sweep";

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.registration.findMany.mockResolvedValue([]); // no work to do; we assert the QUERY
});

describe("H3 — the sweep must not starve older completions", () => {
  it("excludes already-thanked registrations IN THE QUERY (not after `take`)", async () => {
    mockDb.emailLog.findMany.mockResolvedValue([{ entityId: "reg1" }, { entityId: "reg2" }]);

    await runSurveyThankYouSweep();

    const where = mockDb.registration.findMany.mock.calls[0][0].where;
    // If the exclusion happens after `take`, the batch fills with rows that need
    // no work and the queue never drains. It must be part of the WHERE.
    expect(where.id).toEqual({ notIn: ["reg1", "reg2"] });
  });

  it("drains OLDEST-first so nobody starves", async () => {
    mockDb.emailLog.findMany.mockResolvedValue([]);

    await runSurveyThankYouSweep();

    const orderBy = mockDb.registration.findMany.mock.calls[0][0].orderBy;
    expect(orderBy).toEqual({ surveyCompletedAt: "asc" }); // was "desc"
  });

  it("applies no notIn when nobody has been thanked yet", async () => {
    mockDb.emailLog.findMany.mockResolvedValue([]);

    await runSurveyThankYouSweep();

    const where = mockDb.registration.findMany.mock.calls[0][0].where;
    expect(where.id).toBeUndefined(); // don't emit `notIn: []`
    expect(where.surveyCompletedAt).toMatchObject({ not: null });
  });

  it("every fetched candidate still needs work, so `take` is never wasted", async () => {
    // 150 completions, the first 100 already thanked. The old code fetched the
    // newest 100 (all thanked) and did nothing, forever. The new query excludes
    // them, so `take` is spent entirely on the 50 that still need thanking.
    const thanked = Array.from({ length: 100 }, (_, i) => ({ entityId: `reg${i}` }));
    mockDb.emailLog.findMany.mockResolvedValue(thanked);

    await runSurveyThankYouSweep();

    const where = mockDb.registration.findMany.mock.calls[0][0].where;
    expect(where.id.notIn).toHaveLength(100);
    expect(mockDb.registration.findMany.mock.calls[0][0].take).toBe(100);
  });
});
