/**
 * Oct 7, 2026: assigning a "Corporate" role to a person whose base role could
 * not hold it failed only after Save (409 OUTSIDE_AREAS). The dialog now
 * explains the misfit up front, using the same area rule as the server.
 */
import { describe, it, expect } from "vitest";
import { roleMisfit } from "@/components/settings/user-roles-dialog";

const corporate = [
  { permission: "events.update", scope: "ALL" as const },
  { permission: "registrations.read", scope: "ALL" as const },
  { permission: "contacts.read", scope: null },
];

describe("roleMisfit", () => {
  it("fits a Member or an Organizer base", () => {
    expect(roleMisfit("MEMBER", corporate)).toBeNull();
    expect(roleMisfit("ORGANIZER", corporate)).toBeNull();
  });

  it("explains why it does not fit an Onsite or a CRM user", () => {
    const onsite = roleMisfit("ONSITE", corporate);
    expect(onsite).toMatch(/^Doesn't fit an Onsite Staff base role: it adds /);
    expect(onsite).toContain("event management");
    expect(roleMisfit("CRM_USER", corporate)).toMatch(/event management/);
  });

  it("calls a wider scope in an area the role already has a wider scope, not a new area", () => {
    const deskAll = [{ permission: "registrations.read", scope: "ALL" as const }];
    expect(roleMisfit("ONSITE", deskAll)).toContain("the registration desk on every event, not only assigned ones");
  });

  it("agrees with the server's rule: a CRM key fits a CRM user", () => {
    expect(roleMisfit("CRM_USER", [{ permission: "crm.export", scope: null }])).toBeNull();
  });
});
