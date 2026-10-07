/**
 * The Event Agent's write cap used to key on a hand-written list of 14
 * tool names, which missed 11 write tools (agent readiness gap G2). The
 * cap now derives from the registry's read-only predicate, so this suite
 * pins two things over the REAL tool list an admin is given: which tools
 * count as writes, and that the gate refuses the 21st write whichever
 * write tool it is.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {}, dbOperator: {} }));

import { collectToolsForActor } from "@/lib/agent/tool-registry";
import { isReadOnlyTool, isWriteTool, NON_MUTATING_NON_READ_TOOLS } from "@/lib/agent/tools/_shared";
import { gateToolCall, MAX_WRITES_PER_REQUEST } from "@/lib/agent/tool-gate";
import { toolPermission } from "@/lib/agent/tool-permissions";
import { ROSTER_PII_AGENT_TOOLS } from "@/lib/agent/tools/_shared";
/** The old gate's wholly-financial tools, frozen here as history (Phase 6 deleted the list). */
const FINANCE_ONLY_AGENT_TOOLS = new Set(["list_invoices", "list_unpaid_registrations", "get_event_analytics"]);
import { principalFromUser } from "@/lib/permissions/can";
import { describePermission } from "@/lib/permissions/catalogue";
import { canViewFinance } from "../helpers/role-can";

const NAMES = collectToolsForActor({
  organizationId: "org1",
  actor: { userId: "u1", role: "ADMIN", fromApiKey: false },
  source: "agent",
}).map((t) => t.name);

/** The route's former hand list. */
const FORMER_LIST = [
  "create_track", "create_speaker", "create_session", "create_ticket_type",
  "create_registration", "create_abstract_theme", "create_review_criterion",
  "create_hotel", "create_contact", "add_topic_to_session",
  "update_abstract_status", "check_in_registration", "send_bulk_email",
  "upsert_sponsors",
];

/** The write tools the former list missed and that still exist (the two
 *  delete tools were removed from both doors on Sep 21, 2026). */
const FORMERLY_UNCAPPED = [
  "add_speaker_to_session",
  "remove_speaker_from_session",
  "replace_session_speakers",
  "update_session",
  "create_zoom_meeting",
  "create_certificate_template",
  "update_certificate_template",
  "update_review_criterion",
  "update_cme_settings",
];

describe("isWriteTool over the tools an admin is given", () => {
  it("classifies every tool exactly once: read, write, or lookup-without-writing", () => {
    expect(NAMES.length).toBeGreaterThan(80);
    for (const name of NAMES) {
      const read = isReadOnlyTool(name);
      const write = isWriteTool(name);
      const other = NON_MUTATING_NON_READ_TOOLS.has(name);
      expect([read, write, other].filter(Boolean).length, name).toBe(1);
    }
  });

  it("counts the former list and the writes it missed as writes", () => {
    for (const name of [...FORMER_LIST, ...FORMERLY_UNCAPPED]) {
      expect(NAMES, `${name} is no longer offered`).toContain(name);
      expect(isWriteTool(name), name).toBe(true);
    }
  });

  it("offers exactly the two delete tools that were never in the readiness list, and not the two that were removed", () => {
    // delete_room_type and delete_promo_code (a soft delete) have been on the
    // MCP door since their modules shipped; delete_review_criterion and
    // delete_certificate_template were removed from both doors on Sep 21, 2026.
    expect(NAMES.filter((n) => /^delete_/.test(n)).sort()).toEqual(["delete_promo_code", "delete_room_type"]);
  });

  it("never counts a read as a write", () => {
    for (const name of NAMES.filter(isReadOnlyTool)) {
      expect(isWriteTool(name), name).toBe(false);
    }
  });

  it("exempts only tools that exist and are not reads", () => {
    for (const name of NON_MUTATING_NON_READ_TOOLS) {
      expect(NAMES).toContain(name);
      expect(isReadOnlyTool(name)).toBe(false);
      expect(isWriteTool(name)).toBe(false);
    }
    expect(isWriteTool("research_sponsor")).toBe(false);
  });

  it("fails closed: an unknown tool is a write", () => {
    expect(isWriteTool("frobnicate_widgets")).toBe(true);
    expect(isWriteTool("")).toBe(true);
  });
});

describe("gateToolCall", () => {
  const open = { principal: principalFromUser({ id: "u1", role: "ADMIN", organizationId: "org1" }) };

  it("lets reads through without counting them", () => {
    expect(gateToolCall("list_speakers", { ...open, writesSoFar: MAX_WRITES_PER_REQUEST })).toEqual({
      kind: "run",
      write: false,
    });
  });

  it("marks a write as one and refuses it once the cap is reached", () => {
    expect(gateToolCall("update_session", { ...open, writesSoFar: MAX_WRITES_PER_REQUEST - 1 })).toEqual({
      kind: "run",
      write: true,
    });
    const refused = gateToolCall("update_session", { ...open, writesSoFar: MAX_WRITES_PER_REQUEST });
    expect(refused.kind).toBe("refuse");
    if (refused.kind === "refuse") expect(refused.result.code).toBe("WRITE_LIMIT");
  });

  it("caps every write tool, including the ones the old list missed", () => {
    for (const name of [...FORMER_LIST, ...FORMERLY_UNCAPPED, "create_event", "update_event", "update_registration"]) {
      const d = gateToolCall(name, { ...open, writesSoFar: 20, maxWrites: 20 });
      expect(d.kind, name).toBe("refuse");
    }
  });

  it("does not cap the lookup-without-writing tools", () => {
    expect(gateToolCall("research_sponsor", { ...open, writesSoFar: 999 })).toEqual({
      kind: "run",
      write: false,
    });
  });

  it("maps every tool to a permission key, and refuses a tool with none", () => {
    expect(NAMES.filter((n) => !toolPermission(n))).toEqual([]);
    const d = gateToolCall("frobnicate_widgets", { ...open, writesSoFar: 0 });
    expect(d.kind === "refuse" && d.result.code).toBe("NO_PERMISSION_KEY");
  });

  it("judges an event-bound key on the call's event", () => {
    const webinars = principalFromUser({ id: "u1", role: "WEBINARS", organizationId: "org1" });
    const webinar = { organizationId: "org1", eventType: "WEBINAR", staffUserIds: [] };
    const conference = { organizationId: "org1", eventType: "CONFERENCE", staffUserIds: [] };
    expect(gateToolCall("list_speakers", { principal: webinars, event: webinar, writesSoFar: 0 }).kind).toBe("run");
    const d = gateToolCall("list_speakers", { principal: webinars, event: conference, writesSoFar: 0 });
    expect(d.kind === "refuse" && d.result.code).toBe("PERMISSION_DENIED");
    const missing = gateToolCall("list_speakers", { ...open, event: null, writesSoFar: 0 });
    expect(missing.kind === "refuse" && missing.result.code).toBe("PERMISSION_DENIED");
  });

  // Phase 6 review (Oct 7, 2026): search_event and get_event_dashboard are
  // keyed events.read but return people from other domains.
  it("refuses the people-returning reads to a role holding events.read alone", () => {
    const narrow = principalFromUser({ id: "u1", role: "CRM_USER", organizationId: "org1", procurementPermissions: ["agent.use", "events.read@ALL"] });
    const event = { organizationId: "org1", eventType: "CONFERENCE", staffUserIds: [] };
    for (const name of ["search_event", "get_event_dashboard"]) {
      const d = gateToolCall(name, { principal: narrow, event, writesSoFar: 0, input: { eventId: "e1" } });
      expect(d.kind === "refuse" && d.result.code, name).toBe("PERMISSION_DENIED");
    }
    expect(gateToolCall("get_event_info", { principal: narrow, event, writesSoFar: 0, input: { eventId: "e1" } }).kind).toBe("run");
  });

  /**
   * Against the role rules it replaced (read-only Member, the roster and the
   * finance reads), for every role the agent admits, on a conference in the
   * person's organisation. Every difference is listed and was reviewed
   * (owner-approved Phase 3 scope, Oct 5, 2026): the agent now refuses what
   * the matching REST route refuses.
   */
  it("differs from the old role rules only where recorded", async () => {
    const event = { organizationId: "org1", eventType: "CONFERENCE", staffUserIds: [] };
    const lines: string[] = [];
    for (const role of ["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER"]) {
      const p = principalFromUser({ id: "u1", role, organizationId: "org1" });
      for (const name of NAMES) {
        const readOnly = role === "MEMBER";
        const oldRefused =
          (readOnly && !isReadOnlyTool(name)) ||
          (readOnly && ROSTER_PII_AGENT_TOOLS.has(name)) ||
          (!canViewFinance(role) && FINANCE_ONLY_AGENT_TOOLS.has(name));
        const key = toolPermission(name);
        const bound = key ? describePermission(key)?.eventBound : false;
        const d = gateToolCall(name, { principal: p, event: bound ? event : undefined, writesSoFar: 0 });
        const newRefused = d.kind === "refuse";
        if (oldRefused !== newRefused) lines.push(`${role} ${name} (${key}): ${oldRefused ? "refused" : "ran"} -> ${newRefused ? "refused" : "runs"}`);
      }
    }
    await expect(lines.join("\n") + "\n").toMatchFileSnapshot("./__snapshots__/agent-tool-gate-parity.txt");
  });
});
