/** Who the Activity timeline says performed an audited action. */
import { describe, it, expect } from "vitest";
import { auditActorLabel } from "@/components/activity/audit-log-display";

const row = (over: Record<string, unknown>) => ({ user: null, changes: {}, ...over }) as never;

describe("auditActorLabel", () => {
  it("names the staff member when there is one", () => {
    expect(auditActorLabel(row({ user: { firstName: "Alex", lastName: "Admin", email: "a@x" } }))).toBe("Alex Admin");
  });
  it("says Public Registration for the public form", () => {
    expect(auditActorLabel(row({ changes: { source: "public_registration" } }))).toBe("Public Registration");
  });
  it("says Presenter sign-up for the public presenter door (Sep 28, 2026), not System", () => {
    expect(auditActorLabel(row({ changes: { source: "api", createdSource: "PUBLIC_SUBMITTER" } }))).toBe("Presenter sign-up");
  });
  it("falls back to System, including when changes is null", () => {
    expect(auditActorLabel(row({ changes: { source: "api" } }))).toBe("System");
    expect(auditActorLabel(row({ changes: null }))).toBe("System");
  });
});
