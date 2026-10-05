/**
 * Which system role is shown the "no access" panel on which event page
 * (custom roles Phase 3, Oct 5, 2026). Recorded and reviewed against a sweep
 * of every page for Member, Onsite and Webinars on the local build: a page
 * listed here as refused is one whose own list request the route refused.
 * Re-record only on an intended change: `npx vitest run
 * __tests__/permissions/event-page-keys.test.ts -u`, then read the diff.
 */
import { describe, it, expect } from "vitest";
import { can, principalFromUser, type EventFacts } from "@/lib/permissions/can";
import { EVENT_PAGE_KEYS, eventPageSegment } from "@/lib/permissions/event-page-keys";

const ROLES = ["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER", "ONSITE", "WEBINARS", "CRM_USER", "HR_USER"];
const EVENTS: Record<string, EventFacts> = {
  conference: { organizationId: "org-1", eventType: "CONFERENCE", staffUserIds: ["u1"] },
  webinar: { organizationId: "org-1", eventType: "WEBINAR", staffUserIds: ["u1"] },
};

describe("event page keys", () => {
  it("finds the page segment", () => {
    expect(eventPageSegment("/events/e1/speakers/s1")).toBe("speakers");
    expect(eventPageSegment("/events/e1")).toBe("");
    expect(eventPageSegment("/crm/deals")).toBe("");
  });

  it("refuses exactly the recorded role, event and page combinations", async () => {
    const lines: string[] = [];
    for (const role of ROLES) {
      const p = principalFromUser({ id: "u1", role, organizationId: "org-1" });
      for (const [label, facts] of Object.entries(EVENTS)) {
        const refused = Object.entries(EVENT_PAGE_KEYS)
          .filter(([, key]) => !can(p, key, { event: facts }))
          .map(([segment]) => segment);
        lines.push(`${role} · ${label}: ${refused.join(", ") || "-"}`);
      }
    }
    await expect(lines.join("\n") + "\n").toMatchFileSnapshot("./__snapshots__/event-page-keys.txt");
  });
});
