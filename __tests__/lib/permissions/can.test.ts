/**
 * `can()` and `eventWhereFor()` on their own: the scope rules, the person
 * grants, the operator, and the union of whole pairs (plan §7.3). Parity with
 * today's predicates is system-roles-parity.test.ts.
 */
import { describe, it, expect } from "vitest";
import { can, eventWhereFor, isOperator, systemPrincipal, type EventFacts } from "@/lib/permissions/can";
import type { Grant } from "@/lib/permissions/system-roles";

const ORG = "org-1";
const USER = "user-1";
const conference: EventFacts = { organizationId: ORG, eventType: "CONFERENCE", staffUserIds: [] };
const webinar: EventFacts = { organizationId: ORG, eventType: "WEBINAR", staffUserIds: [] };
const assignedConference: EventFacts = { organizationId: ORG, eventType: "CONFERENCE", staffUserIds: ["someone", USER] };
const otherOrgEvent: EventFacts = { organizationId: "org-2", eventType: "CONFERENCE", staffUserIds: [USER] };

const principal = (role: string | null, extra: Partial<Parameters<typeof systemPrincipal>[0]> = {}) =>
  systemPrincipal({ role, organizationId: ORG, userId: USER, ...extra });

describe("scopes", () => {
  it("ALL admits every event in the organisation and none outside it", () => {
    const p = principal("ORGANIZER");
    expect(can(p, "sessions.write", { event: conference })).toBe(true);
    expect(can(p, "sessions.write", { event: webinar })).toBe(true);
    expect(can(p, "sessions.write", { event: otherOrgEvent })).toBe(false);
  });

  it("WEBINAR admits webinar events only", () => {
    const p = principal("WEBINARS");
    expect(can(p, "sessions.write", { event: webinar })).toBe(true);
    expect(can(p, "sessions.write", { event: conference })).toBe(false);
    // The desk rides at ALL on the same principal.
    expect(can(p, "registrations.checkin", { event: conference })).toBe(true);
  });

  it("ASSIGNED admits only events the person is assigned to", () => {
    const p = principal("ONSITE");
    expect(can(p, "registrations.checkin", { event: assignedConference })).toBe(true);
    expect(can(p, "registrations.checkin", { event: conference })).toBe(false);
    // Assigned on another organisation's event still fails: the org check comes first.
    expect(can(p, "registrations.checkin", { event: otherOrgEvent })).toBe(false);
  });

  it("without an event, an event-bound key answers 'holds it somewhere'", () => {
    expect(can(principal("ONSITE"), "registrations.checkin")).toBe(true);
    expect(can(principal("ONSITE"), "sessions.write")).toBe(false);
  });

  it("an event-bound grant with no scope grants nothing, with or without an event", () => {
    const p = principal("CRM_USER", { customGrants: [{ permission: "registrations.checkin" }] });
    expect(can(p, "registrations.checkin", { event: conference })).toBe(false);
    expect(can(p, "registrations.checkin")).toBe(false);
    expect(eventWhereFor(p, "registrations.checkin")).toEqual({ id: { in: [] } });
  });

  it("a caller that asked about an event and had none gets no", () => {
    expect(can(principal("ADMIN"), "registrations.checkin", { event: null })).toBe(false);
    expect(can(principal("ADMIN"), "registrations.checkin", {})).toBe(false);
  });
});

describe("the union is over whole pairs (§7.3)", () => {
  it("MEMBER plus a custom WEBINAR-scoped sessions.write: control on webinars, none on conferences", () => {
    const custom: Grant[] = [{ permission: "sessions.write", scope: "WEBINAR" }];
    const p = principal("MEMBER", { customGrants: custom });
    expect(can(p, "sessions.write", { event: webinar })).toBe(true);
    expect(can(p, "sessions.write", { event: conference })).toBe(false);
    // MEMBER's own ALL-scoped desk is untouched by the narrower grant.
    expect(can(p, "registrations.checkin", { event: conference })).toBe(true);
  });

  it("two scopes on one key admit an event either admits", () => {
    const p = principal("ONSITE", { customGrants: [{ permission: "registrations.checkin", scope: "WEBINAR" }] });
    expect(can(p, "registrations.checkin", { event: webinar })).toBe(true);
    expect(can(p, "registrations.checkin", { event: assignedConference })).toBe(true);
    expect(can(p, "registrations.checkin", { event: conference })).toBe(false);
    expect(eventWhereFor(p, "registrations.checkin")).toEqual({
      organizationId: ORG,
      OR: [{ eventType: "WEBINAR" }, { settings: { path: ["onsiteUserIds"], array_contains: USER } }],
    });
  });
});

describe("person grants (§3.4)", () => {
  it("hr.read needs the tick on the person unless the role implies it", () => {
    expect(can(principal("ADMIN"), "hr.read")).toBe(false);
    expect(can(principal("ADMIN", { personGrants: { hrAccess: true } }), "hr.read")).toBe(true);
    expect(can(principal("HR_USER"), "hr.read")).toBe(true);
    expect(can(principal("SUPER_ADMIN"), "hr.read")).toBe(true);
  });

  it("approvals.decide needs a ceiling on the person, even beside a custom role holding the key", () => {
    const custom: Grant[] = [{ permission: "procurement.approvals.decide" }];
    expect(can(principal("MEMBER", { customGrants: custom }), "procurement.approvals.decide")).toBe(false);
    expect(can(principal("MEMBER", { customGrants: custom, personGrants: { procurementApproveCeilingAed: 100 } }), "procurement.approvals.decide")).toBe(true);
    expect(can(principal("MEMBER", { customGrants: custom, personGrants: { procurementApproveCeilingAed: 0 } }), "procurement.approvals.decide")).toBe(false);
    expect(can(principal("MEMBER", { customGrants: custom, personGrants: { procurementApproveUnlimited: true } }), "procurement.approvals.decide")).toBe(true);
  });

  it("the legacy columns do not apply to an API key", () => {
    const p = systemPrincipal({ role: null, organizationId: ORG, fromApiKey: true, personGrants: { procurementRequest: true } });
    expect(can(p, "procurement.requests.create")).toBe(false);
  });
});

describe("fails closed", () => {
  it("on an unknown key, an unknown role, no role, and an org-less staff account", () => {
    expect(can(principal("ADMIN"), "not.a.key" as never)).toBe(false);
    expect(can(principal("CUSTOM"), "events.read")).toBe(false);
    expect(can(principal(null), "events.read")).toBe(false);
    const orgless = systemPrincipal({ role: "ADMIN", organizationId: null, userId: USER });
    expect(can(orgless, "events.read", { event: conference })).toBe(false);
    expect(eventWhereFor(orgless, "events.read")).toEqual({ id: { in: [] } });
    // An organisation-wide key needs an organisation, even for a role that holds it.
    expect(can(orgless, "org.settings")).toBe(false);
    expect(can(orgless, "contacts.read")).toBe(false);
    const orglessRequester = systemPrincipal({ role: "REVIEWER", organizationId: null, personGrants: { procurementRequest: true } });
    expect(can(orglessRequester, "procurement.requests.create")).toBe(false);
  });

  it("eventWhereFor answers nothing for a non-event key or an unheld key", () => {
    expect(eventWhereFor(principal("ADMIN"), "org.settings")).toEqual({ id: { in: [] } });
    expect(eventWhereFor(principal("MEMBER"), "sessions.write")).toEqual({ id: { in: [] } });
  });
});

describe("the operator", () => {
  it("is a SUPER_ADMIN with no organisation, and only that", () => {
    expect(isOperator(systemPrincipal({ role: "SUPER_ADMIN", organizationId: null }))).toBe(true);
    expect(isOperator(principal("SUPER_ADMIN"))).toBe(false);
    expect(isOperator(systemPrincipal({ role: "ADMIN", organizationId: null }))).toBe(false);
    expect(isOperator(systemPrincipal({ role: null, organizationId: null, fromApiKey: true }))).toBe(false);
  });

  it("reaches any organisation's event", () => {
    const op = systemPrincipal({ role: "SUPER_ADMIN", organizationId: null, userId: USER });
    expect(can(op, "events.read", { event: otherOrgEvent })).toBe(true);
    expect(eventWhereFor(op, "events.read", "ev-9")).toEqual({ id: "ev-9" });
  });
});
