/**
 * The author's requested presentation type beside the organiser's decision
 * (owner, Nov 19, 2026: "we need it for records").
 */
import { describe, it, expect } from "vitest";
import { authorTypeWrite, editTypeWrite, organiserTypeWrite } from "@/lib/abstract-requested-type";

describe("authorTypeWrite", () => {
  it("the author's choice is the request and the type together", () => {
    expect(authorTypeWrite("POSTER")).toEqual({ presentationType: "POSTER", requestedPresentationType: "POSTER" });
    expect(authorTypeWrite(null)).toEqual({ presentationType: null, requestedPresentationType: null });
  });
});

describe("organiserTypeWrite", () => {
  it("the organiser's choice is the type only; the request is never named", () => {
    expect(organiserTypeWrite("POSTER")).toEqual({ presentationType: "POSTER" });
  });

  // Review of e9760ef1 (MED): a fallback that filled an empty request from the
  // current type recorded the organiser's FIRST choice as the author's on the second.
  it("two organiser choices in a row on an abstract the author never typed leave the request empty", () => {
    let row = { presentationType: null as string | null, requestedPresentationType: null as string | null };
    row = { ...row, ...organiserTypeWrite("ORAL") };
    row = { ...row, ...organiserTypeWrite("POSTER") };
    expect(row).toEqual({ presentationType: "POSTER", requestedPresentationType: null });
  });
});

describe("editTypeWrite", () => {
  const submitted = { status: "SUBMITTED", presentationType: "ORAL" as const };

  it("writes nothing when the edit names no type, or the type it already has", () => {
    expect(editTypeWrite(undefined, submitted)).toEqual({});
    // Review of e9760ef1 (MED): the edit page sends the type on every save.
    expect(editTypeWrite("ORAL", submitted)).toEqual({});
    expect(editTypeWrite("POSTER", { status: "DRAFT", presentationType: "POSTER" })).toEqual({});
  });

  it("a change to a draft is the author's choice; after submission it is the organiser's, whoever's account", () => {
    expect(editTypeWrite("POSTER", { status: "DRAFT", presentationType: "ORAL" })).toEqual({ presentationType: "POSTER", requestedPresentationType: "POSTER" });
    expect(editTypeWrite("POSTER", submitted)).toEqual({ presentationType: "POSTER" });
    expect(editTypeWrite("POSTER", { status: "REVISION_REQUESTED", presentationType: "ORAL" })).toEqual({ presentationType: "POSTER" });
  });
});
