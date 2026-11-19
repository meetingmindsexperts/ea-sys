/**
 * The author's requested presentation type beside the organiser's decision
 * (owner, Nov 19, 2026: "we need it for records").
 */
import { describe, it, expect } from "vitest";
import { authorTypeWrite, editIsTheAuthors, editTypeWrite, organiserTypeWrite } from "@/lib/abstract-requested-type";

const author = { userId: "author-1" };

describe("authorTypeWrite", () => {
  it("the author's choice is the request and the type together", () => {
    expect(authorTypeWrite("POSTER")).toEqual({ presentationType: "POSTER", requestedPresentationType: "POSTER" });
    expect(authorTypeWrite(null)).toEqual({ presentationType: null, requestedPresentationType: null });
  });
});

describe("organiserTypeWrite", () => {
  it("the organiser's choice is the type only; the request is never named", () => {
    expect(organiserTypeWrite("POSTER", { presentationType: "ORAL", requestedPresentationType: "ORAL" })).toEqual({ presentationType: "POSTER" });
  });

  it("a row with no recorded request keeps the type it had as the request", () => {
    expect(organiserTypeWrite("POSTER", { presentationType: "ORAL", requestedPresentationType: null })).toEqual({
      presentationType: "POSTER",
      requestedPresentationType: "ORAL",
    });
  });

  it("nothing is invented when the author never chose a type", () => {
    expect(organiserTypeWrite("POSTER", { presentationType: null, requestedPresentationType: null })).toEqual({ presentationType: "POSTER" });
  });
});

describe("editIsTheAuthors and editTypeWrite", () => {
  it("a draft is the author's whoever edits it; after submission only the author's own account", () => {
    expect(editIsTheAuthors({ status: "DRAFT", speaker: author }, "staff-1")).toBe(true);
    expect(editIsTheAuthors({ status: "SUBMITTED", speaker: author }, "staff-1")).toBe(false);
    expect(editIsTheAuthors({ status: "SUBMITTED", speaker: author }, "author-1")).toBe(true);
    expect(editIsTheAuthors({ status: "SUBMITTED", speaker: { userId: null } }, "staff-1")).toBe(false);
    expect(editIsTheAuthors({ status: "SUBMITTED", speaker: null }, "staff-1")).toBe(false);
  });

  it("writes nothing when the edit names no type", () => {
    const row = { status: "SUBMITTED", speaker: author, presentationType: "ORAL" as const, requestedPresentationType: "ORAL" as const };
    expect(editTypeWrite(undefined, row, "staff-1")).toEqual({});
  });

  it("a staff edit of a submitted abstract keeps the request; the author's own draft edit moves both", () => {
    const submitted = { status: "SUBMITTED", speaker: author, presentationType: "ORAL" as const, requestedPresentationType: "ORAL" as const };
    expect(editTypeWrite("POSTER", submitted, "staff-1")).toEqual({ presentationType: "POSTER" });
    const draft = { ...submitted, status: "DRAFT" };
    expect(editTypeWrite("POSTER", draft, "author-1")).toEqual({ presentationType: "POSTER", requestedPresentationType: "POSTER" });
  });
});
