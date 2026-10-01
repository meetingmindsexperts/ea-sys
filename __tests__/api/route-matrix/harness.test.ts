/**
 * The matrix is only as good as its `where` evaluator: these pin that it reads
 * every shape `buildEventAccessWhere` and `eventWhereFor` produce the way
 * Postgres would, and that it refuses a shape it does not know rather than
 * guessing.
 */
import { describe, it, expect } from "vitest";
import { buildEventAccessWhere } from "@/lib/event-access";
import { eventWhereFor, systemPrincipal } from "@/lib/permissions/can";
import { EVENTS, ORG, matchesEvent } from "./harness";

const reach = (where: Record<string, unknown>) => EVENTS.filter((e) => matchesEvent(where, e)).map((e) => e.id);
const user = (role: string, id: string, organizationId: string | null = ORG) => ({ id, role, organizationId });

describe("matchesEvent", () => {
  it("reads every role's buildEventAccessWhere shape", () => {
    expect(reach(buildEventAccessWhere(user("ADMIN", "u-admin")))).toEqual(["conf", "assigned", "webinar"]);
    expect(reach(buildEventAccessWhere(user("ONSITE", "u-onsite")))).toEqual(["assigned"]);
    expect(reach(buildEventAccessWhere(user("WEBINARS", "u-webinars")))).toEqual(["webinar"]);
    expect(reach(buildEventAccessWhere(user("WEBINARS", "u-webinars"), undefined, { surface: "desk" }))).toEqual(["conf", "assigned", "webinar"]);
    expect(reach(buildEventAccessWhere(user("CRM_USER", "u-crm")))).toEqual([]);
    expect(reach(buildEventAccessWhere(user("REVIEWER", "u-reviewer", null)))).toEqual(["assigned", "foreign"]);
    expect(reach(buildEventAccessWhere(user("SUBMITTER", "u-submitter", null)))).toEqual(["assigned", "foreign"]);
    expect(reach(buildEventAccessWhere(user("REGISTRANT", "u-registrant", null)))).toEqual(["assigned", "foreign"]);
    expect(reach(buildEventAccessWhere(user("SUPER_ADMIN", "u-op", null)))).toEqual(["conf", "assigned", "webinar", "foreign"]);
    expect(reach(buildEventAccessWhere(user("ADMIN", "u-admin"), "webinar"))).toEqual(["webinar"]);
  });

  it("reads eventWhereFor's OR of scopes", () => {
    const p = systemPrincipal({
      role: "ONSITE",
      organizationId: ORG,
      userId: "u-onsite",
      customGrants: [{ permission: "registrations.checkin", scope: "WEBINAR" }],
    });
    expect(reach(eventWhereFor(p, "registrations.checkin"))).toEqual(["assigned", "webinar"]);
  });

  it("throws on a filter it does not understand, instead of guessing", () => {
    expect(() => reach({ status: "DRAFT" })).toThrow(/unsupported event filter key "status"/);
    expect(() => reach({ settings: { path: ["a", "b"], array_contains: "x" } })).toThrow(/unsupported settings filter/);
    expect(() => reach({ id: { notIn: ["conf"] } })).toThrow(/unsupported scalar filter/);
  });
});
