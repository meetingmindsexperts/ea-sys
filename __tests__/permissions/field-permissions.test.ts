/**
 * Permissions that hang on what a request changes (owner, Oct 6, 2026): each
 * changed event field asks its own key, and a certificate or survey send asks
 * that operation's key beside the send key.
 */
import { describe, it, expect } from "vitest";
import {
  bulkEmailTypePermission,
  changedEventFields,
  eventFieldPermission,
  eventFieldPermissions,
  toolInputPermissions,
} from "@/lib/permissions/field-permissions";
import { gateToolCall } from "@/lib/agent/tool-gate";
import { can, principalFromUser, type Principal } from "@/lib/permissions/can";
import { SYSTEM_ROLES } from "@/lib/permissions/system-roles";

const conference = { organizationId: "org-1", eventType: "CONFERENCE", staffUserIds: [] };
const webinar = { organizationId: "org-1", eventType: "WEBINAR", staffUserIds: [] };

/** A principal holding exactly these keys at ALL, for the custom-role cases. */
function holding(...keys: string[]): Principal {
  const base = principalFromUser({ id: "u1", role: "MEMBER", organizationId: "org-1" });
  return { ...base, grants: keys.map((permission) => ({ permission, scope: "ALL" })) } as Principal;
}

describe("event field permissions", () => {
  it("sorts the fields into details, settings and survey", () => {
    expect(eventFieldPermission("name")).toBe("events.update");
    expect(eventFieldPermission("startDate")).toBe("events.update");
    expect(eventFieldPermission("taxRate")).toBe("events.settings");
    expect(eventFieldPermission("registrationTermsHtml")).toBe("events.settings");
    expect(eventFieldPermission("settings")).toBe("events.settings");
    expect(eventFieldPermission("surveyConfig")).toBe("surveys.manage");
    expect(eventFieldPermission("surveyThankYouHtml")).toBe("surveys.manage");
    // An unclassified field never needs less than the key every field asked before.
    expect(eventFieldPermission("somethingNew")).toBe("events.update");
    expect(eventFieldPermissions(["name", "venue", "taxRate"]).sort()).toEqual(["events.settings", "events.update"]);
  });

  it("counts only the fields whose value changes", () => {
    const stored = {
      name: "Congress",
      startDate: new Date("2026-11-01T08:00:00.000Z"),
      taxRate: { toString: () => "5" },
      maxAttendees: null,
      description: null,
      settings: { registrationOpen: true, mainRegisterTiers: ["a"] },
      surveyConfig: [{ id: "q1", type: "rating", label: "How was it?" }],
    };
    // The Settings General tab resends everything: nothing changed, nothing asked.
    expect(
      changedEventFields(
        {
          name: "Congress",
          startDate: "2026-11-01T08:00:00.000Z",
          taxRate: 5,
          maxAttendees: 0,
          description: null,
          settings: { registrationOpen: true },
          surveyConfig: [{ label: "How was it?", type: "rating", id: "q1" }],
        },
        stored,
      ),
    ).toEqual([]);
    expect(changedEventFields({ name: "Congress 2027", taxRate: 5 }, stored)).toEqual(["name"]);
    expect(changedEventFields({ settings: { registrationOpen: false } }, stored)).toEqual(["settings"]);
    expect(changedEventFields({ description: "" }, stored)).toEqual([]);
    expect(changedEventFields({ shiftSchedule: true }, stored)).toEqual(["shiftSchedule"]);
  });

  it("leaves every built-in role's reach unchanged: whoever edits an event holds all three keys at one scope", () => {
    for (const [role, def] of Object.entries(SYSTEM_ROLES)) {
      const scopes = (k: string) => def.grants.filter((g) => g.permission === k).map((g) => g.scope).sort().join();
      if (scopes("events.update") === "") continue;
      expect([role, scopes("events.settings")]).toEqual([role, scopes("events.update")]);
      if (role === "API_KEY") continue; // the edit route takes a session; the agent's update_event sends no survey field
      expect([role, scopes("surveys.manage")]).toEqual([role, scopes("events.update")]);
    }
  });
});

describe("bulk send types", () => {
  it("asks the operation's key for certificate and survey sends only", () => {
    expect(bulkEmailTypePermission("certificate")).toBe("certificates.issue");
    expect(bulkEmailTypePermission("survey-invitation")).toBe("surveys.manage");
    expect(bulkEmailTypePermission("custom")).toBeNull();
    expect(bulkEmailTypePermission(undefined)).toBeNull();
  });

  it("refuses the Webinars role a certificate send and keeps its survey send", () => {
    const webinars = principalFromUser({ id: "w1", role: "WEBINARS", organizationId: "org-1" });
    expect(can(webinars, "communications.send", { event: webinar })).toBe(true);
    expect(can(webinars, "certificates.issue", { event: webinar })).toBe(false);
    expect(can(webinars, "surveys.manage", { event: webinar })).toBe(true);
  });
});

describe("agent tool gate", () => {
  it("asks update_event for the key of each field it sends", () => {
    expect(toolInputPermissions("update_event", { eventId: "e1", taxRate: 5 })).toEqual(["events.settings"]);
    const detailsOnly = holding("events.update");
    const decide = (input: Record<string, unknown>) =>
      gateToolCall("update_event", { principal: detailsOnly, event: conference, writesSoFar: 0, input }).kind;
    expect(decide({ eventId: "e1", venue: "Hall B" })).toBe("run");
    expect(decide({ eventId: "e1", taxRate: 5 })).toBe("refuse");
  });

  it("asks send_bulk_email for the certificate key on a certificate send", () => {
    const sender = holding("communications.send");
    const decide = (emailType: string) =>
      gateToolCall("send_bulk_email", { principal: sender, event: conference, writesSoFar: 0, input: { emailType } }).kind;
    expect(decide("custom")).toBe("run");
    expect(decide("certificate")).toBe("refuse");
    expect(
      gateToolCall("send_bulk_email", {
        principal: holding("communications.send", "certificates.issue"),
        event: conference,
        writesSoFar: 0,
        input: { emailType: "certificate" },
      }).kind,
    ).toBe("run");
  });
});
