/**
 * CRM MCP tools — the registration surface + the security property that matters.
 *
 * The tools are thin glue over the (separately tested) services; what THESE
 * tests pin is (1) the tool set exists under the expected names — an MCP client
 * discovers by name, so a rename is a breaking change; and (2) every read the
 * glue does itself is bound to the INJECTED organizationId, never to anything
 * from tool input — the same "org from the validated key" rule as every other
 * MCP domain.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: {
    crmPipelineStage: { findMany: vi.fn(), findFirst: vi.fn(), createMany: vi.fn() },
    crmDeal: { findMany: vi.fn(), findFirst: vi.fn(), groupBy: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    crmCompany: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    crmTask: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn(), findUniqueOrThrow: vi.fn() },
    crmNote: { create: vi.fn() },
    user: { findFirst: vi.fn() },
    event: { findFirst: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    crmActivity: { create: vi.fn().mockResolvedValue({}) },
    crmNotification: { create: vi.fn().mockResolvedValue({}) },
  },
}));

import { db } from "@/lib/db";
import { registerCrmMcpTools } from "@/crm/agent-tools";

const ORG = "org-1";

type ToolFn = (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: true }>;

/** Minimal McpServer stand-in that just collects registrations. */
function collectTools() {
  const tools = new Map<string, ToolFn>();
  const server = {
    tool: (name: string, _desc: string, _shape: unknown, fn: ToolFn) => {
      tools.set(name, fn);
    },
  };
  registerCrmMcpTools(server as never, ORG, "system-user");
  return tools;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("registerCrmMcpTools — the discoverable surface", () => {
  it("registers the full CRM tool set under stable names", () => {
    const tools = collectTools();
    expect([...tools.keys()].sort()).toEqual(
      [
        "add_crm_note",
        "close_crm_deal",
        "complete_crm_task",
        "create_crm_company",
        "create_crm_deal",
        "create_crm_task",
        "get_crm_report",
        "list_crm_companies",
        "list_crm_deals",
        "list_crm_pipeline",
        "list_crm_tasks",
        "move_crm_deal_stage",
        "update_crm_deal",
      ].sort(),
    );
  });
});

describe("org binding — the injected org, never tool input", () => {
  it("list_crm_deals scopes to the registered organizationId and excludes archived", async () => {
    const tools = collectTools();
    vi.mocked(db.crmDeal.findMany).mockResolvedValue([] as never);

    const res = await tools.get("list_crm_deals")!({});

    expect(res.isError).toBeUndefined();
    expect(db.crmDeal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG, archivedAt: null }),
      }),
    );
  });

  it("list_crm_tasks scopes to the org and excludes archived", async () => {
    const tools = collectTools();
    vi.mocked(db.crmTask.findMany).mockResolvedValue([] as never);

    await tools.get("list_crm_tasks")!({});

    expect(db.crmTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG, archivedAt: null, status: "OPEN" }),
      }),
    );
  });

  it("create_crm_task refuses an owner email outside the org (user lookup is org-bound)", async () => {
    const tools = collectTools();
    vi.mocked(db.user.findFirst).mockResolvedValue(null as never); // not in THIS org

    const res = await tools.get("create_crm_task")!({ title: "Chase Abbott", ownerEmail: "outsider@evil.com" });

    expect(res.isError).toBe(true);
    expect(db.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: ORG }) }),
    );
    expect(db.crmTask.create).not.toHaveBeenCalled();
  });

  it("add_crm_note requires exactly ONE attachment — no attach, no note", async () => {
    const tools = collectTools();

    const none = await tools.get("add_crm_note")!({ body: "hello" });
    expect(none.isError).toBe(true);

    const two = await tools.get("add_crm_note")!({ body: "hello", dealId: "d-1", companyId: "c-1" });
    expect(two.isError).toBe(true);
    expect(db.crmNote.create).not.toHaveBeenCalled();
  });

  it("move_crm_deal_stage reads the deal's CURRENT stage org-bound and uses it as the claim precondition", async () => {
    const tools = collectTools();
    const stages = [
      { id: "s-neg", name: "Negotiation", isTerminal: false, terminalOutcome: null, organizationId: ORG },
      { id: "s-prop", name: "Proposal", isTerminal: false, terminalOutcome: null, organizationId: ORG },
    ];
    vi.mocked(db.crmPipelineStage.findMany).mockResolvedValue(stages as never);
    // moveDealStage's own resolveStage() goes through findFirst — answer per id.
    vi.mocked(db.crmPipelineStage.findFirst).mockImplementation((async (args: { where?: { id?: string } }) =>
      stages.find((st) => st.id === args?.where?.id) ?? null) as never);
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ stageId: "s-neg" } as never);
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmDeal.findUniqueOrThrow).mockResolvedValue({ id: "d-1", status: "OPEN" } as never);

    const res = await tools.get("move_crm_deal_stage")!({ dealId: "d-1", toStage: "Proposal" });

    expect(res.isError).toBeUndefined();
    // The current-stage read is org-bound…
    expect(db.crmDeal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "d-1", organizationId: ORG }) }),
    );
    // …and the write claims on that stage (race-safe even for an agent caller).
    expect(db.crmDeal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG, stageId: "s-neg" }),
      }),
    );
  });
});
