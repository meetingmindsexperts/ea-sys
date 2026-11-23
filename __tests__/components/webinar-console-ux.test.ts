/**
 * Webinar Console UX review (Nov 16, 2026): the decisions pinned in the page's source, because the
 * page is a large client component with no render harness. Each one is a mistake that is easy to make
 * again in a later edit.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const page = readFileSync("src/app/(dashboard)/events/[eventId]/webinar/page.tsx", "utf8");
// The webinar's reports, moved from the console's Analytics tab to the event's Analytics page (Nov 23, 2026).
const reports = readFileSync("src/components/webinar/webinar-analytics.tsx", "utf8");

function body(name: string, source = page): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf("\nfunction ", start + 10);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("the Webinar Console", () => {
  it("the sticky bar offers the attendee page, never Zoom's join link or passcode", () => {
    const bar = body("WebinarStatusBar");
    expect(bar).toContain("<AttendeePageLink");
    expect(bar).not.toMatch(/value=\{zoom\.joinUrl\}/);
    expect(bar).not.toMatch(/\{zoom\.passcode\}/);
  });

  it("the partner bar copies the same attendee page link", () => {
    const bar = body("PartnerStatusBar");
    expect(bar).toContain("useAttendeePageUrl(eventSlug, anchor?.id ?? null)");
    expect(bar).toContain('onCopy(attendeeUrl, "Attendee page link")');
  });

  it("the Overview card keeps Zoom's link and passcode folded away, labelled for hosts", () => {
    const card = body("OverviewCard");
    const details = card.indexOf("<details");
    expect(details).toBeGreaterThan(-1);
    expect(card).toContain("Zoom details (hosts only)");
    expect(card.indexOf("zoom.joinUrl")).toBeGreaterThan(details);
    expect(card.indexOf("zoom.passcode")).toBeGreaterThan(details);
  });

  it("the tabs are controlled, the opening tab is set once, and a vanished tab falls back (console-rules.ts)", () => {
    expect(page).toContain("<Tabs value={activeTab} onValueChange={setPickedTab}");
    expect(page).not.toContain("<Tabs defaultValue=");
    expect(page).toContain("if (data && pickedTab === null) setPickedTab(consoleOpeningTab(status));");
    expect(page).toContain("const visibleTabs = consoleTabs({ partner, viewerTabs: showViewerQaTab });");
    expect(page).toContain("consoleActiveTab(pickedTab, visibleTabs)");
    // Every conditional trigger and panel reads the same list.
    const tabs = page.slice(page.indexOf("<Tabs value={activeTab}"), page.indexOf("</Tabs>"));
    expect(tabs).not.toMatch(/\{showViewerQaTab && \(|\{!partner && \(\s*<Tabs(Trigger|Content)/);
    expect(tabs.match(/visibleTabs\.includes\(/g)?.length).toBe(8);
  });

  it("after a real close the room button is a confirmed, quiet re-open", () => {
    expect(body("roomButtonLabel")).toContain('"Re-open the room"');
    const action = body("roomButtonAction");
    expect(action.indexOf("a.closeEndsWebinar")).toBeLessThan(action.indexOf("a.reopen"));
    expect(action).toContain("return a.confirmReopen;");
    expect(body("GoLiveCard")).toContain("pastLateStart: anchorEndMs > 0 && nowTick > anchorEndMs + ROOM_OVERDUE_GRACE_MS");
    expect(page).toContain("<AlertDialogTitle>Re-open the room?</AlertDialogTitle>");
  });

  it("in custom stream mode Zoom's attendance is Zoom participants, without the attendance rate", () => {
    const card = body("AttendanceCard", reports);
    expect(card).toContain('"Zoom participants (speakers and hosts)"');
    const branch = card.slice(card.indexOf("{customStream ? ("), card.indexOf(") : (", card.indexOf("{customStream ? (")));
    expect(branch).not.toContain("Attendance rate");
    expect(reports).toContain('customStream={data.webinar?.viewingMode === "hls"}');
  });

  it("the attendee page of a partner's webinar never says it opens in Zoom, even before the key exists", () => {
    const attendee = readFileSync("src/app/e/[slug]/session/[sessionId]/page.tsx", "utf8");
    expect(attendee).toContain('const ctaStream = playsStream || joinInfo.mode === "stream";');
    expect(attendee).toContain("joinCtaHint({ playsStream: ctaStream,");
    expect(attendee).toContain("joinCtaTitle(isLive, ctaStream)");
  });

  it("asks zoom-join once more when a partner's key is issued after the room opened (review of fbaf43f2)", () => {
    const attendee = readFileSync("src/app/e/[slug]/session/[sessionId]/page.tsx", "utf8");
    expect(attendee).toContain("const streamReady = lobby?.streamReady === true;");
    expect(attendee).toContain('if (streamRefetchedRef.current || joinInfo?.mode !== "stream" || joinInfo.liveStreamEnabled) return;');
    expect(attendee).toContain("setAdmitAttempt((n) => n + 1);\n  }, [streamReady, joinInfo]);");
  });

  it("an available recording says Available, not the email list's SENT", () => {
    expect(body("RecordingCard")).not.toContain('<StatusPill status="SENT" />');
  });
});
