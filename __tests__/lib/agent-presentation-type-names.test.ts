/**
 * The assistant and the organisation's presentation types (Nov 24, 2026; step 5
 * of docs/ABSTRACT_PRESENTATION_TYPES_PLAN.md): a recommendation may be written
 * by its name, and every type the tools report carries its current name beside
 * its key (an own type's key keeps the name it was created with).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, submitReview, aggregates, strictTypes } = vi.hoisted(() => ({
  strictTypes: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    abstract: { findMany: vi.fn(), findFirst: vi.fn() },
  },
  submitReview: vi.fn(),
  aggregates: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/services/abstract-service", () => ({
  submitAbstractReview: submitReview,
  assignReviewer: vi.fn(),
  unassignReviewer: vi.fn(),
  changeAbstractStatus: vi.fn(),
}));
vi.mock("@/lib/abstract-review", async (orig) => ({
  ...(await orig<typeof import("@/lib/abstract-review")>()),
  computeSubmissionAggregates: aggregates,
}));
vi.mock("@/lib/abstract-presentation-types-server", async () => {
  const { readPresentationTypes } = await vi.importActual<typeof import("@/lib/abstract-presentation-types")>("@/lib/abstract-presentation-types");
  // SYMPOSIUM was renamed "Panel discussion" after it was made.
  const types = readPresentationTypes({
    presentationTypes: [
      { key: "CASE_REPORT", label: "Case report" },
      { key: "SYMPOSIUM", label: "Panel discussion" },
    ],
  });
  return { loadPresentationTypes: async () => types, loadPresentationTypesStrict: strictTypes.mockImplementation(async () => types) };
});

import { ABSTRACT_EXECUTORS } from "@/lib/agent/tools/abstracts";
import { EVENT_EXECUTORS } from "@/lib/agent/tools/events";

const ctx = { eventId: "ev1", organizationId: "org1", userId: "u1", source: "mcp" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  submitReview.mockResolvedValue({ ok: true, submission: { id: "s1" }, reviewer: { id: "r1", email: "r@example.com" } });
});

describe("a recommendation written by its name", () => {
  it("submit_abstract_review sends the key for a name in any case", async () => {
    await ABSTRACT_EXECUTORS.submit_abstract_review({ abstractId: "ab1", recommendedFormat: "case report" }, ctx);
    expect(submitReview).toHaveBeenCalledWith(expect.objectContaining({ recommendedFormat: "CASE_REPORT" }));
  });

  it("admin_submit_review_on_behalf reads a renamed type by its current name", async () => {
    await ABSTRACT_EXECUTORS.admin_submit_review_on_behalf({ abstractId: "ab1", reviewerUserId: "r1", recommendedFormat: "Panel discussion" }, ctx);
    expect(submitReview).toHaveBeenCalledWith(expect.objectContaining({ recommendedFormat: "SYMPOSIUM" }));
  });

  it("what matches nothing reaches the service as written, which refuses it with the choices", async () => {
    submitReview.mockResolvedValue({ ok: false, code: "INVALID_RECOMMENDED_FORMAT", message: "Choose one of: Oral (ORAL)" });
    const res = (await ABSTRACT_EXECUTORS.submit_abstract_review({ abstractId: "ab1", recommendedFormat: "Keynote" }, ctx)) as Record<string, unknown>;
    expect(submitReview).toHaveBeenCalledWith(expect.objectContaining({ recommendedFormat: "Keynote" }));
    expect(res).toMatchObject({ code: "INVALID_RECOMMENDED_FORMAT" });
  });

  it("the success reply names the type recorded (review of 33d5aa63f)", async () => {
    submitReview.mockResolvedValue({ ok: true, submission: { id: "s1", recommendedFormat: "SYMPOSIUM" } });
    const res = (await ABSTRACT_EXECUTORS.submit_abstract_review({ abstractId: "ab1", recommendedFormat: "Panel discussion" }, ctx)) as { submission: Record<string, unknown> };
    expect(res.submission).toMatchObject({ recommendedFormat: "SYMPOSIUM", recommendedFormatName: "Panel discussion" });
  });

  it("no recommendation, nothing resolved", async () => {
    await ABSTRACT_EXECUTORS.submit_abstract_review({ abstractId: "ab1", overallScore: 70 }, ctx);
    expect(submitReview.mock.calls[0][0]).not.toHaveProperty("recommendedFormat");
  });
});

describe("types reported by name beside the key", () => {
  it("list_abstracts names the decided and the requested type", async () => {
    mockDb.abstract.findMany.mockResolvedValue([
      { id: "ab1", presentationType: "SYMPOSIUM", requestedPresentationType: "ORAL_POSTER", submissions: [] },
      { id: "ab2", presentationType: null, requestedPresentationType: null, submissions: [] },
    ]);
    const res = (await ABSTRACT_EXECUTORS.list_abstracts({}, ctx)) as { abstracts: Array<Record<string, unknown>> };
    expect(res.abstracts[0]).toMatchObject({ presentationType: "SYMPOSIUM", presentationTypeName: "Panel discussion", requestedPresentationTypeName: "Oral or Poster" });
    expect(res.abstracts[1]).toMatchObject({ presentationTypeName: null, requestedPresentationTypeName: null });
  });

  it("get_abstract_scores names each recommendation", async () => {
    mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1", title: "T", status: "UNDER_REVIEW", event: { settings: {} }, reviewers: [] });
    aggregates.mockResolvedValue({
      submissions: [{ recommendedFormat: "SYMPOSIUM" }, { recommendedFormat: "NEITHER" }, { recommendedFormat: null }],
      aggregates: { scoredCount: 0 },
    });
    const res = (await ABSTRACT_EXECUTORS.get_abstract_scores({ abstractId: "ab1" }, ctx)) as { submissions: Array<Record<string, unknown>> };
    expect(res.submissions.map((s) => s.recommendedFormatName)).toEqual(["Panel discussion", "Neither", null]);
  });

  it("get_event_info lists what the event offers and what a reviewer may recommend, and never the settings", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", name: "Event", settings: { abstractPresentationTypes: ["ORAL_POSTER", "SYMPOSIUM"], secret: "x" } });
    const res = (await EVENT_EXECUTORS.list_event_info({}, ctx)) as Record<string, unknown>;
    expect(res).not.toHaveProperty("settings");
    expect(res.presentationTypes).toEqual([
      { key: "ORAL_POSTER", name: "Oral or Poster" },
      { key: "SYMPOSIUM", name: "Panel discussion" },
    ]);
    expect(res.recommendableFormats).toEqual([
      { key: "ORAL", name: "Oral" },
      { key: "POSTER", name: "Poster" },
      { key: "SYMPOSIUM", name: "Panel discussion" },
      { key: "NEITHER", name: "Neither" },
    ]);
  });

  it("get_event_info says the list could not be read, never the built-ins in its place", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", name: "Event", eventType: "CONFERENCE", settings: {} });
    strictTypes.mockRejectedValueOnce(new Error("db down"));
    const res = (await EVENT_EXECUTORS.list_event_info({}, ctx)) as Record<string, unknown>;
    expect(res).toMatchObject({ presentationTypes: null, recommendableFormats: null });
    expect(res.presentationTypesError).toBeTruthy();
  });

  it("get_event_info lists no types on a webinar, which takes no abstracts", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", name: "Webinar", eventType: "WEBINAR", settings: {} });
    const res = (await EVENT_EXECUTORS.list_event_info({}, ctx)) as Record<string, unknown>;
    expect(res).toMatchObject({ presentationTypes: [], recommendableFormats: [] });
  });
});
