/**
 * A History insert that fails (Oct 28, 2026): never throws into the caller,
 * whose write already committed, and logs who, what and which fields at
 * error (never the values) so the accepted loss can be rebuilt by hand.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => ({
  db: { crmActivity: { create: vi.fn() } },
}));

import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { recordCrmActivity } from "@/crm/lib/crm-activity";

describe("recordCrmActivity when the insert fails", () => {
  it("resolves (never throws) and logs the entry's identity and field names at error", async () => {
    vi.mocked(db.crmActivity.create).mockRejectedValue(new Error("connection reset"));
    const entry = {
      organizationId: "org-1",
      entityType: "DEAL" as const,
      entityId: "d-1",
      action: "UPDATE",
      actorId: "u-1",
      changes: { name: { from: "A", to: "B" } },
    };
    await expect(recordCrmActivity(entry)).resolves.toBeUndefined();
    const identity = { organizationId: entry.organizationId, entityType: entry.entityType, entityId: entry.entityId, action: entry.action, actorId: entry.actorId };
    expect(apiLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "crm-activity:record-failed", ...identity, changedFields: ["name"], err: "connection reset" }),
    );
    expect(JSON.stringify(vi.mocked(apiLogger.error).mock.calls)).not.toContain('"to":"B"');
  });
});
