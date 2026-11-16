/**
 * The handover message for a partner (Nov 16, 2026; external streams step 7).
 */
import { describe, it, expect } from "vitest";
import { PARTNER_ENCODER_SETTINGS, partnerHandoverText } from "@/lib/webinar/partner-handover";

const base = {
  eventName: "Hematology Update 2027",
  serverUrl: "rtmp://events.example.com:1935/live/",
  streamKey: "0123abcd?user=publisher&pass=s3cret",
  validFrom: new Date("2027-01-19T06:00:00Z"),
  validUntil: new Date("2027-01-21T12:00:00Z"),
  timezone: "Asia/Dubai",
};

describe("partnerHandoverText", () => {
  it("carries the two values on their own lines, untouched", () => {
    const lines = partnerHandoverText(base).split("\n");
    expect(lines).toContain("Server (RTMP URL): rtmp://events.example.com:1935/live/");
    expect(lines).toContain("Stream key: 0123abcd?user=publisher&pass=s3cret");
    expect(lines[0]).toBe("Streaming details for Hematology Update 2027");
  });

  it("states the period in the event's timezone", () => {
    const text = partnerHandoverText(base);
    expect(text).toMatch(/works from Jan 19, 2027, 10:00 AM GMT\+4 until Jan 21, 2027, 4:00 PM GMT\+4\./);
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
