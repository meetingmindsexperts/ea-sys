/**
 * The agent's map of the dashboard (September 22, 2026). Asked "where can I
 * find those drafts?", the agent invented sidebar names ("Emails") because
 * its prompt never said where anything was. One table now feeds both the
 * prompt section and the dashboardUrl every successful tool result carries.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn(), findUnique: vi.fn() },
    emailTemplate: { findMany: vi.fn(), findFirst: vi.fn() },
    organization: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: mockDb, tenantTransaction: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  DASHBOARD_SURFACES,
  buildDashboardMapSection,
  dashboardPathForTool,
  dashboardUrl,
  surfaceForTool,
} from "@/lib/agent/dashboard-links";
import { collectToolsForActor } from "@/lib/agent/tool-registry";

beforeEach(() => vi.clearAllMocks());

describe("the table", () => {
  it("names the real Email Templates page under Communications, the page the agent could not name", () => {
    const s = DASHBOARD_SURFACES.find((x) => x.key === "email-templates")!;
    expect(s.label).toMatch(/^Communications, Email Templates/);
    expect(s.path("ev1")).toBe("/events/ev1/communications/templates");
    expect(s.path(null)).toBeNull();
  });

  it("maps every tool an admin can call, on both doors, to a surface (a new tool without one fails here)", () => {
    vi.stubEnv("PROCUREMENT_MODULE_ENABLED", "true");
    try {
      const unmapped = new Set<string>();
      for (const source of ["agent", "mcp"] as const) {
        const tools = collectToolsForActor({
          organizationId: "org",
          actor: { userId: "u1", role: "ADMIN", fromApiKey: source === "mcp" },
          source,
        });
        expect(tools.length).toBeGreaterThan(80);
        for (const t of tools) if (!surfaceForTool(t.name)) unmapped.add(t.name);
      }
      expect([...unmapped]).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("dashboardPathForTool", () => {
  it("points at the row's own page when the result names it, else the surface", () => {
    expect(dashboardPathForTool("create_email_template", "ev1", { template: { id: "tpl9" } })).toBe("/events/ev1/communications/templates/tpl9");
    expect(dashboardPathForTool("duplicate_email_template", "ev1", { template: { id: "tpl10" } })).toBe("/events/ev1/communications/templates/tpl10");
    expect(dashboardPathForTool("list_email_templates", "ev1", { templates: [] })).toBe("/events/ev1/communications/templates");
    expect(dashboardPathForTool("create_speaker", "ev1", { speaker: { id: "sp1" } })).toBe("/events/ev1/speakers/sp1");
    expect(dashboardPathForTool("update_abstract_status", "ev1", { abstract: { id: "ab1" } })).toBe("/events/ev1/abstracts/ab1/edit");
    expect(dashboardPathForTool("create_event", null, { event: { id: "ev9" } })).toBe("/events/ev9");
    expect(dashboardPathForTool("create_budget", "ev1", { budget: { id: "b1" } })).toBe("/procurement/budgets/b1");
    expect(dashboardPathForTool("create_crm_deal", null, { deal: { id: "d1" } })).toBe("/crm/deals/d1");
  });

  it("does not confuse look-alike names: a session roster tool is the agenda, a speaker agreement is the speakers page", () => {
    expect(dashboardPathForTool("add_speaker_to_session", "ev1", {})).toBe("/events/ev1/agenda");
    expect(dashboardPathForTool("replace_session_speakers", "ev1", {})).toBe("/events/ev1/agenda");
    expect(dashboardPathForTool("list_speaker_agreements", "ev1", {})).toBe("/events/ev1/speakers");
    expect(dashboardPathForTool("check_in_registration", "ev1", {})).toBe("/events/ev1/check-in");
    expect(dashboardPathForTool("list_crm_contacts", null, {})).toBe("/crm");
    expect(dashboardPathForTool("list_contacts", null, {})).toBe("/contacts");
  });

  it("is null for an unknown tool, and for an event page with no event in context", () => {
    expect(dashboardPathForTool("do_something_new", "ev1", {})).toBeNull();
    expect(dashboardPathForTool("list_email_templates", null, {})).toBeNull();
  });

  it("builds an absolute link and tolerates a trailing slash or no base at all", () => {
    expect(dashboardUrl("/events/ev1", "https://x.test/")).toBe("https://x.test/events/ev1");
    expect(dashboardUrl("/events/ev1", undefined)).toBe("/events/ev1");
  });
});

describe("buildDashboardMapSection", () => {
  it("substitutes the selected event and tells the model to quote a result's dashboardUrl", () => {
    const s = buildDashboardMapSection("ev1", "https://x.test");
    expect(s).toContain("## Where things are in the dashboard");
    expect(s).toContain("never invent a menu or page name");
    expect(s).toContain("dashboardUrl");
    expect(s).toContain("- Communications, Email Templates (every email template, built-in and custom): https://x.test/events/ev1/communications/templates");
    expect(s).not.toContain("{eventId}");
  });

  it("keeps a placeholder and says to find the event first when none is selected", () => {
    const s = buildDashboardMapSection(null, undefined);
    expect(s).toContain("/events/{eventId}/communications/templates");
    expect(s).toContain("find the event first");
  });
});

describe("the shared runner attaches the link on both doors", () => {
  it("adds dashboardUrl to a successful event-tool result", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://x.test");
    try {
      mockDb.event.findFirst.mockResolvedValue({ organizationId: "org" });
      mockDb.emailTemplate.findMany.mockResolvedValue([]);
      for (const source of ["agent", "mcp"] as const) {
        const tool = collectToolsForActor({
          organizationId: "org",
          actor: { userId: "u1", role: "ADMIN", fromApiKey: source === "mcp" },
          source,
        }).find((t) => t.name === "list_email_templates")!;
        const res = await tool.run({ eventId: "ev1" });
        expect(res.isError, source).toBe(false);
        expect(JSON.parse(res.text).dashboardUrl, source).toBe("https://x.test/events/ev1/communications/templates");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
