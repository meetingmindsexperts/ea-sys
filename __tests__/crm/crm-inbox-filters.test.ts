/**
 * The CRM inbox folders and filters (Oct 27, 2026, docs/CRM_INBOX_PLAN.md
 * phase 1): Inbox = replied and not archived, Sent = everything, Archived =
 * archived; Mine never widens for an API key; search is every-word-must-match.
 */
import { describe, it, expect } from "vitest";
import { inboxWhere, unreadWhere } from "@/crm/lib/crm-inbox-filters";

const and = (w: ReturnType<typeof inboxWhere>) => w.AND as Record<string, unknown>[];

describe("inboxWhere", () => {
  it("is always bound to the organisation", () => {
    for (const folder of ["inbox", "sent", "archived"] as const) {
      expect(and(inboxWhere("org-1", "u-1", { folder }))[0]).toEqual({ organizationId: "org-1" });
    }
  });

  it("Inbox holds replied, unarchived threads; Sent holds all; Archived holds archived", () => {
    expect(and(inboxWhere("o", "u", { folder: "inbox" }))[1]).toEqual({ lastInboundAt: { not: null }, archivedAt: null });
    expect(and(inboxWhere("o", "u", { folder: "sent" }))[1]).toEqual({});
    expect(and(inboxWhere("o", "u", { folder: "archived" }))[1]).toEqual({ archivedAt: { not: null } });
  });

  it("adds Unread, Mine and the deal filter", () => {
    const w = and(inboxWhere("o", "u-1", { folder: "sent", unreadOnly: true, mine: true, dealId: "d-1" }));
    expect(w).toContainEqual({ hasUnread: true });
    expect(w).toContainEqual({ deal: { ownerId: "u-1" } });
    expect(w).toContainEqual({ dealId: "d-1" });
  });

  it("Mine with no user (an API key) matches nothing, never everything", () => {
    const w = and(inboxWhere("o", null, { folder: "sent", mine: true }));
    expect(w).toContainEqual({ deal: { ownerId: "__no-user__" } });
  });

  it("search needs every word, each matching subject, person, email or deal", () => {
    const w = and(inboxWhere("o", "u", { folder: "sent", q: "  abbott   gold " }));
    const words = w.slice(2);
    expect(words).toHaveLength(2);
    expect(JSON.stringify(words[0])).toContain('"contains":"abbott"');
    expect(JSON.stringify(words[1])).toContain('"contains":"gold"');
    expect(JSON.stringify(words[0])).toContain('"deal":{"name"');
  });

  it("ignores a blank search", () => {
    expect(and(inboxWhere("o", "u", { folder: "sent", q: "   " }))).toHaveLength(2);
  });
});

describe("unreadWhere", () => {
  it("counts unread, unarchived threads in the organisation", () => {
    expect(unreadWhere("o")).toEqual({ organizationId: "o", hasUnread: true, archivedAt: null });
  });
});
