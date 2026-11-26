/**
 * Who sees the Overview's reminder to close registration (review of bd05639aa): whoever may change
 * the event's settings (`events.settings`), where the switch and the close date live.
 */
import { describe, expect, it } from "vitest";
import { principalFromUser, systemPrincipal } from "@/lib/permissions/can";
import type { Grant } from "@/lib/permissions/system-roles";
import { closeReminderFor } from "@/components/events/registration-close-reminder";

const ORG = "org-1";
const NOW = new Date("2026-11-26T08:00:00Z");
const EVENT = {
  organizationId: ORG,
  eventType: "CONFERENCE",
  status: "PUBLISHED",
  endDate: new Date("2027-01-23T14:00:00Z"),
  settings: {},
  staffUserIds: [] as string[],
};

const person = (role: string, organizationId: string | null = ORG) => principalFromUser({ id: "u-1", role, organizationId });
/** A Base-role person whose custom role holds exactly these grants. */
const custom = (customGrants: Grant[]) => systemPrincipal({ role: "BASE", organizationId: ORG, userId: "u-1", customGrants });

describe("closeReminderFor", () => {
  it("shows the note to admins and organisers, who can change the event's settings", () => {
    expect(closeReminderFor(person("ADMIN"), EVENT, NOW)).toBe("no-close-date");
    expect(closeReminderFor(person("ORGANIZER"), EVENT, NOW)).toBe("no-close-date");
  });

  it("hides it from roles that cannot make the fix", () => {
    for (const role of ["MEMBER", "ONSITE", "CRM_USER", "HR_USER", "BASE"]) {
      expect(closeReminderFor(person(role), EVENT, NOW)).toBeNull();
    }
    for (const role of ["REVIEWER", "SUBMITTER", "REGISTRANT"]) {
      expect(closeReminderFor(person(role, null), EVENT, NOW)).toBeNull();
    }
  });

  it("hides it from another organisation's admin", () => {
    expect(closeReminderFor(person("ADMIN", "org-2"), EVENT, NOW)).toBeNull();
  });

  it("still goes by the rule for someone who may see it", () => {
    expect(closeReminderFor(person("ADMIN"), { ...EVENT, eventType: "WEBINAR" }, NOW)).toBeNull();
    expect(closeReminderFor(person("ADMIN"), { ...EVENT, settings: { registrationClosesAt: "2027-01-10T05:00:00.000Z" } }, NOW)).toBeNull();
  });
});

describe("custom roles: the key is events.settings, not events.update (review of bd05639aa)", () => {
  it("a role that may edit the event but not its settings does not see it; one with settings does", () => {
    expect(closeReminderFor(custom([{ permission: "events.update", scope: "ALL" }]), EVENT, NOW)).toBeNull();
    expect(closeReminderFor(custom([{ permission: "events.settings", scope: "ALL" }]), EVENT, NOW)).toBe("no-close-date");
  });

  it("a grant scoped to assigned events counts on an event the person is assigned to, and only there", () => {
    const assigned = custom([{ permission: "events.settings", scope: "ASSIGNED" }]);
    expect(closeReminderFor(assigned, { ...EVENT, staffUserIds: ["u-1"] }, NOW)).toBe("no-close-date");
    expect(closeReminderFor(assigned, EVENT, NOW)).toBeNull();
  });
});
