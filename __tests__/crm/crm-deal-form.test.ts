/**
 * The deal form's rules for "this deal is for an event OR a corporate project"
 * (Nov 12, 2026). Pure functions, so every starting state is checked without a
 * browser: what is sent, what is refused, and that looking at the other side
 * changes nothing a save would carry (review of e92d660f).
 */
import { describe, it, expect } from "vitest";
import {
  crmDealFormPayload,
  crmDealToForm,
  dealTargetPatch,
  emptyCrmDealForm,
  validateDealForm,
  type CrmDealFormState,
} from "@/crm/components/crm-deal-form-fields";
import type { CrmBoardDeal } from "@/crm/lib/crm-types";

const baseDeal: CrmBoardDeal = {
  id: "d-1",
  name: "Abbott Gold",
  currency: "USD",
  stageId: "s-1",
  status: "OPEN",
  createdAt: "2026-11-01T00:00:00.000Z",
};
const eventDeal: CrmBoardDeal = { ...baseDeal, event: { id: "e-1", name: "BRIDGES 2027", slug: "bridges-2027" } };
const projectDeal: CrmBoardDeal = { ...baseDeal, project: { id: "p-1", name: "Novartis Ad Board" } as CrmBoardDeal["project"] };

/** Apply a side choice the way the form's parent does. */
function choose(f: CrmDealFormState, target: "event" | "project"): CrmDealFormState {
  return { ...f, ...dealTargetPatch(f, target) };
}

describe("where a deal form starts", () => {
  it("a new deal starts on the event side, uncategorised", () => {
    const f = emptyCrmDealForm({ eventId: "e-1" });
    expect(f).toMatchObject({ target: "event", eventId: "e-1", projectId: null, pipeline: "" });
  });

  it("a new deal from a project's page starts on that project, in Corporate", () => {
    const f = emptyCrmDealForm({ project: { id: "p-1", name: "Novartis Ad Board" } });
    expect(f).toMatchObject({ target: "project", projectId: "p-1", projectName: "Novartis Ad Board", pipeline: "CORPORATE" });
  });

  it("an existing deal opens on the side it holds", () => {
    expect(crmDealToForm(eventDeal)).toMatchObject({ target: "event", eventId: "e-1", projectId: null });
    expect(crmDealToForm(projectDeal)).toMatchObject({ target: "project", projectId: "p-1", eventId: null, projectName: "Novartis Ad Board" });
  });
});

describe("what a save sends", () => {
  it("sends exactly one side as an id and the other as null", () => {
    expect(crmDealFormPayload(crmDealToForm(eventDeal), null)).toMatchObject({ eventId: "e-1", projectId: null });
    expect(crmDealFormPayload(crmDealToForm(projectDeal), null)).toMatchObject({ eventId: null, projectId: "p-1" });
  });

  it("an edit that touches nothing else keeps the deal where it is", () => {
    const untouchedEvent = crmDealFormPayload({ ...crmDealToForm(eventDeal), name: "Abbott Gold (renamed)" }, null);
    expect(untouchedEvent).toMatchObject({ eventId: "e-1", projectId: null, pipeline: null });
    const untouchedProject = crmDealFormPayload({ ...crmDealToForm(projectDeal), name: "Renamed" }, null);
    expect(untouchedProject).toMatchObject({ eventId: null, projectId: "p-1", pipeline: null });
  });

  it("moving a deal across sends the new side and clears the one it left", () => {
    const moved = { ...choose(crmDealToForm(eventDeal), "project"), projectId: "p-9" };
    expect(crmDealFormPayload(moved, null)).toMatchObject({ eventId: null, projectId: "p-9" });
  });

  it("the side not chosen keeps what was picked, and is not sent", () => {
    const there = { ...choose(crmDealToForm(eventDeal), "project"), projectId: "p-9" };
    const back = choose(there, "event");
    expect(back).toMatchObject({ eventId: "e-1", projectId: "p-9" });
    expect(crmDealFormPayload(back, null)).toMatchObject({ eventId: "e-1", projectId: null });
  });
});

describe("what is refused before a save", () => {
  it("a deal on neither side", () => {
    expect(validateDealForm({ ...emptyCrmDealForm(), name: "X" })).toBe("Select the event this deal is for");
    expect(validateDealForm({ ...choose(emptyCrmDealForm(), "project"), name: "X" })).toBe(
      "Select the corporate project this deal is for",
    );
  });

  it("an id on the side NOT chosen does not satisfy the rule", () => {
    const f = { ...choose(emptyCrmDealForm({ eventId: "e-1" }), "project"), name: "X" };
    expect(validateDealForm(f)).toBe("Select the corporate project this deal is for");
  });

  it("a sound form passes", () => {
    expect(validateDealForm({ ...emptyCrmDealForm({ eventId: "e-1" }), name: "X" })).toBeNull();
  });
});

describe("the Corporate category offered with the project side", () => {
  it("is offered to an uncategorised deal, where the person can see it", () => {
    expect(choose(crmDealToForm(eventDeal), "project").pipeline).toBe("CORPORATE");
  });

  it("is withdrawn on going back: looking at the other tab files nothing", () => {
    const looked = choose(choose(crmDealToForm(eventDeal), "project"), "event");
    expect(looked.pipeline).toBe("");
    // The save of an unrelated fix carries no category.
    expect(crmDealFormPayload({ ...looked, name: "Typo fixed" }, null).pipeline).toBeNull();
  });

  it("stays when the person chose the category themselves", () => {
    const onProject = choose(crmDealToForm(eventDeal), "project");
    // What the Pipeline field sends when a person picks a value.
    const chosen: CrmDealFormState = { ...onProject, pipeline: "CORPORATE", pipelineFromTarget: false };
    expect(choose(chosen, "event").pipeline).toBe("CORPORATE");
  });

  it("never replaces a category the deal already has", () => {
    const conference = crmDealToForm({ ...eventDeal, pipeline: "CONFERENCE" });
    expect(choose(conference, "project").pipeline).toBe("CONFERENCE");
    expect(choose(choose(conference, "project"), "event").pipeline).toBe("CONFERENCE");
  });

  it("a stored Corporate deal on a project keeps it when moved to an event", () => {
    const stored = crmDealToForm({ ...projectDeal, pipeline: "CORPORATE" });
    expect(choose(stored, "event").pipeline).toBe("CORPORATE");
  });

  it("a new deal started from a project loses the offered category when moved to an event", () => {
    const f = emptyCrmDealForm({ project: { id: "p-1", name: "Novartis Ad Board" } });
    expect(choose(f, "event").pipeline).toBe("");
  });

  it("choosing the side already chosen changes nothing", () => {
    expect(dealTargetPatch(crmDealToForm(eventDeal), "event")).toEqual({});
  });
});
