/**
 * The daily QuickBooks health sweep (September 22, 2026). A connection dies
 * quietly (an unused refresh token stops working after about 100 days), so
 * the sweep's job is to touch every connected organisation and record what
 * it found. One organisation's failure must never stop the others'.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDb, mockHealth, logger } = vi.hoisted(() => ({
  mockDb: { organization: { findMany: vi.fn() } },
  mockHealth: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/procurement/integrations/quickbooks/client", () => ({ runHealthCheck: mockHealth }));

import { runQuickBooksHealthTick } from "@/procurement/integrations/quickbooks/health-worker";

const connected = { realmId: "r", environment: "sandbox", accessTokenEncrypted: "a", refreshTokenEncrypted: "b" };

function sandboxEnv() {
  vi.stubEnv("PROCUREMENT_MODULE_ENABLED", "true");
  vi.stubEnv("QUICKBOOKS_SANDBOX_CLIENT_ID", "cid");
  vi.stubEnv("QUICKBOOKS_SANDBOX_CLIENT_SECRET", "csec");
  vi.stubEnv("QUICKBOOKS_SANDBOX_REDIRECT_URI", "https://x.test/cb");
  vi.stubEnv("QUICKBOOKS_ENVIRONMENT", "");
}

beforeEach(() => {
  vi.clearAllMocks();
  sandboxEnv();
  mockHealth.mockResolvedValue({ ok: true, data: { companyName: "Sandbox Co" } });
});
afterEach(() => vi.unstubAllEnvs());

describe("runQuickBooksHealthTick", () => {
  it("probes only the organisations that hold a connection", async () => {
    mockDb.organization.findMany.mockResolvedValue([
      { id: "org1", settings: { quickbooks: connected } },
      { id: "org2", settings: {} },
      { id: "org3", settings: null },
    ]);
    expect(await runQuickBooksHealthTick()).toEqual({ checked: 1, ok: 1, failed: 0 });
    expect(mockHealth).toHaveBeenCalledExactlyOnceWith("org1");
  });

  it("one organisation's failure does not stop the next one's check", async () => {
    mockDb.organization.findMany.mockResolvedValue([
      { id: "org1", settings: { quickbooks: connected } },
      { id: "org2", settings: { quickbooks: connected } },
      { id: "org3", settings: { quickbooks: connected } },
    ]);
    mockHealth.mockRejectedValueOnce(new Error("socket hang up"));
    mockHealth.mockResolvedValueOnce({ ok: false, code: "REFRESH_EXPIRED", message: "reconnect" });
    expect(await runQuickBooksHealthTick()).toEqual({ checked: 3, ok: 1, failed: 2 });
    expect(logger.error).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("is a no-op with no Intuit app or with the module switched off, and never queries", async () => {
    vi.stubEnv("QUICKBOOKS_SANDBOX_CLIENT_ID", "");
    expect(await runQuickBooksHealthTick()).toEqual({ checked: 0, ok: 0, failed: 0 });

    sandboxEnv();
    vi.stubEnv("PROCUREMENT_MODULE_ENABLED", "false");
    expect(await runQuickBooksHealthTick()).toEqual({ checked: 0, ok: 0, failed: 0 });

    expect(mockDb.organization.findMany).not.toHaveBeenCalled();
    expect(mockHealth).not.toHaveBeenCalled();
  });
});
