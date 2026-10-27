import { describe, it, expect } from "vitest";
import { principalFromUser } from "@/lib/permissions/can";
import {
  redactSubmissionsInResource,
  redactSubmissionsInToolText,
  submissionVisibilityOnFacts,
  toolCarriesSubmissions,
} from "@/lib/agent/submission-redaction";
import { submissionEmailVisible } from "@/lib/speaker-submission-visibility";

const HIDDEN = { abstracts: false, proposals: false };
const SHOWN = { abstracts: true, proposals: true };

describe("agent tools: abstracts inside an events.read answer (owner, Oct 27)", () => {
  const search = JSON.stringify({
    query: "jane",
    results: { registrations: [{ id: "r1" }], speakers: [], abstracts: [{ id: "a1", label: "Secret title", status: "ACCEPTED" }], contacts: [] },
    totalFound: 2,
  });

  it("search_event loses its abstracts and their share of the total", () => {
    const out = JSON.parse(redactSubmissionsInToolText("search_event", search, HIDDEN));
    expect(out.results).not.toHaveProperty("abstracts");
    expect(out.results.registrations).toHaveLength(1);
    expect(out.totalFound).toBe(1);
  });

  it("get_event_stats loses its abstract counts", () => {
    const out = JSON.parse(redactSubmissionsInToolText("get_event_stats", JSON.stringify({ speakers: { CONFIRMED: 2 }, abstracts: { ACCEPTED: 4 } }), HIDDEN));
    expect(out).toEqual({ speakers: { CONFIRMED: 2 } });
  });

  it("keeps everything for a caller with abstracts.read, and leaves other tools alone", () => {
    expect(redactSubmissionsInToolText("search_event", search, SHOWN)).toBe(search);
    expect(toolCarriesSubmissions("list_registrations")).toBe(false);
    expect(redactSubmissionsInToolText("list_registrations", '{"abstracts":1}', HIDDEN)).toBe('{"abstracts":1}');
  });

  it("the event-info resource loses its abstract count", () => {
    const result = { contents: [{ uri: "x", text: JSON.stringify({ id: "e1", _count: { speakers: 3, abstracts: 9 } }) }] };
    const out = redactSubmissionsInResource("event-info", result, HIDDEN);
    expect(JSON.parse(out.contents[0].text)).toEqual({ id: "e1", _count: { speakers: 3 } });
    expect(redactSubmissionsInResource("event-info", result, SHOWN)).toBe(result);
  });

  it("judges the keys on the event's scope; no event sees nothing", () => {
    const assigned = principalFromUser({ id: "u1", role: "BASE", organizationId: "org1", procurementPermissions: ["events.read@ALL", "abstracts.read@ASSIGNED"] });
    const facts = (staff: string[]) => ({ organizationId: "org1", eventType: "CONFERENCE", staffUserIds: staff });
    expect(submissionVisibilityOnFacts(assigned, facts(["u1"])).abstracts).toBe(true);
    expect(submissionVisibilityOnFacts(assigned, facts([])).abstracts).toBe(false);
    expect(submissionVisibilityOnFacts(assigned, null)).toEqual(HIDDEN);
  });
});

describe("submissionEmailVisible", () => {
  it("sorts the templates by the key they need", () => {
    expect(submissionEmailVisible("abstract-status-update", { abstracts: false, proposals: true })).toBe(false);
    expect(submissionEmailVisible("presenter-agreement", { abstracts: false, proposals: true })).toBe(false);
    expect(submissionEmailVisible("session-proposal-confirmation", { abstracts: true, proposals: false })).toBe(false);
    expect(submissionEmailVisible("speaker-invitation", HIDDEN)).toBe(true);
    expect(submissionEmailVisible(null, HIDDEN)).toBe(true);
  });
});
