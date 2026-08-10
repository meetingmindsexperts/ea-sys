/**
 * The export gate's two bypasses (review H3, H4).
 *
 * The gate shipped with an explicit threat model: "walking out with that CSV is
 * the single most damaging thing a departing salesperson can do." Two paths went
 * around it.
 *
 * H3 — `GET /api/crm/deals` returned the same rows as JSON to a role refused the
 * export, INCLUDING every linked contact's email and job title, which the CSV
 * export does not carry at all. So the "boundary" gated the narrower artefact.
 *
 * H4 — `/mcp-authorize` admits ORGANIZER and `buildMcpServer` took only an org
 * id, so a role the gate refuses could approve its own consent screen and get
 * the full CRM tool set with `canSeeValues: true`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const recordExport = vi.fn();
vi.mock("@/lib/audit-data-transfer", () => ({ recordExport: (...a: unknown[]) => recordExport(...a) }));

vi.mock("@/lib/db", () => ({
  db: { crmDeal: { findMany: vi.fn(), count: vi.fn() } },
}));

const ctx = { organizationId: "org-1", userId: "u-1", role: "CRM_USER", fromApiKey: false };
vi.mock("@/crm/lib/crm-route", () => ({
  requireCrmRead: vi.fn(async () => ({ ctx })),
  redactForCaller: (x: unknown) => x,
  crmErrorResponse: vi.fn(),
}));

import { db } from "@/lib/db";
import { GET as listDeals } from "@/app/api/crm/deals/route";
import { CRM_BULK_READ_AUDIT_ROWS } from "@/crm/lib/list-caps";
import { registerCrmMcpTools } from "@/crm/agent-tools";

function seed(n: number, total = n) {
  vi.mocked(db.crmDeal.findMany).mockResolvedValue(
    Array.from({ length: n }, (_, i) => ({ id: `d-${i}` })) as never,
  );
  vi.mocked(db.crmDeal.count).mockResolvedValue(total as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  ctx.role = "CRM_USER";
  ctx.fromApiKey = false;
});

describe("H3 — the deals list is no longer a superset of the export", () => {
  it("does not select contact emails or job titles", async () => {
    seed(1);
    await listDeals(new Request("http://x/api/crm/deals"));
    const select = vi.mocked(db.crmDeal.findMany).mock.calls[0]![0]!.select as Record<string, unknown>;
    // The board renders none of it; carrying it made the ungated JSON list
    // strictly richer than the admin-only CSV.
    expect(select).not.toHaveProperty("contacts");
  });

  it("records a BULK read by a role that may not export", async () => {
    seed(CRM_BULK_READ_AUDIT_ROWS, 10_412);
    await listDeals(new Request("http://x/api/crm/deals"));
    expect(recordExport).toHaveBeenCalledTimes(1);
    expect(recordExport.mock.calls[0]![1]).toMatchObject({
      entityType: "CrmDeal",
      role: "CRM_USER",
      rowCount: CRM_BULK_READ_AUDIT_ROWS,
      format: "json",
    });
  });

  it("does NOT record ordinary filtered work — the audit log must stay readable", async () => {
    seed(CRM_BULK_READ_AUDIT_ROWS - 1);
    await listDeals(new Request("http://x/api/crm/deals?eventId=e-1"));
    expect(recordExport).not.toHaveBeenCalled();
  });

  it("does not record an ADMIN — they can export openly, and that path already audits", async () => {
    ctx.role = "ADMIN";
    seed(CRM_BULK_READ_AUDIT_ROWS, 10_412);
    await listDeals(new Request("http://x/api/crm/deals"));
    expect(recordExport).not.toHaveBeenCalled();
  });
});

// ── H4: the MCP tool surface follows the CALLER, not the org ────────────────

describe("H4 — CRM MCP registration is gated on the granting user's role", () => {
  /** A stand-in McpServer that just records which tools got registered. */
  function fakeServer() {
    const names: string[] = [];
    return {
      names,
      server: { tool: (name: string) => { names.push(name); } } as unknown as Parameters<typeof registerCrmMcpTools>[0],
    };
  }

  it("an API key keeps the FULL surface — admin-minted, and the default is unchanged", () => {
    const { names, server } = fakeServer();
    registerCrmMcpTools(server, "org-1", "sys"); // no actor ⇒ admin-equivalent
    expect(names).toContain("list_crm_deals");
    expect(names).toContain("create_crm_deal");
  });

  it("ORGANIZER keeps the CRM tools it legitimately has — the fix must not break event work", () => {
    const { names, server } = fakeServer();
    registerCrmMcpTools(server, "org-1", "sys", { role: "ORGANIZER", fromApiKey: false });
    // ORGANIZER can read and write the CRM in the app, so it should here too.
    // What it must NOT get is the admin-only export, which is not an MCP tool.
    expect(names).toContain("list_crm_deals");
    expect(names).toContain("create_crm_deal");
  });

  it("MEMBER gets the READ tools only — it may never move a card", () => {
    const { names, server } = fakeServer();
    registerCrmMcpTools(server, "org-1", "sys", { role: "MEMBER", fromApiKey: false });
    expect(names).toContain("list_crm_deals");
    expect(names).not.toContain("create_crm_deal");
    expect(names).not.toContain("close_crm_deal");
    expect(names).not.toContain("update_crm_company");
  });

  it("a role with no CRM access registers NOTHING — not even a read tool", () => {
    for (const role of ["ONSITE", "REVIEWER", "SUBMITTER", "REGISTRANT", "WEBINARS"]) {
      const { names, server } = fakeServer();
      registerCrmMcpTools(server, "org-1", "sys", { role, fromApiKey: false });
      expect(names, `${role} should see no CRM tools`).toHaveLength(0);
    }
  });

  it("fails closed on an unknown or absent role", () => {
    for (const role of [null, "WHATEVER"]) {
      const { names, server } = fakeServer();
      registerCrmMcpTools(server, "org-1", "sys", { role, fromApiKey: false });
      expect(names).toHaveLength(0);
    }
  });
});
