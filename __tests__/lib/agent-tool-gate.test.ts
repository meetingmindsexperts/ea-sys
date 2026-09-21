/**
 * The Event Agent's write cap used to key on a hand-written list of 14
 * tool names, which missed 11 write tools (agent readiness gap G2). The
 * cap now derives from the registry's own read-only predicate, so this
 * suite pins two things: which tools count as writes, over the REAL tool
 * list the model is given, and that the gate refuses the 21st write no
 * matter which write tool it is.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {}, dbOperator: {} }));

import { AGENT_TOOL_DEFINITIONS } from "@/lib/agent/event-tools";
import { isReadOnlyTool, isWriteTool, NON_MUTATING_NON_READ_TOOLS } from "@/lib/agent/tools/_shared";
import { gateToolCall, MAX_WRITES_PER_REQUEST } from "@/lib/agent/tool-gate";

const NAMES = AGENT_TOOL_DEFINITIONS.map((t) => t.name);

/** The route's former hand list. */
const FORMER_LIST = [
  "create_track", "create_speaker", "create_session", "create_ticket_type",
  "create_registration", "create_abstract_theme", "create_review_criterion",
  "create_hotel", "create_contact", "add_topic_to_session",
  "update_abstract_status", "check_in_registration", "send_bulk_email",
  "upsert_sponsors",
];

/** The 11 write tools the former list missed. */
const FORMERLY_UNCAPPED = [
  "add_speaker_to_session",
  "remove_speaker_from_session",
  "replace_session_speakers",
  "update_session",
  "create_zoom_meeting",
  "create_certificate_template",
  "update_certificate_template",
  "delete_certificate_template",
  "update_review_criterion",
  "delete_review_criterion",
  "update_cme_settings",
];

describe("isWriteTool over the in-app tool list", () => {
  it("classifies every tool exactly once: read, write, or lookup-without-writing", () => {
    for (const name of NAMES) {
      const read = isReadOnlyTool(name);
      const write = isWriteTool(name);
      const other = NON_MUTATING_NON_READ_TOOLS.has(name);
      expect([read, write, other].filter(Boolean).length, name).toBe(1);
    }
  });

  it("counts the former list and the 11 it missed as writes", () => {
    for (const name of [...FORMER_LIST, ...FORMERLY_UNCAPPED]) {
      expect(NAMES, `${name} is no longer an in-app tool`).toContain(name);
      expect(isWriteTool(name), name).toBe(true);
    }
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
  const open = { readOnly: false, blockFinance: false };

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

  it("caps every write tool, including the 11 the old list missed", () => {
    for (const name of [...FORMER_LIST, ...FORMERLY_UNCAPPED]) {
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

  it("refuses every non-read for a read-only role before the cap is considered", () => {
    for (const name of NAMES.filter((n) => !isReadOnlyTool(n))) {
      const d = gateToolCall(name, { readOnly: true, blockFinance: true, writesSoFar: 0 });
      expect(d.kind, name).toBe("refuse");
      if (d.kind === "refuse") expect(d.result.code).toBe("READ_ONLY_ROLE");
    }
  });

  it("refuses the RSVP roster and the finance-only reads for MEMBER", () => {
    const roster = gateToolCall("list_rsvps", { readOnly: true, blockFinance: true, writesSoFar: 0 });
    expect(roster.kind === "refuse" && roster.result.code).toBe("ROSTER_FORBIDDEN");
    const finance = gateToolCall("list_invoices", { readOnly: true, blockFinance: true, writesSoFar: 0 });
    expect(finance.kind === "refuse" && finance.result.code).toBe("FINANCE_FORBIDDEN");
    // A finance-capable read-only role (none exists today) would still read invoices.
    expect(gateToolCall("list_invoices", { readOnly: true, blockFinance: false, writesSoFar: 0 })).toEqual({
      kind: "run",
      write: false,
    });
  });
});
