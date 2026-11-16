/**
 * The handover message for a partner (Nov 16, 2026; external streams step 7, and the review of
 * 1f98a508).
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { PARTNER_ENCODER_SETTINGS, partnerHandoverText } from "@/lib/webinar/partner-handover";

const base = {
  eventName: "Hematology Update 2027",
  serverUrl: "rtmp://events.example.com:1935/live/",
  streamKey: "0123abcd?user=publisher&pass=s3cret",
  validFrom: new Date("2027-01-19T06:00:00Z"),
  validUntil: new Date("2027-01-21T12:00:00Z"),
  validUntilIsOwn: true,
  scheduledStart: new Date("2027-01-20T10:00:00Z"),
  pageUrl: "https://events.example.com/e/hem-2027/session/s1",
  draft: false,
  timezone: "Asia/Dubai",
};

describe("partnerHandoverText", () => {
  it("carries the two values on their own lines, untouched", () => {
    const lines = partnerHandoverText(base).split("\n");
    expect(lines).toContain("Server (RTMP URL): rtmp://events.example.com:1935/live/");
    expect(lines).toContain("Stream key: 0123abcd?user=publisher&pass=s3cret");
    expect(lines[0]).toBe("Streaming details for Hematology Update 2027");
  });

  it("gives the webinar's start and the key's period in the event's timezone", () => {
    const text = partnerHandoverText(base);
    expect(text).toContain("The webinar starts at Jan 20, 2027, 2:00 PM GMT+4.");
    expect(text).toMatch(/works from Jan 19, 2027, 10:00 AM GMT\+4 until Jan 21, 2027, 4:00 PM GMT\+4\./);
  });

  it("says when the end date follows the webinar", () => {
    expect(partnerHandoverText({ ...base, validUntilIsOwn: false })).toContain("(it moves if the webinar's date changes).");
    expect(partnerHandoverText(base)).not.toContain("it moves");
  });

  it("gives the page address for platforms that ask, and leaves the line out when there is none", () => {
    expect(partnerHandoverText(base)).toContain("If your platform asks for a live streaming page URL: https://events.example.com/e/hem-2027/session/s1");
    expect(partnerHandoverText({ ...base, pageUrl: null, scheduledStart: null })).not.toMatch(/page URL|starts at/);
  });

  it("on a draft event it never promises that attendees see nothing (a draft's room counts as open)", () => {
    const draft = partnerHandoverText({ ...base, draft: true });
    expect(draft).not.toContain("attendees see nothing");
    expect(draft).toContain("please tell us before you test");
    expect(partnerHandoverText(base)).toContain("attendees see nothing until we open the room");
  });

  it("lists every encoder setting the console shows", () => {
    const text = partnerHandoverText(base);
    for (const s of PARTNER_ENCODER_SETTINGS) expect(text).toContain(`- ${s.setting}: ${s.value}`);
  });

  it("adds the contact only when one is typed", () => {
    expect(partnerHandoverText(base)).not.toContain("Contact on the day");
    expect(partnerHandoverText({ ...base, contact: "   " })).not.toContain("Contact on the day");
    expect(partnerHandoverText({ ...base, contact: " Sara, +971 50 000 0000 " })).toContain("Contact on the day: Sara, +971 50 000 0000");
  });

  it("an event with no name still reads", () => {
    expect(partnerHandoverText({ ...base, eventName: " " }).split("\n")[0]).toBe("Streaming details for the webinar");
  });
});

describe("the card builds the message from the key it was shown", () => {
  it("one reveal hook, and the message is built from its answer: never a second read of the key", () => {
    const card = readFileSync("src/components/webinar/partner-stream-card.tsx", "utf8");
    expect(card.match(/useRevealWebinarPartnerStreamKey\(/g)).toHaveLength(1);
    expect(card).toContain("buildHandover(shown, handover, contact)");
    expect(card).not.toMatch(/partner-stream\/credentials/);
  });
});
