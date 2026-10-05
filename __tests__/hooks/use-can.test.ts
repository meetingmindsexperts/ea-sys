/**
 * The facts `useCan` judges an event-bound key by come from the event GET's
 * staff shape. An Onsite user is admitted only on an event whose
 * `settings.onsiteUserIds` names them, as the route admits them.
 */
import { describe, it, expect } from "vitest";
import { eventFactsOf } from "@/hooks/use-can";
import { can, principalFromUser } from "@/lib/permissions/can";

const onsite = principalFromUser({ id: "u-onsite", role: "ONSITE", organizationId: "org-1" });
const member = principalFromUser({ id: "u-member", role: "MEMBER", organizationId: "org-1" });

describe("useCan event facts", () => {
  it("reads organisation, type and the assigned staff from the event", () => {
    expect(eventFactsOf({ organizationId: "org-1", eventType: "CONFERENCE", settings: { onsiteUserIds: ["u-onsite", 7] } })).toEqual({
      organizationId: "org-1",
      eventType: "CONFERENCE",
      staffUserIds: ["u-onsite"],
    });
    expect(eventFactsOf(undefined)).toBeNull();
    expect(eventFactsOf({ eventType: "WEBINAR" })).toBeNull();
  });

  it("admits Onsite on its assigned event only, and judges keys the role lacks as refused", () => {
    const assigned = eventFactsOf({ organizationId: "org-1", eventType: "CONFERENCE", settings: { onsiteUserIds: ["u-onsite"] } });
    const other = eventFactsOf({ organizationId: "org-1", eventType: "CONFERENCE", settings: {} });
    expect(can(onsite, "registrations.read", { event: assigned })).toBe(true);
    expect(can(onsite, "registrations.read", { event: other })).toBe(false);
    expect(can(member, "reviewers.pool.manage", { event: assigned })).toBe(false);
    expect(can(member, "media.library.manage")).toBe(false);
  });
});
