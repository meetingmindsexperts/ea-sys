/**
 * bulkUpdateAbstracts (Nov 19, 2026): a status, a presentation type, or both,
 * on many abstracts. It adds no rule of its own: every status change is the
 * REAL changeAbstractStatus, so what one abstract's change refuses, the bulk
 * change skips and names.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, txUpdateMany, logger, aggregates, notify, refreshStats } = vi.hoisted(() => {
  const txUpdateMany = vi.fn();
  return {
    txUpdateMany,
    mockDb: {
      $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({ abstract: { updateMany: txUpdateMany } })),
      event: { findFirst: vi.fn() },
      abstract: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
      auditLog: { create: vi.fn() },
    },
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    aggregates: vi.fn(),
    notify: vi.fn(),
    refreshStats: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (cb: (tx: unknown) => unknown) => (mockDb.$transaction as (cb: (tx: unknown) => unknown) => unknown)(cb),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/abstract-review", () => ({
  computeSubmissionAggregates: aggregates,
  readRequiredReviewCount: () => 1,
  consolidateReviewNotes: () => "",
}));
vi.mock("@/lib/abstract-notifications", () => ({ notifyAbstractStatusChange: notify }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: refreshStats }));

import { bulkUpdateAbstracts, MAX_BULK_ABSTRACT_UPDATES } from "@/services/abstract-service";

type Row = { id: string; status: string; presentationType: string | null; requestedPresentationType?: string | null };
const EVENT = { id: "ev1", name: "MedCon", slug: "medcon", organizationId: "org1", settings: { abstractPresentationTypes: ["ORAL", "POSTER"] } };
const SPEAKER = { id: "sp1", email: "a@x.com", additionalEmail: null, firstName: "A", lastName: "B", title: null };
/** Scored reviews per abstract: the review-count rule needs one. */
const REVIEWS: Record<string, number> = { a1: 2, a2: 0, a3: 1 };
let rows: Row[];

const input = (over: Record<string, unknown> = {}) => ({
  eventId: "ev1", organizationId: "org1", userId: "u1", source: "rest" as const,
  abstractIds: ["a1", "a2", "a3"],
  ...over,
});
const claims = () => txUpdateMany.mock.calls.map(([args]) => ({ id: args.where.id, data: args.data }));

beforeEach(() => {
  vi.clearAllMocks();
  rows = [
    { id: "a1", status: "UNDER_REVIEW", presentationType: "ORAL", requestedPresentationType: "ORAL" },
    { id: "a2", status: "UNDER_REVIEW", presentationType: "ORAL", requestedPresentationType: "ORAL" },
    { id: "a3", status: "ACCEPTED", presentationType: "ORAL", requestedPresentationType: "ORAL" },
  ];
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.abstract.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => rows.filter((r) => where.id.in.includes(r.id)));
  mockDb.abstract.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const row = rows.find((r) => r.id === where.id);
    return row
      ? { id: row.id, title: `Title ${row.id}`, status: row.status, presentationType: row.presentationType, requestedPresentationType: row.requestedPresentationType ?? null, event: EVENT, speaker: SPEAKER }
      : null;
  });
  mockDb.abstract.updateMany.mockResolvedValue({ count: 1 });
  txUpdateMany.mockResolvedValue({ count: 1 });
  mockDb.auditLog.create.mockReturnValue(Promise.resolve({}));
  aggregates.mockImplementation(async (abstractId: string) => ({
    aggregates: { count: REVIEWS[abstractId] ?? 0, scoredCount: REVIEWS[abstractId] ?? 0, meanOverall: 80 },
    submissions: [],
  }));
  notify.mockResolvedValue("sent");
});

describe("bulkUpdateAbstracts: status", () => {
  it("changes what it can, skips what the single change refuses, and leaves alone what is already so", async () => {
    const result = await bulkUpdateAbstracts(input({ status: "ACCEPTED" }));
    expect(result).toMatchObject({
      ok: true,
      changed: ["a1"],
      unchanged: ["a3"],
      skipped: [{ abstractId: "a2", code: "INSUFFICIENT_REVIEWS" }],
      remaining: [],
    });
    expect(claims()).toEqual([{ id: "a1", data: expect.objectContaining({ status: "ACCEPTED" }) }]);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "abstract-bulk-update:some-skipped", skipped: [{ abstractId: "a2", code: "INSUFFICIENT_REVIEWS" }] }));
  });

  it("emails NO author unless asked, and says so on the audit row", async () => {
    await bulkUpdateAbstracts(input({ status: "ACCEPTED" }));
    expect(notify).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({ authorEmail: "not sent", after: { status: "ACCEPTED" } });
  });

  // Review of 9fd484fd (HIGH): the sender never throws, so "it did not throw"
  // was read as "sent" and a refused send was reported as emailed.
  it("with notifyAuthors, the report counts what the sender SAYS: a refused email, or an author with no address, is not 'emailed'", async () => {
    rows = [
      { id: "a1", status: "UNDER_REVIEW", presentationType: "ORAL" },
      { id: "a3", status: "UNDER_REVIEW", presentationType: "ORAL" },
      { id: "a4", status: "UNDER_REVIEW", presentationType: "ORAL" },
    ];
    REVIEWS.a4 = 1;
    notify.mockResolvedValueOnce("sent").mockResolvedValueOnce("failed").mockResolvedValueOnce("no-recipient");
    const result = await bulkUpdateAbstracts(input({ status: "ACCEPTED", notifyAuthors: true, abstractIds: ["a1", "a3", "a4"] }));
    delete REVIEWS.a4;
    // The status changed for all three; only one author was told.
    expect(result).toMatchObject({ ok: true, changed: ["a1", "a3", "a4"], emailed: 1, emailFailed: 2 });
    expect(notify).toHaveBeenCalledTimes(3);
  });

  // Review of 9fd484fd (MED): one throw used to answer 500 and lose the tally of everything before it.
  it("one abstract failing is skipped and named; the ones before and after it are still done and counted", async () => {
    txUpdateMany.mockResolvedValueOnce({ count: 1 }).mockRejectedValueOnce(new Error("db blip")).mockResolvedValueOnce({ count: 1 });
    const result = await bulkUpdateAbstracts(input({ status: "REJECTED", forceStatus: true }));
    expect(result).toMatchObject({ ok: true, changed: ["a1", "a3"] });
    expect(result.ok && result.skipped).toEqual([expect.objectContaining({ abstractId: "a2", code: "UNKNOWN" })]);
  });

  it("marks each status change as part of a bulk change, and refreshes the event's counts once", async () => {
    await bulkUpdateAbstracts(input({ status: "ACCEPTED", forceStatus: true }));
    expect(mockDb.auditLog.create.mock.calls.map(([a]) => a.data.changes.bulk)).toEqual([true, true]);
    expect(refreshStats).toHaveBeenCalledTimes(1);
  });

  it("the override decides an abstract short of reviews, as the single change's does", async () => {
    const result = await bulkUpdateAbstracts(input({ status: "ACCEPTED", forceStatus: true }));
    expect(result).toMatchObject({ ok: true, changed: ["a1", "a2"], skipped: [] });
    expect(mockDb.auditLog.create.mock.calls.map(([a]) => a.data.changes.source)).toEqual(["chair-override", "chair-override"]);
  });

  it("withdrawn is final, and an id from elsewhere is not found", async () => {
    rows = [{ id: "w1", status: "WITHDRAWN", presentationType: "ORAL" }];
    const result = await bulkUpdateAbstracts(input({ status: "REJECTED", forceStatus: true, abstractIds: ["w1", "other-event"] }));
    expect(result).toMatchObject({ ok: true, changed: [] });
    expect(result.ok && result.skipped.map((s) => [s.abstractId, s.code])).toEqual([
      ["w1", "ABSTRACT_WITHDRAWN"],
      ["other-event", "NOT_FOUND"],
    ]);
    expect(txUpdateMany).not.toHaveBeenCalled();
  });

  // It adds no rule of its own: what one abstract's change allows, this allows.
  it("a draft is whatever the single change makes of it, no second rule here", async () => {
    rows = [{ id: "d1", status: "DRAFT", presentationType: null }];
    const result = await bulkUpdateAbstracts(input({ status: "WITHDRAWN", abstractIds: ["d1"] }));
    expect(result).toMatchObject({ ok: true, changed: ["d1"], skipped: [] });
  });
});

describe("bulkUpdateAbstracts: presentation type", () => {
  it("a type alone is written event-scoped, audited, and never emails or touches the status", async () => {
    const result = await bulkUpdateAbstracts(input({ presentationType: "POSTER" }));
    expect(result).toMatchObject({ ok: true, changed: ["a1", "a2", "a3"], unchanged: [], emailed: 0 });
    expect(mockDb.abstract.updateMany).toHaveBeenCalledWith({ where: { id: "a1", eventId: "ev1" }, data: { presentationType: "POSTER" } });
    expect(txUpdateMany).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({ before: { presentationType: "ORAL" }, after: { presentationType: "POSTER" }, bulk: true });
  });

  it("an abstract that already has the type is left alone", async () => {
    expect(await bulkUpdateAbstracts(input({ presentationType: "ORAL" }))).toMatchObject({ ok: true, changed: [], unchanged: ["a1", "a2", "a3"] });
    expect(mockDb.abstract.updateMany).not.toHaveBeenCalled();
  });

  it("'accepted as poster' is ONE write: the type rides in the status claim, so a refused status leaves the type alone", async () => {
    const result = await bulkUpdateAbstracts(input({ status: "ACCEPTED", presentationType: "POSTER" }));
    expect(result).toMatchObject({ ok: true, changed: ["a1", "a3"], skipped: [{ abstractId: "a2", code: "INSUFFICIENT_REVIEWS" }] });
    // a1: status and type together. a2: refused, nothing written. a3: already accepted, the type alone.
    expect(claims()).toEqual([{ id: "a1", data: expect.objectContaining({ status: "ACCEPTED", presentationType: "POSTER" }) }]);
    expect(mockDb.abstract.updateMany.mock.calls.map(([a]) => a.where.id)).toEqual(["a3"]);
  });

  // Nov 19, 2026 (owner: "we need it for records"): the author's choice is kept.
  it("the organiser's type never overwrites what the author asked for, alone or with a status", async () => {
    await bulkUpdateAbstracts(input({ status: "ACCEPTED", presentationType: "POSTER" }));
    // a1 through the status claim, a3 by the type alone: neither names the request.
    expect(claims()[0].data).not.toHaveProperty("requestedPresentationType");
    expect(mockDb.abstract.updateMany.mock.calls[0][0].data).toEqual({ presentationType: "POSTER" });
    // And the status change's history keeps the type it replaced.
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({
      before: { status: "UNDER_REVIEW", presentationType: "ORAL" },
      after: { status: "ACCEPTED", presentationType: "POSTER" },
    });
  });

  it("refuses a type the event does not offer, before touching anything", async () => {
    expect(await bulkUpdateAbstracts(input({ presentationType: "VIDEO" }))).toMatchObject({ ok: false, code: "TYPE_NOT_OFFERED" });
    expect(mockDb.abstract.findMany).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "abstract-bulk-update:rejected", code: "TYPE_NOT_OFFERED" }));
  });
});

describe("bulkUpdateAbstracts: limits", () => {
  it("refuses nothing to do, too many, and an event of another organisation", async () => {
    expect(await bulkUpdateAbstracts(input({}))).toMatchObject({ ok: false, code: "NOTHING_TO_CHANGE" });
    expect(await bulkUpdateAbstracts(input({ status: "ACCEPTED", abstractIds: [] }))).toMatchObject({ ok: false, code: "NOTHING_TO_CHANGE" });
    const tooMany = Array.from({ length: MAX_BULK_ABSTRACT_UPDATES + 1 }, (_, i) => `x${i}`);
    expect(await bulkUpdateAbstracts(input({ status: "ACCEPTED", abstractIds: tooMany }))).toMatchObject({ ok: false, code: "TOO_MANY" });

    mockDb.event.findFirst.mockResolvedValueOnce(null);
    expect(await bulkUpdateAbstracts(input({ status: "ACCEPTED" }))).toMatchObject({ ok: false, code: "EVENT_NOT_FOUND" });
    expect(mockDb.event.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: "ev1", organizationId: "org1" } }));
  });

  it("out of time, it stops and answers what it did not reach; the first is always attempted", async () => {
    const result = await bulkUpdateAbstracts(input({ presentationType: "POSTER", budgetMs: 0 }));
    expect(result).toMatchObject({ ok: true, changed: ["a1"], remaining: ["a2", "a3"] });
  });

  it("an id named twice is done once", async () => {
    const result = await bulkUpdateAbstracts(input({ presentationType: "POSTER", abstractIds: ["a1", "a1"] }));
    expect(result).toMatchObject({ ok: true, changed: ["a1"] });
    expect(mockDb.abstract.updateMany).toHaveBeenCalledTimes(1);
  });

  it("never throws: a database error is an UNKNOWN refusal, logged", async () => {
    mockDb.abstract.findMany.mockRejectedValueOnce(new Error("db down"));
    expect(await bulkUpdateAbstracts(input({ status: "ACCEPTED" }))).toMatchObject({ ok: false, code: "UNKNOWN" });
    expect(logger.error).toHaveBeenCalled();
  });
});
