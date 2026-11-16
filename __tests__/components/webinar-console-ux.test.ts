/**
 * Webinar Console UX review (Nov 16, 2026): the decisions pinned in the page's source, because the
 * page is a large client component with no render harness. Each one is a mistake that is easy to make
 * again in a later edit.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const page = readFileSync("src/app/(dashboard)/events/[eventId]/webinar/page.tsx", "utf8");

function body(name: string): string {
  const start = page.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = page.indexOf("\nfunction ", start + 10);
  return page.slice(start, next === -1 ? undefined : next);
}

describe("the Webinar Console", () => {
  it("the sticky bar offers the attendee page, never Zoom's join link or passcode", () => {
    const bar = body("WebinarStatusBar");
    expect(bar).toContain("<AttendeePageLink");
    expect(bar).not.toMatch(/value=\{zoom\.joinUrl\}/);
    expect(bar).not.toMatch(/\{zoom\.passcode\}/);
  });

  it("the Overview card keeps Zoom's link and passcode folded away, labelled for hosts and panelists", () => {
    const card = body("OverviewCard");
    const details = card.indexOf("<details");
    expect(details).toBeGreaterThan(-1);
    expect(card).toContain("Zoom details (host and panelists only)");
    expect(card.indexOf("zoom.joinUrl")).toBeGreaterThan(details);
    expect(card.indexOf("zoom.passcode")).toBeGreaterThan(details);
  });

  it("the tabs are controlled, so an ended webinar opens on Analytics once its data arrives", () => {
    expect(page).toContain("<Tabs value={activeTab} onValueChange={setPickedTab}");
    expect(page).not.toContain("<Tabs defaultValue=");
    expect(page).toContain('const defaultTab = status === "ended" ? "analytics" : "setup";');
  });

  it("after the end the room button is a confirmed, quiet re-open", () => {
    expect(body("roomButtonLabel")).toContain('"Re-open the room"');
    const action = body("roomButtonAction");
    expect(action.indexOf("a.closeEndsWebinar")).toBeLessThan(action.indexOf("a.ended"));
    expect(action).toContain("return a.confirmReopen;");
    expect(page).toContain("<AlertDialogTitle>Re-open the room?</AlertDialogTitle>");
  });

  it("in custom stream mode Zoom's attendance is Zoom participants, without the attendance rate", () => {
    const card = body("AttendanceCard");
    expect(card).toContain('"Zoom participants (speakers and hosts)"');
    const branch = card.slice(card.indexOf("{customStream ? ("), card.indexOf(") : (", card.indexOf("{customStream ? (")));
    expect(branch).not.toContain("Attendance rate");
    expect(page).toContain('customStream={data?.webinar?.viewingMode === "hls"}');
  });

  it("an available recording says Available, not the email list's SENT", () => {
    expect(body("RecordingCard")).not.toContain('<StatusPill status="SENT" />');
  });
});
