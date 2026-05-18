/**
 * The MEMBER role is an org-bound read-only viewer. The in-app AI agent
 * lets MEMBER drive reporting/lookups but refuses every write tool. The
 * boundary is `isReadOnlyTool()` in src/lib/agent/tools/_shared.ts — it
 * must FAIL CLOSED so a future tool that doesn't match the read prefixes
 * is denied for MEMBER by default rather than silently allowed.
 */
import { describe, it, expect } from "vitest";
import { isReadOnlyTool } from "@/lib/agent/tools/_shared";
import { TOOL_EXECUTOR_MAP } from "@/lib/agent/event-tools";

describe("isReadOnlyTool — MEMBER read-only boundary", () => {
  it("allows list_ / get_ / search_ prefixed tools", () => {
    for (const name of [
      "list_speakers",
      "list_registrations",
      "list_unpaid_registrations",
      "get_event_dashboard",
      "get_event_stats",
      "get_webinar_info",
      "search_event",
    ]) {
      expect(isReadOnlyTool(name)).toBe(true);
    }
  });

  it("blocks every write-style prefix", () => {
    for (const name of [
      "create_speaker",
      "update_registration",
      "delete_promo_code",
      "add_topic_to_session",
      "remove_speaker_from_session",
      "replace_session_speakers",
      "assign_reviewer_to_abstract",
      "unassign_reviewer_from_abstract",
      "submit_abstract_review",
      "check_in_registration",
      "send_bulk_email",
      "cancel_scheduled_email",
      "bulk_update_registration_status",
      "upsert_sponsors",
      "create_event",
      "update_event",
    ]) {
      expect(isReadOnlyTool(name)).toBe(false);
    }
  });

  it("fails closed for unknown / future tool names", () => {
    // The whole point: anything that isn't explicitly a read prefix is
    // denied. A new tool added later without updating this gate stays
    // safe-by-default.
    expect(isReadOnlyTool("frobnicate_widgets")).toBe(false);
    expect(isReadOnlyTool("")).toBe(false);
    expect(isReadOnlyTool("LIST_speakers")).toBe(false); // case-sensitive on purpose
    expect(isReadOnlyTool("xlist_speakers")).toBe(false); // prefix must be at start
  });

  it("every real tool in the executor map is classified deterministically", () => {
    // Contract test against the actual tool surface: each tool is either
    // read-only or not — no tool should be ambiguous. We also assert the
    // read-only set is non-empty and the write set is non-empty so a
    // refactor that accidentally inverts the regex is caught.
    const names = Object.keys(TOOL_EXECUTOR_MAP);
    expect(names.length).toBeGreaterThan(0);
    const readOnly = names.filter(isReadOnlyTool);
    const writes = names.filter((n) => !isReadOnlyTool(n));
    expect(readOnly.length).toBeGreaterThan(0);
    expect(writes.length).toBeGreaterThan(0);
    // Spot-check known members of each set are on the right side.
    expect(readOnly).toContain("list_speakers");
    expect(writes).toContain("create_speaker");
    // Nothing starting with create_/update_/delete_ should ever be in
    // the read-only set.
    for (const n of readOnly) {
      expect(/^(create_|update_|delete_)/.test(n)).toBe(false);
    }
  });
});
