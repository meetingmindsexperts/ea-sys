/**
 * How custom-role changes read on the Activity page (plan §6).
 *
 * Without a describer these rows render as "CREATE PermissionSet" — the name
 * of a database table rather than a sentence an administrator can act on. The
 * load-bearing case is the last one: a role ASSIGNMENT is recorded on the
 * person, so it arrives as a User update and must not swallow the wording of
 * every ordinary user edit.
 */
import { describe, it, expect } from "vitest";
import { Activity } from "lucide-react";
import { auditEntityIcon, describeAuditAction, type AuditLogLike } from "@/components/activity/audit-log-display";

const row = (over: Partial<AuditLogLike>): AuditLogLike => ({
  action: "UPDATE",
  entityType: "PermissionSet",
  entityId: "s1",
  changes: {},
  user: null,
  ...over,
});

describe("role rows", () => {
  it("names a created role", () => {
    expect(describeAuditAction(row({ action: "CREATE", changes: { name: "PO Author" } }))).toBe("Role created: PO Author");
  });

  it("tells archiving and restoring apart", () => {
    // `archived: false` is a restore, not an absent field: reading it as falsy
    // would report every restore as an ordinary edit.
    expect(describeAuditAction(row({ changes: { name: "PO Author", archived: true } }))).toBe("Role archived: PO Author");
    expect(describeAuditAction(row({ changes: { name: "PO Author", archived: false } }))).toBe("Role restored: PO Author");
  });

  it("reports how many permissions a role ended up with", () => {
    expect(
      describeAuditAction(row({ changes: { name: "Requester", permissionsAfter: ["a", "b", "c"] } })),
    ).toBe("Role permissions changed: Requester (3 permissions)");
  });

  it("says just updated when only the name or description moved", () => {
    expect(describeAuditAction(row({ changes: { name: "Requester" } }))).toBe("Role updated: Requester");
  });

  it("falls back to a word rather than blank when the payload has no name", () => {
    expect(describeAuditAction(row({ action: "CREATE", changes: {} }))).toBe("Role created: role");
  });

  it("carries its own icon, not the generic activity glyph", () => {
    expect(auditEntityIcon("PermissionSet")).not.toBe(Activity);
  });
});

describe("assignment rows, which land on the person", () => {
  it("counts what moved and what the person now holds", () => {
    expect(
      describeAuditAction(
        row({
          entityType: "User",
          changes: {
            permissionSetsBefore: ["a", "b"],
            permissionSetsAfter: ["b", "c"],
            permissionSetsAdded: ["c"],
            permissionSetsRemoved: ["a"],
          },
        }),
      ),
    ).toBe("Roles changed: 1 added, 1 removed (now holds 2)");
  });

  it("says so when a save changed nothing", () => {
    expect(
      describeAuditAction(
        row({
          entityType: "User",
          changes: { permissionSetsAfter: ["a"], permissionSetsAdded: [], permissionSetsRemoved: [] },
        }),
      ),
    ).toBe("Roles reviewed, no change");
  });

  it("DOES NOT HIJACK an ordinary user edit", () => {
    // Guarded on the payload rather than on the entity type, or every role
    // change, deactivation and rename would read as a roles change.
    expect(describeAuditAction(row({ entityType: "User", changes: { role: "ADMIN", previousRole: "MEMBER" } }))).toBe(
      "User updated",
    );
  });
});
