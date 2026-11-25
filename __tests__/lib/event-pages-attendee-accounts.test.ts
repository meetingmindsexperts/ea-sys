/**
 * An attendee-side account (reviewer, submitter, registrant) reaches an event's overview through
 * hubEventWhere's linked-role scoping, so the page itself must keep the staff figures from it
 * (review of 9b4eb396a, Nov 25, 2026). Page confinement normally sends these accounts elsewhere;
 * this is the second wall. Server pages are not rendered in unit tests, so the source is read.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isLinkedRole } from "@/lib/team-roles";

const overview = readFileSync("src/app/(dashboard)/events/[eventId]/page.tsx", "utf8");
const setup = readFileSync("src/app/(dashboard)/events/[eventId]/setup/page.tsx", "utf8");

describe("event pages and attendee-side accounts", () => {
  it("the rule covers all three attendee-side roles, and no staff role", () => {
    for (const role of ["REVIEWER", "SUBMITTER", "REGISTRANT"]) expect(isLinkedRole(role)).toBe(true);
    for (const role of ["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER", "ONSITE", "BASE"]) expect(isLinkedRole(role)).toBe(false);
  });

  it("the overview restricts every attendee-side role, and hides the counts and quick actions behind it", () => {
    expect(overview).toContain("const isRestricted = isLinkedRole(session.user.role);");
    expect(overview).toMatch(/── Stats Grid[^\n]*\n\s*\{!isRestricted && \(/);
    expect(overview).toMatch(/── Quick Actions[^\n]*\n\s*\{!isRestricted && \(/);
  });

  it("the setup page refuses an attendee-side account before it reads anything", () => {
    const guard = setup.indexOf("if (isLinkedRole(session.user.role)) notFound();");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(setup.indexOf("hubEventWhere(session"));
  });
});
