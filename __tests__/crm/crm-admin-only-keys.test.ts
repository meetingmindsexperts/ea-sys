/**
 * The two CRM keys only an admin holds by role (owner, Nov 12, 2026):
 * `crm.products.manage` (the product catalogue) and `crm.reports.view`
 * (Reports).
 *
 *                     catalogue   reports   put a product on a deal
 *   SUPER_ADMIN/ADMIN     yes        yes         yes
 *   CRM_USER              no         no          yes   <- the row this exists for
 *   ORGANIZER/MEMBER      no         no          no    (a custom role adds any of them)
 *   API key (full)        yes        yes         yes   (only an admin issues one)
 *
 * Three things are pinned here that a role table alone does not:
 *  1. every handler under /api/crm/products that changes the catalogue ASKS the
 *     key (read from source: the failure is a missing line), and the report
 *     route asks its own;
 *  2. CRM Home's totals door (/api/crm/reports/headline) is on the read gate
 *     alone and returns the two totals and nothing else;
 *  3. the assistant's tools follow the same keys, so a salesperson's tool list
 *     has no create or update product and no report.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/module-entitlements", () => ({ orgHasModule: vi.fn(async () => true), orgModuleState: vi.fn(async () => "on"), forgetOrgModules: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => {
  const db = {
    crmPipelineStage: { findMany: vi.fn(), createMany: vi.fn() },
    crmDeal: { groupBy: vi.fn(), findMany: vi.fn() },
    crmDealType: { findMany: vi.fn() },
    crmProject: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    event: { findMany: vi.fn() },
  };
  return { db, dbOperator: {}, tenantTransaction: (fn: (tx: typeof db) => unknown) => fn(db) };
});

import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyCrmProductsManage, denyCrmReports } from "@/crm/lib/crm-visibility";
import { can, principalFromUser } from "@/lib/permissions/can";
import type { PermissionKey } from "@/lib/permissions/catalogue";
import { TOOL_PERMISSIONS } from "@/lib/permissions/tool-permissions";
import { buildCrmReport, buildCrmReportHeadline } from "@/crm/services/report-service";
import { registerCrmMcpTools } from "@/crm/agent-tools";
import { registerAllMcpTools } from "@/lib/agent/register-mcp-tools";
import { gateMcpServerForKey } from "@/lib/agent/mcp-key-gate";
import { principalFromApiKey } from "@/lib/permissions/require-permission";

const ORG = "org-1";
const ctx = (role: string | null, fromApiKey = false, customGrants?: PermissionKey[]) => ({
  organizationId: ORG,
  role,
  userId: role ? `u-${role}` : null,
  fromApiKey,
  customGrants,
});

beforeEach(() => vi.clearAllMocks());

describe.each([
  ["denyCrmProductsManage", denyCrmProductsManage, "crm.products.manage", "CRM_PRODUCTS_FORBIDDEN", "auth-guard:crm-products-manage-denied"],
  ["denyCrmReports", denyCrmReports, "crm.reports.view", "CRM_REPORTS_FORBIDDEN", "auth-guard:crm-reports-denied"],
] as const)("%s", (_name, deny, key, code, logMsg) => {
  it("lets SUPER_ADMIN, ADMIN and a full API key through, without a log line", () => {
    expect(deny(ctx("SUPER_ADMIN"))).toBeNull();
    expect(deny(ctx("ADMIN"))).toBeNull();
    expect(deny(ctx(null, true))).toBeNull();
    expect(apiLogger.warn).not.toHaveBeenCalled();
  });

  it("REFUSES CRM_USER, who holds every other everyday CRM key, with a code and a logged refusal", async () => {
    const res = deny(ctx("CRM_USER"));
    expect(res?.status).toBe(403);
    await expect(res!.json()).resolves.toMatchObject({ code });
    expect(apiLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: logMsg, role: "CRM_USER", userId: "u-CRM_USER" }));
  });

  it("refuses ORGANIZER, MEMBER and every role outside the CRM", () => {
    for (const role of ["ORGANIZER", "MEMBER", "ONSITE", "HR_USER", "BASE", "REVIEWER", "SUBMITTER", "REGISTRANT", "WHATEVER", null]) {
      expect(deny(ctx(role))?.status, String(role)).toBe(403);
    }
  });

  it("is granted by a custom role and by nothing else that role holds", () => {
    // A sales lead: CRM_USER plus a custom role carrying only this key.
    expect(deny(ctx("CRM_USER", false, [key]))).toBeNull();
    // The everyday keys are not this key, however many of them a role carries.
    expect(deny(ctx("ORGANIZER", false, ["crm.read", "crm.write", "crm.delete", "crm.dealValues.view"]))?.status).toBe(403);
  });
});

describe("the two keys are separate, and neither is the write key", () => {
  it("one does not carry the other", () => {
    const catalogue = principalFromUser({ id: "u", role: "CRM_USER", organizationId: ORG, procurementPermissions: ["crm.products.manage"] });
    expect(can(catalogue, "crm.products.manage")).toBe(true);
    expect(can(catalogue, "crm.reports.view")).toBe(false);
    const reports = principalFromUser({ id: "u", role: "CRM_USER", organizationId: ORG, procurementPermissions: ["crm.reports.view"] });
    expect(can(reports, "crm.reports.view")).toBe(true);
    expect(can(reports, "crm.products.manage")).toBe(false);
  });

  it("the tool map asks them: the catalogue tools and the report, and NOT putting a product on a deal", () => {
    expect(TOOL_PERMISSIONS.create_crm_product).toBe("crm.products.manage");
    expect(TOOL_PERMISSIONS.update_crm_product).toBe("crm.products.manage");
    expect(TOOL_PERMISSIONS.get_crm_report).toBe("crm.reports.view");
    expect(TOOL_PERMISSIONS.list_crm_products).toBe("crm.read");
    expect(TOOL_PERMISSIONS.add_deal_product).toBe("crm.write");
    expect(TOOL_PERMISSIONS.update_deal_product).toBe("crm.write");
  });
});

// ── 1. every handler asks (source) ───────────────────────────────────────────

const API = join(process.cwd(), "src/app/api/crm");

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

/** Source with its comments removed, so a commented-out guard does not count as one. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The body of one exported handler: from its `export async function` to the next one (or the end). */
function handlers(file: string): Array<{ method: string; body: string }> {
  const source = code(file);
  const starts = [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)];
  return starts.map((m, i) => ({ method: m[1]!, body: source.slice(m.index!, starts[i + 1]?.index ?? source.length) }));
}

/** The guard is CALLED and its refusal RETURNED: `const denied = guard(ctx); if (denied) return denied;`. */
const asksAndReturns = (guard: string) => new RegExp(`const denied = ${guard}\\(ctx\\);\\s*if \\(denied\\) return denied;`);

/** Every .ts / .tsx file under a directory. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("every handler that changes the product catalogue asks crm.products.manage", () => {
  const files = routeFiles(join(API, "products"));
  const mutating = files.flatMap((file) =>
    handlers(file)
      .filter((h) => h.method !== "GET")
      .map((h) => [`${h.method} ${file.slice(file.indexOf("src/app/api/"))}`, h.body] as const),
  );

  it("finds them (not testing nothing)", () => {
    // create; edit + archive; link to QuickBooks.
    expect(mutating.length).toBeGreaterThanOrEqual(4);
  });

  it.each(mutating)("%s", (_label, body) => {
    expect(body).toContain("requireCrmWrite(req)");
    expect(body).toMatch(asksAndReturns("denyCrmProductsManage"));
    // Asked BEFORE the body is read or a service is called.
    expect(body.indexOf("denyCrmProductsManage(ctx)")).toBeLessThan(body.indexOf("runWithTenant"));
  });

  it("no product or report handler is exported in a form this test cannot see", () => {
    for (const file of [...files, ...routeFiles(join(API, "reports"))]) {
      expect(code(file), file).not.toMatch(/export (const|let|var) (GET|POST|PUT|PATCH|DELETE)\b/);
      expect(code(file), file).not.toMatch(/export \{[^}]*\b(GET|POST|PUT|PATCH|DELETE)\b/);
    }
  });

  /**
   * The walk above sees only /api/crm/products. A catalogue write born
   * anywhere else (an import route, a worker job, a new tool file) would be
   * unseen, so every file that calls a catalogue write is LISTED: a new one
   * fails here until it is added, which is the moment to give it the key.
   */
  it("the files that write the catalogue are exactly the gated ones", () => {
    const WRITES = /\b(createCrmProduct|updateCrmProduct|setCrmProductArchived|linkProductToItem)\(|crmProduct\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/;
    const root = process.cwd();
    const found = ["src", "worker", "scripts"]
      .flatMap((d) => sourceFiles(join(root, d)))
      .filter((f) => WRITES.test(code(f)))
      .map((f) => f.slice(root.length + 1))
      .sort();
    expect(found).toEqual([
      "src/app/api/crm/products/[productId]/quickbooks/route.ts", // asks the key (above)
      "src/app/api/crm/products/[productId]/route.ts", // asks the key (above)
      "src/app/api/crm/products/route.ts", // asks the key (above)
      "src/crm/agent-tools.ts", // the catalogue tools, on catalogueServer (below)
      "src/crm/services/crm-product-service.ts", // the service; also the first-use seed of the built-in list
      "src/crm/services/crm-quickbooks-service.ts", // linkProductToItem, called by the quickbooks route
    ]);
  });

  it("and reading the catalogue stays on the read gate: the sales team picks products for deals", () => {
    const list = handlers(join(API, "products/route.ts")).find((h) => h.method === "GET")!;
    expect(list.body).toContain("requireCrmRead(req)");
    expect(list.body).not.toContain("denyCrmProductsManage");
  });
});

describe("the report route asks crm.reports.view, and Home's totals door does not", () => {
  it("GET /api/crm/reports asks it before anything is built", () => {
    const [get] = handlers(join(API, "reports/route.ts"));
    expect(get!.body).toMatch(asksAndReturns("denyCrmReports"));
    expect(get!.body.indexOf("denyCrmReports(ctx)")).toBeLessThan(get!.body.indexOf("buildCrmReport("));
  });

  it("GET /api/crm/reports/headline is on the read gate alone and builds only the headline", () => {
    const source = code(join(API, "reports/headline/route.ts"));
    expect(source).toContain("requireCrmRead(req)");
    expect(source).not.toContain("denyCrmReports");
    expect(source).toContain("buildCrmReportHeadline(");
    expect(source).not.toMatch(/buildCrmReport\(/);
    // No filter and no dimension can be passed in: it reads nothing from the URL.
    expect(source).not.toContain("searchParams");
  });

  it("every other route under /api/crm/reports asks the key (a new report door must not be born open)", () => {
    const others = routeFiles(join(API, "reports")).filter((f) => !f.endsWith("reports/headline/route.ts"));
    expect(others.length).toBeGreaterThanOrEqual(1);
    // Per HANDLER, not per file: a second handler in a guarded file must ask too.
    for (const file of others) {
      for (const h of handlers(file)) expect(h.body, `${h.method} ${file}`).toMatch(asksAndReturns("denyCrmReports"));
    }
  });
});

// ── 2. the headline is the two totals and nothing else ───────────────────────

describe("buildCrmReportHeadline", () => {
  beforeEach(() => {
    vi.mocked(db.crmPipelineStage.findMany).mockResolvedValue([
      { id: "s1", name: "New", isTerminal: false },
      { id: "s2", name: "Won", isTerminal: true },
    ] as never);
    vi.mocked(db.user.findMany).mockResolvedValue([{ id: "u1", firstName: "Ada", lastName: "Lovelace" }] as never);
    vi.mocked(db.crmDeal.groupBy).mockImplementation(((args: { by: string[]; where: { status?: string } }) => {
      if (args.by.includes("stageId")) {
        return Promise.resolve([
          { stageId: "s1", currency: "AED", _count: { _all: 3 }, _sum: { dealValue: 900 } },
          { stageId: "s2", currency: "AED", _count: { _all: 2 }, _sum: { dealValue: 500 } },
        ]);
      }
      if (args.by.includes("ownerId")) {
        return Promise.resolve([{ ownerId: "u1", status: "OPEN", currency: "AED", _count: { _all: 3 }, _sum: { dealValue: 900 } }]);
      }
      const count = args.where.status === "WON" ? 2 : 6;
      return Promise.resolve([{ currency: "AED", _count: { _all: count }, _sum: { dealValue: count * 100 } }]);
    }) as never);
  });

  it("returns the open pipeline and the win rate, exactly as the report has them", async () => {
    const [headline, report] = await Promise.all([
      buildCrmReportHeadline({ organizationId: ORG, canSeeValues: true }),
      buildCrmReport({ organizationId: ORG, canSeeValues: true, filters: {} }),
    ]);
    expect(headline.pipeline).toEqual({ openCount: 3, openValue: 900, openCurrency: "AED", openMixed: false });
    expect(headline.winLoss).toEqual({ wonCount: 2, lostCount: 6, winRate: 25 });
    expect(headline.pipeline.openValue).toBe(report.pipeline.openValue);
    expect(headline.winLoss.winRate).toBe(report.winLoss.winRate);
  });

  it("carries NOTHING else: no stages, no won or lost values, no per-person results, no breakdown", async () => {
    const headline = await buildCrmReportHeadline({ organizationId: ORG, canSeeValues: true });
    expect(Object.keys(headline).sort()).toEqual(["pipeline", "winLoss"]);
    expect(Object.keys(headline.pipeline).sort()).toEqual(["openCount", "openCurrency", "openMixed", "openValue"]);
    expect(Object.keys(headline.winLoss).sort()).toEqual(["lostCount", "winRate", "wonCount"]);
    expect(JSON.stringify(headline)).not.toContain("Lovelace");
  });

  it("is over every live deal of the organisation: no filter reaches the query", async () => {
    await buildCrmReportHeadline({ organizationId: ORG, canSeeValues: true });
    for (const call of vi.mocked(db.crmDeal.groupBy).mock.calls) {
      const where = (call[0] as { where: Record<string, unknown> }).where;
      expect(Object.keys(where).filter((k) => k !== "status").sort()).toEqual(["archivedAt", "organizationId"]);
      expect(where).toMatchObject({ organizationId: ORG, archivedAt: null });
    }
  });

  it("hides the value, never the count, from a caller without deal values", async () => {
    const headline = await buildCrmReportHeadline({ organizationId: ORG, canSeeValues: false });
    expect(headline.pipeline.openValue).toBeNull();
    expect(headline.pipeline.openCount).toBe(3);
    expect(headline.winLoss.winRate).toBe(25);
  });
});

// ── 3. the assistant's tools ─────────────────────────────────────────────────

function toolNames(actor?: Parameters<typeof registerCrmMcpTools>[3]): string[] {
  const names: string[] = [];
  const server = { tool: (name: string) => void names.push(name) };
  registerCrmMcpTools(server as never, ORG, "u-1", actor);
  return names;
}

const CATALOGUE_TOOLS = ["create_crm_product", "update_crm_product"];

describe("the assistant's tools follow the two keys", () => {
  it("a salesperson has no catalogue tools and no report, and still lists products and puts them on deals", () => {
    const names = toolNames({ role: "CRM_USER", fromApiKey: false });
    for (const tool of [...CATALOGUE_TOOLS, "get_crm_report"]) expect(names, tool).not.toContain(tool);
    for (const tool of ["list_crm_products", "list_crm_deal_products", "add_deal_product", "update_deal_product", "create_crm_deal"]) {
      expect(names, tool).toContain(tool);
    }
  });

  it("an admin and a full API key have all three", () => {
    for (const actor of [{ role: "ADMIN", fromApiKey: false }, { role: null, fromApiKey: true }]) {
      const names = toolNames(actor);
      for (const tool of [...CATALOGUE_TOOLS, "get_crm_report"]) expect(names, `${actor.role}: ${tool}`).toContain(tool);
    }
  });

  it("a custom role adds each on its own", () => {
    const withKeys = (keys: PermissionKey[]) =>
      toolNames({
        role: "CRM_USER",
        fromApiKey: false,
        principal: principalFromUser({ id: "u-1", role: "CRM_USER", organizationId: ORG, procurementPermissions: keys }),
      });
    const catalogue = withKeys(["crm.products.manage"]);
    expect(catalogue).toEqual(expect.arrayContaining(CATALOGUE_TOOLS));
    expect(catalogue).not.toContain("get_crm_report");
    const reports = withKeys(["crm.reports.view"]);
    expect(reports).toContain("get_crm_report");
    expect(reports).not.toContain("create_crm_product");
  });

  it("in the source, every tool that writes the catalogue or builds the report is on its own registrar", () => {
    const source = code(join(process.cwd(), "src/crm/agent-tools.ts"));
    // One block per registration: from `<registrar>.tool(` to the next one.
    const blocks = source.split(/(?=\b\w+\.tool\(\s*")/).filter((b) => /^\w+\.tool\(/.test(b));
    expect(blocks.length).toBeGreaterThan(20);
    const registrarOf = (b: string) => b.slice(0, b.indexOf(".tool("));
    const catalogue = blocks.filter((b) => /\b(createCrmProduct|updateCrmProduct|setCrmProductArchived|linkProductToItem)\(/.test(b));
    expect(catalogue.length).toBe(2);
    for (const b of catalogue) expect(registrarOf(b), b.slice(0, 60)).toBe("catalogueServer");
    const report = blocks.filter((b) => /\bbuildCrmReport\(/.test(b));
    expect(report.length).toBe(1);
    expect(registrarOf(report[0]!)).toBe("reportServer");
  });

  it("the catalogue tools also need the write key: a reader with the catalogue key alone gets neither", () => {
    const principal = { userId: "u-1", baseRole: "MEMBER", organizationId: ORG, fromApiKey: false, grants: [{ permission: "crm.read" }, { permission: "crm.products.manage" }], personGrants: {} };
    const names = toolNames({ role: "MEMBER", fromApiKey: false, principal: principal as never });
    for (const tool of CATALOGUE_TOOLS) expect(names).not.toContain(tool);
    expect(names).toContain("list_crm_products");
  });
});

// ── an API key that acts with a role (review of 3f2959f5) ────────────────────

/**
 * The role-bound key door registers the CRM tools through `registerAllMcpTools`
 * behind `gateMcpServerForKey`, whose gate asks ONE key per tool. Until the
 * review the CRM registrations saw a full key there, so what a tool decides for
 * itself (the write key beside the catalogue key; whether money is printed)
 * was decided as an admin.
 */
describe("an API key that acts with a role is judged as that role by the CRM tools", () => {
  type Tool = (input: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;

  function keyTools(permissions: PermissionKey[]): Map<string, Tool> {
    const tools = new Map<string, Tool>();
    const server = { tool: (name: string, ...rest: unknown[]) => void tools.set(name, rest[rest.length - 1] as Tool), resource: vi.fn(), prompt: vi.fn() };
    const principal = principalFromApiKey(ORG, permissions.map((permission) => ({ permission })));
    registerAllMcpTools(gateMcpServerForKey(server as never, principal, ORG), ORG, { keyPrincipal: principal });
    return tools;
  }

  it("the catalogue key without the write key gets no catalogue tools, as the routes refuse it", () => {
    const names = [...keyTools(["crm.read", "crm.products.manage"]).keys()];
    expect(names).toContain("list_crm_products");
    for (const tool of CATALOGUE_TOOLS) expect(names, tool).not.toContain(tool);
  });

  it("with both keys it gets them, and still no report without the reports key", () => {
    const names = [...keyTools(["crm.read", "crm.write", "crm.products.manage"]).keys()];
    expect(names).toEqual(expect.arrayContaining(CATALOGUE_TOOLS));
    expect(names).not.toContain("get_crm_report");
  });

  it("a role without deal values gets the report's counts and none of its money", async () => {
    vi.mocked(db.crmPipelineStage.findMany).mockResolvedValue([
      { id: "s1", name: "New", isTerminal: false },
      { id: "s2", name: "Won", isTerminal: true },
    ] as never);
    vi.mocked(db.user.findMany).mockResolvedValue([] as never);
    vi.mocked(db.crmDeal.groupBy).mockImplementation(((args: { by: string[] }) =>
      Promise.resolve(args.by.includes("stageId") ? [{ stageId: "s1", currency: "AED", _count: { _all: 3 }, _sum: { dealValue: 480000 } }] : [])) as never);

    const blind = await keyTools(["crm.read", "crm.reports.view"]).get("get_crm_report")!({}, {});
    expect(blind.content[0]!.text).toContain("3 deal(s)");
    expect(blind.content[0]!.text).not.toContain("480");

    const sighted = await keyTools(["crm.read", "crm.reports.view", "crm.dealValues.view"]).get("get_crm_report")!({}, {});
    expect(sighted.content[0]!.text).toContain("480");
  });

  // list_crm_deals and get_crm_deal print a deal's value without asking
  // `crm.dealValues.view` at all, for every caller: an OLDER defect, recorded
  // in docs/ROADMAP.md (CRM corporate projects, Nov 12), not fixed here.
});
