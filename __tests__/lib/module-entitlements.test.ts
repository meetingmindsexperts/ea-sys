/**
 * Per-organisation module entitlements (Nov 6, 2026; CRM product review P1-5).
 * An organisation must HAVE the CRM before any permission matters; the answer
 * fails closed, is cached briefly, and the CRM's route gate, MCP tools and
 * operator switch all follow it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { organization: { findUnique } } }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { forgetOrgModules, isOrgModule, orgHasModule, orgModuleState } from "@/lib/module-entitlements";

beforeEach(() => {
  vi.clearAllMocks();
  forgetOrgModules();
});

describe("orgHasModule", () => {
  it("answers from the organisation's enabledModules", async () => {
    findUnique.mockResolvedValueOnce({ enabledModules: ["crm"] });
    expect(await orgHasModule("org-a", "crm")).toBe(true);
    findUnique.mockResolvedValueOnce({ enabledModules: [] });
    expect(await orgHasModule("org-b", "crm")).toBe(false);
  });

  it("fails closed for an unknown organisation and on a read error", async () => {
    findUnique.mockResolvedValueOnce(null);
    expect(await orgHasModule("org-x", "crm")).toBe(false);
    findUnique.mockRejectedValueOnce(new Error("pool exhausted"));
    expect(await orgHasModule("org-y", "crm")).toBe(false);
  });

  it("caches the answer, and forgets it on request", async () => {
    findUnique.mockResolvedValue({ enabledModules: ["crm"] });
    await orgHasModule("org-a", "crm");
    await orgHasModule("org-a", "crm");
    expect(findUnique).toHaveBeenCalledTimes(1);
    forgetOrgModules("org-a");
    findUnique.mockResolvedValue({ enabledModules: [] });
    expect(await orgHasModule("org-a", "crm")).toBe(false);
  });

  it("does not cache a failed read as an answer", async () => {
    findUnique.mockRejectedValueOnce(new Error("blip"));
    expect(await orgHasModule("org-a", "crm")).toBe(false);
    findUnique.mockResolvedValueOnce({ enabledModules: ["crm"] });
    expect(await orgHasModule("org-a", "crm")).toBe(true);
  });

  it("tells 'off' apart from 'could not tell'", async () => {
    findUnique.mockResolvedValueOnce({ enabledModules: [] });
    expect(await orgModuleState("org-a", "crm")).toBe("off");
    findUnique.mockRejectedValueOnce(new Error("failover"));
    expect(await orgModuleState("org-b", "crm")).toBe("unknown");
  });

  it("knows only the modules it names", () => {
    expect(isOrgModule("crm")).toBe(true);
    expect(isOrgModule("hr")).toBe(false);
  });
});
