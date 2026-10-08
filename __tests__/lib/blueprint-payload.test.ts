/** Structure checks and the server-owned fields of a saved blueprint (blueprint-payload.ts). */
import { describe, it, expect } from "vitest";
import {
  MAX_BLUEPRINT_BYTES,
  mergeForPage,
  parseBlueprintPayload,
  parseTemplatePayload,
} from "@/lib/blueprint/blueprint-payload";

const ID = "bp_mg9x2k1abcde";

describe("parseBlueprintPayload", () => {
  it("keeps the page's data and drops every server-owned and listing field", () => {
    const res = parseBlueprintPayload(
      {
        id: ID,
        v: 2,
        basics: { title: "  Heart Summit  " },
        type: "conference",
        status: "live",
        ref: "EB-FAKE",
        statusLog: [{ status: "live", at: 1 }],
        submissions: [{}],
        approvals: { plan: 1, preview: 1 },
        ownerId: "someone-else",
        title: "ignored",
        readiness: 87.6,
        blocking: 2,
        pendingChanges: 1,
      },
      ID,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.title).toBe("Heart Summit");
    expect(res.type).toBe("conference");
    expect(res.readiness).toBe(88);
    for (const k of ["status", "ref", "statusLog", "submissions", "approvals", "ownerId", "title", "readiness", "blocking", "pendingChanges"]) {
      expect(res.data).not.toHaveProperty(k);
    }
    expect(res.data).toMatchObject({ id: ID, v: 2, basics: { title: "  Heart Summit  " } });
  });

  it.each([
    ["an array", [1, 2], "NOT_AN_OBJECT"],
    ["another blueprint's id", { id: "bp_other1234" }, "ID_MISMATCH"],
    ["more than 256 KB", { notes: "x".repeat(MAX_BLUEPRINT_BYTES) }, "TOO_LARGE"],
    ["nesting deeper than 8", { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 1 } } } } } } } } } }, "TOO_DEEP"],
  ])("refuses %s", (_label, body, code) => {
    expect(parseBlueprintPayload(body, ID)).toEqual({ ok: false, code });
  });

  it("names an untitled blueprint and clamps readiness", () => {
    const res = parseBlueprintPayload({ readiness: 400 }, ID);
    expect(res).toMatchObject({ ok: true, title: "Untitled event", type: null, readiness: 100 });
  });
});

describe("parseTemplatePayload", () => {
  it("needs a state object", () => {
    expect(parseTemplatePayload({ name: "x" }, "tp_abcd1234")).toEqual({ ok: false, code: "NOT_AN_OBJECT" });
  });

  it("trims and caps the name", () => {
    const res = parseTemplatePayload({ name: ` ${"n".repeat(100)} `, type: "gala", state: { v: 2 } }, "tp_abcd1234");
    expect(res).toMatchObject({ ok: true, type: "gala", state: { v: 2 } });
    if (res.ok) expect(res.name).toHaveLength(80);
  });
});

describe("mergeForPage", () => {
  const row = {
    id: ID,
    status: "SUBMITTED" as const,
    ref: "EB-261008-K3P",
    data: { v: 2, basics: { title: "Summit" }, status: "live" },
    createdAt: new Date(1000),
    updatedAt: new Date(5000),
  };

  it("puts the server's status, reference and history over the stored data", () => {
    const merged = mergeForPage(row, [
      { kind: "SUBMITTED", toStatus: "SUBMITTED", readiness: 72, detail: { open: ["Dates"] }, createdAt: new Date(4000) },
    ]);
    expect(merged).toMatchObject({
      id: ID,
      status: "submitted",
      ref: "EB-261008-K3P",
      created: 1000,
      updated: 5000,
      approvals: { plan: null, preview: null },
      ownerId: null,
      eventId: null,
      statusLog: [{ status: "submitted", at: 4000 }],
      submissions: [{ kind: "submission", readiness: 72, open: ["Dates"], at: 4000 }],
    });
  });

  it("a draft with no history has empty arrays and an empty reference", () => {
    const merged = mergeForPage({ ...row, status: "DRAFT", ref: null }, []);
    expect(merged).toMatchObject({ status: "draft", ref: "", statusLog: [], submissions: [] });
  });

  it("reads approval times and the server's owner and event", () => {
    const merged = mergeForPage({ ...row, status: "LIVE", ownerId: "u-1", eventId: "evt-1" }, [
      { kind: "APPROVED", toStatus: "BUILDING", readiness: 100, detail: { which: "plan" }, createdAt: new Date(6000) },
      { kind: "APPROVED", toStatus: "LIVE", readiness: null, detail: { which: "preview" }, createdAt: new Date(7000) },
    ]);
    expect(merged).toMatchObject({ approvals: { plan: 6000, preview: 7000 }, ownerId: "u-1", eventId: "evt-1" });
  });
});
