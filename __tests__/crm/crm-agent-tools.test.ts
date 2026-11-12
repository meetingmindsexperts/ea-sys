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

// The organisation has the CRM (module-entitlements.ts); the entitlement has its own tests.
vi.mock("@/lib/module-entitlements", () => ({ orgHasModule: vi.fn(async () => true), orgModuleState: vi.fn(async () => "on"), forgetOrgModules: vi.fn() }));

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => {
  const db = {
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    crmPipelineStage: { findMany: vi.fn(), findFirst: vi.fn(), createMany: vi.fn() },
    crmDeal: { findMany: vi.fn(), findFirst: vi.fn(), groupBy: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn() },
    crmProject: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    crmDealType: { findMany: vi.fn(), createMany: vi.fn() },
    crmCompany: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    crmContact: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    crmProduct: { count: vi.fn(), createMany: vi.fn(), findMany: vi.fn() },
    crmDealProduct: { findMany: vi.fn() },
    crmDealContact: { findMany: vi.fn() },
    crmTask: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn(), findUniqueOrThrow: vi.fn() },
    crmNote: { findMany: vi.fn(), create: vi.fn() },
    user: { findFirst: vi.fn(), findMany: vi.fn() },
    event: { findFirst: vi.fn(), findMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    crmActivity: { create: vi.fn().mockResolvedValue({}) },
    crmNotification: { create: vi.fn().mockResolvedValue({}) },
  };
  // Interactive tenantTransaction runs the callback on the same mock (the claim + its audit row).
  return { db, tenantTransaction: (fn: (tx: typeof db) => unknown) => fn(db) };
});

import { db } from "@/lib/db";
import { registerCrmMcpTools } from "@/crm/agent-tools";

const ORG = "org-1";

type ToolFn = (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: true }>;

/** Minimal McpServer stand-in that just collects registrations. */
function collectTools(userId = "system-user") {
  const tools = new Map<string, ToolFn>();
  const server = {
    tool: (name: string, _desc: string, _shape: unknown, fn: ToolFn) => {
      tools.set(name, fn);
    },
  };
  registerCrmMcpTools(server as never, ORG, userId);
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
        // Pipeline / deals
        "list_crm_pipeline",
        "list_crm_deals",
        "list_crm_deal_types",
        "create_crm_deal",
        "update_crm_deal",
        "move_crm_deal_stage",
        "close_crm_deal",
        "get_crm_deal",
        // Companies (accounts)
        "list_crm_companies",
        "create_crm_company",
        "get_crm_company",
        "update_crm_company",
        // Corporate projects
        "list_crm_projects",
        "create_crm_project",
        // Contacts
        "list_crm_contacts",
        "create_crm_contact",
        "update_crm_contact",
        // Products (catalog + deal line items)
        "list_crm_products",
        "create_crm_product",
        "update_crm_product",
        "list_crm_deal_products",
        "add_deal_product",
        "update_deal_product",
        // Tasks / notes / report
        "list_crm_tasks",
        "create_crm_task",
        "complete_crm_task",
        "add_crm_note",
        "get_crm_report",
      ].sort(),
    );
  });
});

describe("the organisation's entitlement", () => {
  it("refuses every tool, reading nothing, when the organisation does not have the CRM", async () => {
    const { orgHasModule } = await import("@/lib/module-entitlements");
    vi.mocked(orgHasModule).mockResolvedValueOnce(false);
    const res = await collectTools().get("list_crm_deals")!({});
    expect(res.isError).toBe(true);
    expect(db.crmDeal.findMany).not.toHaveBeenCalled();
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

  it("list_crm_deal_types scopes ensureDealTypes to the registered org", async () => {
    const tools = collectTools();
    vi.mocked(db.crmDealType.findMany).mockResolvedValue([{ id: "dt-1", name: "Sponsorship Inquiry", archivedAt: null }] as never);

    const res = await tools.get("list_crm_deal_types")!({});

    expect(res.isError).toBeUndefined();
    expect(db.crmDealType.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: ORG }) }),
    );
  });

  it("list_crm_deals threads a valid pipeline filter into the where", async () => {
    const tools = collectTools();
    vi.mocked(db.crmDeal.findMany).mockResolvedValue([] as never);

    await tools.get("list_crm_deals")!({ pipeline: "CONFERENCE" });

    expect(db.crmDeal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG, pipeline: "CONFERENCE" }),
      }),
    );
  });

  it("update_crm_deal passes the pipeline + NORMALIZED tags through to the write", async () => {
    const tools = collectTools();
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({
      name: "Abbott", dealValue: null, currency: "USD", expectedClose: null,
      companyId: null, eventId: "e-1", ownerId: null, pipeline: null, tags: [], archivedAt: null,
    } as never);
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmDeal.findUniqueOrThrow).mockResolvedValue({ id: "d-1", name: "Abbott", ownerId: null } as never);

    const res = await tools.get("update_crm_deal")!({ dealId: "d-1", pipeline: "CORPORATE", tags: ["A", "a", "B"] });

    expect(res.isError).toBeUndefined();
    const call = vi.mocked(db.crmDeal.updateMany).mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data).toMatchObject({ pipeline: "CORPORATE", tags: ["A", "B"] });
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

  it("list_crm_contacts scopes to the org and excludes archived", async () => {
    const tools = collectTools();
    vi.mocked(db.crmContact.findMany).mockResolvedValue([] as never);

    const res = await tools.get("list_crm_contacts")!({});

    expect(res.isError).toBeUndefined();
    expect(db.crmContact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG, archivedAt: null }),
      }),
    );
  });

  it("get_crm_company binds the account read to the injected org (unknown id → error, not another org's row)", async () => {
    const tools = collectTools();
    vi.mocked(db.crmCompany.findFirst).mockResolvedValue(null as never);

    const res = await tools.get("get_crm_company")!({ companyId: "c-someone-elses" });

    expect(res.isError).toBe(true);
    expect(db.crmCompany.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "c-someone-elses", organizationId: ORG }) }),
    );
  });

  it("create_crm_contact refuses an owner email outside the org (owner lookup is org-bound, no contact created)", async () => {
    const tools = collectTools();
    vi.mocked(db.user.findFirst).mockResolvedValue(null as never); // not in THIS org

    const res = await tools.get("create_crm_contact")!({
      firstName: "Sara",
      lastName: "Khan",
      email: "sara@abbott.com",
      ownerEmail: "outsider@evil.com",
    });

    expect(res.isError).toBe(true);
    expect(db.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: ORG }) }),
    );
    expect(db.crmContact.create).not.toHaveBeenCalled();
  });
});

describe("get_crm_report — groupBy breakdown", () => {
  it("adds a breakdown by the requested dimension, read org-bound", async () => {
    const tools = collectTools();
    vi.mocked(db.crmPipelineStage.findMany).mockResolvedValue([
      { id: "s1", name: "New", isTerminal: false, sortOrder: 0 },
    ] as never);
    vi.mocked(db.crmDeal.groupBy).mockResolvedValue([] as never);
    vi.mocked(db.user.findMany).mockResolvedValue([] as never);
    vi.mocked(db.crmDeal.findMany).mockResolvedValue([
      { status: "OPEN", currency: "USD", dealValue: 1200, pipeline: "CORPORATE", ownerId: null, eventId: null, dealTypeId: null, lostReason: null, expectedClose: null, wonAt: null, lostAt: null },
      { status: "WON", currency: "USD", dealValue: 800, pipeline: "CONFERENCE", ownerId: null, eventId: null, dealTypeId: null, lostReason: null, expectedClose: null, wonAt: new Date("2026-08-01T00:00:00Z"), lostAt: null },
    ] as never);

    const res = await tools.get("get_crm_report")!({ groupBy: "pipeline" });
    const text = res.content[0]!.text;
    expect(res.isError).toBeUndefined();
    expect(text).toContain("By pipeline:");
    expect(text).toContain("Corporate: 1 deal(s)");
    expect(text).toContain("Conference: 1 deal(s)");
    // The breakdown read is bound to the INJECTED organization, like every other read.
    expect(db.crmDeal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: ORG }) }),
    );
  });

  it("prints no breakdown when none was asked for", async () => {
    const tools = collectTools();
    vi.mocked(db.crmPipelineStage.findMany).mockResolvedValue([
      { id: "s1", name: "New", isTerminal: false, sortOrder: 0 },
    ] as never);
    vi.mocked(db.crmDeal.groupBy).mockResolvedValue([] as never);
    vi.mocked(db.user.findMany).mockResolvedValue([] as never);
    const res = await tools.get("get_crm_report")!({});
    expect(res.content[0]!.text).not.toContain("By ");
    expect(db.crmDeal.findMany).not.toHaveBeenCalled();
  });
});

describe("the MCP placeholder user is never written as an owner (review of 8553d424)", () => {
  // API-key and OAuth MCP calls run as "mcp-remote", which is not a User row;
  // writing it into ownerId broke the User foreign key and failed every create.
  it("create_crm_company over MCP stores no owner; a signed-in user owns it", async () => {
    vi.mocked(db.crmCompany.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.crmCompany.findMany).mockResolvedValue([] as never);
    vi.mocked(db.crmCompany.create).mockResolvedValue({ id: "c-1", name: "Abbott", needsReview: false } as never);

    const res = await collectTools("mcp-remote").get("create_crm_company")!({ name: "Abbott" });
    expect(res.isError).toBeUndefined();
    expect(vi.mocked(db.crmCompany.create).mock.calls[0]![0]).toMatchObject({ data: { ownerId: null } });

    await collectTools("u-real").get("create_crm_company")!({ name: "Pfizer" });
    expect(vi.mocked(db.crmCompany.create).mock.calls[1]![0]).toMatchObject({ data: { ownerId: "u-real" } });
  });

  it("create_crm_contact over MCP without an ownerEmail stores no owner", async () => {
    vi.mocked(db.crmContact.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.crmContact.create).mockResolvedValue({ id: "ct-1", firstName: "Sara", lastName: "Khan" } as never);

    await collectTools("mcp-remote").get("create_crm_contact")!({
      firstName: "Sara", lastName: "Khan", email: "sara@abbott.com",
    });
    const call = vi.mocked(db.crmContact.create).mock.calls[0]![0] as { data: { ownerId: string | null } };
    expect(call.data.ownerId).toBeNull();
  });
});


describe("corporate projects (review of e92d660f: the new tools had no behavioural test)", () => {
  const STAGES = [{ id: "s-1", name: "Lead", order: 0, isTerminal: false, terminalStatus: null }];
  const PROJECT = {
    id: "p-1", name: "Novartis Ad Board", startDate: new Date("2027-03-01T00:00:00.000Z"), endDate: new Date("2027-03-02T00:00:00.000Z"),
    location: "Dubai, UAE", archivedAt: null, eventId: null, event: null,
  };
  const DEAL_ROW = {
    id: "d-1", name: "Novartis deal", status: "OPEN", pipeline: "CORPORATE", tags: [], dealValue: 15000, currency: "USD",
    expectedClose: null, lostReason: null, archivedAt: null, dealType: null, stage: { name: "Lead" }, company: null, event: null, owner: null,
  };

  it("list_crm_deals says which corporate project a deal is on, with its days and place", async () => {
    vi.mocked(db.crmDeal.findMany).mockResolvedValue([{ ...DEAL_ROW, project: PROJECT }] as never);

    const res = await collectTools().get("list_crm_deals")!({ projectId: "p-1" });
    const text = res.content[0]!.text;

    expect(text).toContain("Corporate project: Novartis Ad Board (p-1)");
    expect(text).toContain("Project dates: 2027-03-01 to 2027-03-02");
    expect(text).toContain("Project location: Dubai, UAE");
    expect(text).not.toContain("Counts under the event");
    const where = vi.mocked(db.crmDeal.findMany).mock.calls[0]![0]!.where as Record<string, unknown>;
    expect(where).toMatchObject({ organizationId: ORG, projectId: "p-1" });
  });

  it("list_crm_deals explains a linked project's deal turning up under an event filter", async () => {
    const linked = { ...PROJECT, eventId: "e-1", event: { id: "e-1", name: "BRIDGES 2027" } };
    vi.mocked(db.crmDeal.findMany).mockResolvedValue([{ ...DEAL_ROW, project: linked }] as never);

    const res = await collectTools().get("list_crm_deals")!({ eventId: "e-1" });

    expect(res.content[0]!.text).toContain("Counts under the event: BRIDGES 2027 (e-1)");
  });

  it("get_crm_deal names the project, and marks an archived one", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ ...DEAL_ROW, project: { ...PROJECT, archivedAt: new Date() } } as never);
    vi.mocked(db.crmDealProduct.findMany).mockResolvedValue([] as never);
    vi.mocked(db.crmDealContact.findMany).mockResolvedValue([] as never);
    vi.mocked(db.crmNote.findMany).mockResolvedValue([] as never);
    vi.mocked(db.crmTask.findMany).mockResolvedValue([] as never);

    const res = await collectTools().get("get_crm_deal")!({ dealId: "d-1" });

    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain("Corporate project: Novartis Ad Board (p-1) [archived]");
  });

  it("get_crm_report says when it was narrowed to one corporate project", async () => {
    vi.mocked(db.crmPipelineStage.findMany).mockResolvedValue(STAGES as never);
    vi.mocked(db.crmDeal.groupBy).mockResolvedValue([] as never);
    vi.mocked(db.crmDeal.findMany).mockResolvedValue([] as never);
    vi.mocked(db.user.findMany).mockResolvedValue([] as never);

    const res = await collectTools().get("get_crm_report")!({ projectId: "p-1" });

    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain("Pipeline (filtered to one corporate project):");
  });

  it("list_crm_projects reads the injected organisation's live projects", async () => {
    vi.mocked(db.crmProject.findMany).mockResolvedValue([
      {
        ...PROJECT, createdAt: new Date(), company: { id: "c-1", name: "Novartis" }, owner: null,
        deals: [{ status: "OPEN", dealValue: 15000, currency: "USD" }, { status: "WON", dealValue: 5000, currency: "USD" }],
      },
    ] as never);

    const res = await collectTools().get("list_crm_projects")!({});
    const text = res.content[0]!.text;

    expect(vi.mocked(db.crmProject.findMany).mock.calls[0]![0]!.where).toMatchObject({ organizationId: ORG, archivedAt: null });
    expect(text).toContain("Novartis Ad Board");
    expect(text).toContain("ID: p-1 | Client: Novartis | 2027-03-01 to 2027-03-02 | Dubai, UAE");
    expect(text).toContain("Deals: 2 (1 open, 1 won)");
    expect(text).toContain("Value:");
  });

  it("list_crm_projects prints no money for a caller who may not see deal values", async () => {
    vi.mocked(db.crmProject.findMany).mockResolvedValue([
      { ...PROJECT, createdAt: new Date(), company: null, owner: null, deals: [{ status: "OPEN", dealValue: 15000, currency: "USD" }] },
    ] as never);
    const tools = new Map<string, ToolFn>();
    const server = { tool: (name: string, _d: string, _s: unknown, fn: ToolFn) => void tools.set(name, fn) };
    // Holds crm.read and nothing else.
    const principal = { userId: "u-1", baseRole: "MEMBER", organizationId: ORG, fromApiKey: false, grants: [{ permission: "crm.read" }], personGrants: {} };
    registerCrmMcpTools(server as never, ORG, "u-1", { role: "MEMBER", fromApiKey: false, principal: principal as never });
    // Only meaningful if this caller really is refused the values.
    const list = tools.get("list_crm_projects");
    if (!list) throw new Error("the caller should hold crm.read");

    const text = (await list({})).content[0]!.text;

    expect(text).toContain("Deals: 1 (1 open, 0 won)");
    expect(text).not.toContain("Value:");
    expect(text).not.toMatch(/15[,.]?000/);
    // A caller without crm.write is not offered the write tool at all.
    expect(tools.has("create_crm_project")).toBe(false);
  });

  it("create_crm_project refuses a taken name and hands back the id that holds it", async () => {
    vi.mocked(db.crmProject.findFirst).mockResolvedValue({ id: "p-1" } as never);

    const res = await collectTools().get("create_crm_project")!({ name: "  novartis   ad board " });

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("(ID: p-1)");
    expect(vi.mocked(db.crmProject.findFirst).mock.calls[0]![0]!.where).toMatchObject({ organizationId: ORG, nameKey: "novartis ad board" });
    expect(db.crmProject.create).not.toHaveBeenCalled();
  });

  it("create_crm_project refuses a day that does not exist, before anything is written", async () => {
    const res = await collectTools().get("create_crm_project")!({ name: "X", startDate: "2027-02-31" });

    expect(res.isError).toBe(true);
    expect(db.crmProject.findFirst).not.toHaveBeenCalled();
    expect(db.crmProject.create).not.toHaveBeenCalled();
  });

  it("create_crm_project stores the days as calendar days", async () => {
    vi.mocked(db.crmProject.findFirst).mockResolvedValue(null as never);
    vi.mocked(db.crmProject.create).mockResolvedValue({ id: "p-2", name: "Ad Board", eventId: null } as never);

    const res = await collectTools().get("create_crm_project")!({ name: "Ad Board", startDate: "2027-03-01", endDate: "2027-03-02" });

    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain("ID: p-2");
    const data = vi.mocked(db.crmProject.create).mock.calls[0]![0]!.data as { startDate: Date; endDate: Date; organizationId: string };
    expect(data.organizationId).toBe(ORG);
    expect(data.startDate.toISOString()).toBe("2027-03-01T00:00:00.000Z");
    expect(data.endDate.toISOString()).toBe("2027-03-02T00:00:00.000Z");
  });

  it("create_crm_deal refuses an event AND a project, and writes nothing", async () => {
    vi.mocked(db.crmPipelineStage.findMany).mockResolvedValue(STAGES as never);

    const res = await collectTools().get("create_crm_deal")!({ name: "X", eventId: "e-1", projectId: "p-1" });

    expect(res.isError).toBe(true);
    expect(db.crmDeal.create).not.toHaveBeenCalled();
  });

  it("create_crm_deal refuses neither", async () => {
    vi.mocked(db.crmPipelineStage.findMany).mockResolvedValue(STAGES as never);

    const res = await collectTools().get("create_crm_deal")!({ name: "X" });

    expect(res.isError).toBe(true);
    expect(db.crmDeal.create).not.toHaveBeenCalled();
  });

  it("create_crm_deal looks the project up in the injected organisation, and refuses an archived one", async () => {
    vi.mocked(db.crmPipelineStage.findMany).mockResolvedValue(STAGES as never);
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue(STAGES[0] as never);
    vi.mocked(db.crmProject.findFirst).mockResolvedValue({ id: "p-1", archivedAt: new Date() } as never);

    const res = await collectTools().get("create_crm_deal")!({ name: "X", projectId: "p-1" });

    expect(res.isError).toBe(true);
    expect(vi.mocked(db.crmProject.findFirst).mock.calls[0]![0]!.where).toMatchObject({ id: "p-1", organizationId: ORG });
    expect(db.crmDeal.create).not.toHaveBeenCalled();
  });

  it("create_crm_deal on a project writes the project and no event", async () => {
    vi.mocked(db.crmPipelineStage.findMany).mockResolvedValue(STAGES as never);
    vi.mocked(db.crmPipelineStage.findFirst).mockResolvedValue(STAGES[0] as never);
    vi.mocked(db.crmProject.findFirst).mockResolvedValue({ id: "p-1", archivedAt: null } as never);
    vi.mocked(db.crmDeal.create).mockResolvedValue({
      id: "d-9", name: "X", pipeline: null, tags: [], dealValue: null, currency: "USD", ownerId: null, stageId: "s-1",
    } as never);

    const res = await collectTools().get("create_crm_deal")!({ name: "X", projectId: "p-1" });

    expect(res.isError).toBeUndefined();
    const data = vi.mocked(db.crmDeal.create).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(data).toMatchObject({ organizationId: ORG, projectId: "p-1", eventId: null });
  });
});
