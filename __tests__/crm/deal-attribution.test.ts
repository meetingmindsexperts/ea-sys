/**
 * What a deal is for, and which event it counts under (Nov 12, 2026): a deal
 * holds an event or a corporate project, never both and never neither; a
 * project linked to an event hands its deals to that event.
 */
import { describe, it, expect } from "vitest";
import { attributedEventId, dealsOfEventWhere, resolveDealTarget } from "@/crm/lib/deal-attribution";

describe("attributedEventId", () => {
  it("is the deal's own event", () => {
    expect(attributedEventId({ eventId: "e-1", project: null })).toBe("e-1");
  });

  it("is the linked event of the deal's project", () => {
    expect(attributedEventId({ eventId: null, project: { eventId: "e-2" } })).toBe("e-2");
  });

  it("is nothing for a project that is linked to no event", () => {
    expect(attributedEventId({ eventId: null, project: { eventId: null } })).toBeNull();
    expect(attributedEventId({ eventId: null })).toBeNull();
  });
});

describe("dealsOfEventWhere", () => {
  it("takes the event's own deals and those of a project linked to it", () => {
    expect(dealsOfEventWhere("e-1")).toEqual({ OR: [{ eventId: "e-1" }, { eventId: null, project: { eventId: "e-1" } }] });
  });
});

describe("resolveDealTarget", () => {
  it("a new deal needs an event or a project", () => {
    expect(resolveDealTarget({})).toMatchObject({ ok: false, code: "EVENT_REQUIRED" });
    expect(resolveDealTarget({ eventId: null, projectId: null })).toMatchObject({ ok: false, code: "EVENT_REQUIRED" });
    expect(resolveDealTarget({ eventId: "e-1" })).toEqual({ ok: true, eventId: "e-1", projectId: null });
    expect(resolveDealTarget({ projectId: "p-1" })).toEqual({ ok: true, eventId: null, projectId: "p-1" });
  });

  it("never both", () => {
    expect(resolveDealTarget({ eventId: "e-1", projectId: "p-1" })).toMatchObject({ ok: false, code: "EVENT_AND_PROJECT" });
  });

  it("naming one side on an edit moves the deal there and clears the other", () => {
    expect(resolveDealTarget({ projectId: "p-1" }, { eventId: "e-1", projectId: null })).toEqual({ ok: true, eventId: null, projectId: "p-1" });
    expect(resolveDealTarget({ eventId: "e-2" }, { eventId: null, projectId: "p-1" })).toEqual({ ok: true, eventId: "e-2", projectId: null });
    // The form sends the side it left as null: still a move, not a refusal.
    expect(resolveDealTarget({ projectId: "p-1", eventId: null }, { eventId: "e-1", projectId: null })).toEqual({ ok: true, eventId: null, projectId: "p-1" });
  });

  it("an edit that sends neither keeps what the deal has", () => {
    expect(resolveDealTarget({}, { eventId: "e-1", projectId: null })).toEqual({ ok: true, eventId: "e-1", projectId: null });
    expect(resolveDealTarget({}, { eventId: null, projectId: "p-1" })).toEqual({ ok: true, eventId: null, projectId: "p-1" });
  });

  it("an edit cannot leave a deal with neither", () => {
    expect(resolveDealTarget({ eventId: null }, { eventId: "e-1", projectId: null })).toMatchObject({ ok: false, code: "EVENT_REQUIRED" });
    expect(resolveDealTarget({ projectId: null }, { eventId: null, projectId: "p-1" })).toMatchObject({ ok: false, code: "EVENT_REQUIRED" });
    // A deal whose event was deleted must be given one of the two on its next edit of either.
    expect(resolveDealTarget({ eventId: null }, { eventId: null, projectId: null })).toMatchObject({ ok: false, code: "EVENT_REQUIRED" });
  });

  it("clearing the event of a deal that is on a project changes nothing", () => {
    expect(resolveDealTarget({ eventId: null }, { eventId: null, projectId: "p-1" })).toEqual({ ok: true, eventId: null, projectId: "p-1" });
  });
});
