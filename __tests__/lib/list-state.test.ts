import { describe, it, expect } from "vitest";
import { listStateOf } from "@/lib/list-state";

/**
 * A card's 0 has to mean "none". These are the other things an absent list
 * used to read as (Nov 23, 2026): still loading, failed, not allowed.
 */
const q = (over: Partial<{ data: unknown; isError: boolean; error: unknown }> = {}) => ({ data: undefined, isError: false, error: null, ...over });
const httpError = (status: number) => Object.assign(new Error("refused"), { status });

describe("listStateOf", () => {
  it("a list in hand is ready, an empty one included", () => {
    expect(listStateOf(q({ data: [] }))).toBe("ready");
    expect(listStateOf(q({ data: [{ id: "1" }] }))).toBe("ready");
  });

  it("no data and no error is loading: fetching, waiting for a connection, or not asked for yet", () => {
    expect(listStateOf(q())).toBe("loading");
    expect(listStateOf(q(), "loading")).toBe("loading");
    expect(listStateOf(q(), "allowed")).toBe("loading");
  });

  it("a list that failed to load is failed, never an empty list", () => {
    expect(listStateOf(q({ isError: true, error: httpError(500) }))).toBe("failed");
    expect(listStateOf(q({ isError: true, error: new Error("network") }))).toBe("failed");
    expect(listStateOf(q({ isError: true, error: httpError(404) }))).toBe("failed");
  });

  it("a 403 is 'not allowed', which is not a failure to retry", () => {
    expect(listStateOf(q({ isError: true, error: httpError(403) }))).toBe("denied");
  });

  it("a list the page never asks for, because the person may not read it, is denied", () => {
    // The reviewers list: the query is off, so it is neither loading nor failed.
    expect(listStateOf(q(), "denied")).toBe("denied");
  });

  it("what was loaded stays on screen when a later refresh fails", () => {
    expect(listStateOf(q({ data: [{ id: "1" }], isError: true, error: httpError(500) }))).toBe("ready");
  });
});
