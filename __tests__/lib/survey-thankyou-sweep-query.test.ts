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

const { mockDb, mockDbOperator } = vi.hoisted(() => ({
  mockDb: {},
  // Both sweep reads are privileged, and they must stay on the SAME client:
  // a succeeding candidate read with a fail-closed dedup read re-thanks, and
  // re-attaches certificates for, everyone in the window.
  mockDbOperator: {
    registration: { findMany: vi.fn() },
    emailLog: { findMany: vi.fn() },
  },
}));

// `dbOperator` is a DISTINCT fake here, not an alias of `db`. Binding both to
// one object is fine for master parity but makes the assertion meaningless:
// reverting `dbOperator.x` to `db.x` would still pass. The scan below is the
// one statement that MUST be privileged, and on the platform a revert makes
// it return zero rows forever without erroring, so the test distinguishes them.
// Both the dedup read AND the candidate read must ride it, together.
vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: mockDbOperator }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { runSurveyThankYouSweep } from "@/lib/certificates/survey-thankyou-sweep";

const MARKER_AT = new Date("2026-09-17T12:00:00Z");
const ANSWERED_BEFORE = new Date("2026-09-17T11:50:00Z");

/** Thank-you markers (SENT rows) for these registrations, written after they answered. */
function markers(ids: string[]) {
  return ids.map((entityId) => ({ entityId, createdAt: MARKER_AT }));
}

/** The candidate query is the registration read that orders by completion. */
function candidateQuery() {
  const call = mockDbOperator.registration.findMany.mock.calls.find((c) => c[0].orderBy);
  return call![0];
}

beforeEach(() => {
  vi.clearAllMocks();
  // Completion lookup for marked ids: answered before the marker. Candidate
  // query: no work to do; we assert the QUERY.
  mockDbOperator.registration.findMany.mockImplementation(async (args: { where: { id?: { in?: string[] } } }) =>
    args.where.id?.in ? args.where.id.in.map((id) => ({ id, surveyCompletedAt: ANSWERED_BEFORE })) : [],
  );
});

describe("H3 — the sweep must not starve older completions", () => {
  it("excludes already-thanked registrations IN THE QUERY (not after `take`)", async () => {
    mockDbOperator.emailLog.findMany.mockResolvedValue(markers(["reg1", "reg2"]));

    await runSurveyThankYouSweep();

    const where = candidateQuery().where;
    // If the exclusion happens after `take`, the batch fills with rows that need
    // no work and the queue never drains. It must be part of the WHERE.
    expect(where.id).toEqual({ notIn: ["reg1", "reg2"] });
  });

  // Sep 17, 2026 (OOPVF2026): a thank-you refused for a template variable the
  // sender cannot fill failed again on every 3-minute tick for 24 hours. That
  // refusal now counts as done; any other failure is still retried.
  it("treats a missing-variable refusal as done, and retries every other failure", async () => {
    mockDbOperator.emailLog.findMany.mockResolvedValue([]);

    await runSurveyThankYouSweep();

    const where = mockDbOperator.emailLog.findMany.mock.calls[0][0].where;
    expect(where.status).toBeUndefined();
    expect(where.OR).toEqual([
      { status: "SENT" },
      { status: "FAILED", errorMessage: { startsWith: "unresolved_tokens" } },
    ]);
  });

  it("drains OLDEST-first so nobody starves", async () => {
    mockDbOperator.emailLog.findMany.mockResolvedValue([]);

    await runSurveyThankYouSweep();

    const orderBy = candidateQuery().orderBy;
    expect(orderBy).toEqual({ surveyCompletedAt: "asc" }); // was "desc"
  });

  it("applies no notIn when nobody has been thanked yet", async () => {
    mockDbOperator.emailLog.findMany.mockResolvedValue([]);

    await runSurveyThankYouSweep();

    const where = candidateQuery().where;
    expect(where.id).toBeUndefined(); // don't emit `notIn: []`
    expect(where.surveyCompletedAt).toMatchObject({ not: null });
  });

  it("every fetched candidate still needs work, so `take` is never wasted", async () => {
    // 150 completions, the first 100 already thanked. The old code fetched the
    // newest 100 (all thanked) and did nothing, forever. The new query excludes
    // them, so `take` is spent entirely on the 50 that still need thanking.
    const thanked = markers(Array.from({ length: 100 }, (_, i) => `reg${i}`));
    mockDbOperator.emailLog.findMany.mockResolvedValue(thanked);

    await runSurveyThankYouSweep();

    const where = candidateQuery().where;
    expect(where.id.notIn).toHaveLength(100);
    expect(candidateQuery().take).toBe(100);
  });

  // Sep 17, 2026: an organizer reset the survey and the person answered again,
  // so their completion is newer than the thank-you marker from the first
  // answer. They are owed a new thank-you (it carries any new certificate).
  it("does not treat a thank-you from before a reset as covering the new answer", async () => {
    mockDbOperator.emailLog.findMany.mockResolvedValue(markers(["reset-reg", "kept-reg"]));
    mockDbOperator.registration.findMany.mockImplementation(async (args: { where: { id?: { in?: string[] } } }) =>
      args.where.id?.in
        ? [
            { id: "reset-reg", surveyCompletedAt: new Date("2026-09-17T12:30:00Z") },
            { id: "kept-reg", surveyCompletedAt: ANSWERED_BEFORE },
          ]
        : [],
    );

    await runSurveyThankYouSweep();

    expect(candidateQuery().where.id).toEqual({ notIn: ["kept-reg"] });
  });
});
