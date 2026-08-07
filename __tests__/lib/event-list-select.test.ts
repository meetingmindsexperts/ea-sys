import { describe, it, expect } from "vitest";
import {
  EVENT_LIST_SELECT,
  EVENT_LIST_COUNT_SELECT,
  eventListSelect,
} from "@/lib/event-access";
import { TEAM_ROLES } from "@/lib/auth-guards";

/**
 * The events list is ONE component and ONE endpoint shared by organisers and by
 * org-null roles (reviewer / submitter / registrant). That is how registration
 * and speaker headcounts ended up in front of an abstract submitter: the query
 * used a bare `include`, so everyone got the organiser payload.
 *
 * These pin the boundary. They assert on the SELECT rather than on rendering,
 * because the fix is that the data is never fetched — hiding a column in CSS
 * would leave the numbers in the page payload.
 */
describe("events list select", () => {
  it("every team role gets the headcounts", () => {
    for (const role of TEAM_ROLES) {
      expect(eventListSelect(role)).toHaveProperty("_count");
    }
  });

  it.each(["REVIEWER", "SUBMITTER", "REGISTRANT", null, undefined, "SOMETHING_NEW"])(
    "an org-null or unknown role (%s) gets NO headcounts",
    (role) => {
      expect(eventListSelect(role as string | null | undefined)).not.toHaveProperty("_count");
    },
  );

  it("fails closed: an unrecognised role is treated as untrusted", () => {
    // The default matters more than the listed cases. A role added later and
    // forgotten here must lose the counts, not inherit them.
    expect(eventListSelect("FUTURE_ROLE")).toEqual(EVENT_LIST_SELECT);
  });

  it("selects only the columns the list renders", () => {
    // Anything beyond this is organiser configuration with no business in a
    // list payload: settings JSON (reviewer/onsite assignments, sponsors,
    // webinar + group config), bankDetails, taxRate, the per-event sender.
    expect(Object.keys(EVENT_LIST_SELECT).sort()).toEqual(
      ["description", "endDate", "id", "name", "startDate", "status", "timezone", "venue"],
    );
  });

  it("keeps the count select separate so it can be withheld", () => {
    expect(EVENT_LIST_COUNT_SELECT).toEqual({
      _count: { select: { registrations: true, speakers: true } },
    });
    expect(EVENT_LIST_SELECT).not.toHaveProperty("_count");
  });
});
