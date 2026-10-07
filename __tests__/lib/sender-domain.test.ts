import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedSenderAddress, senderDomain } from "@/lib/sender-domain";

// Oct 7, 2026: an event sender on another domain made every send fail with a
// raw SES AccessDenied. The settings page names this domain beside the field.
describe("sender domain", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads the domain from EMAIL_FROM, plain or with a display name", () => {
    vi.stubEnv("EMAIL_FROM", "events@MeetingMindsExperts.com");
    expect(senderDomain()).toBe("meetingmindsexperts.com");
    vi.stubEnv("EMAIL_FROM", "Events Team <events@meetingmindsexperts.com>");
    expect(senderDomain()).toBe("meetingmindsexperts.com");
    vi.stubEnv("EMAIL_FROM", "");
    expect(senderDomain()).toBeNull();
  });

  it("allows only addresses on that domain", () => {
    expect(isAllowedSenderAddress("virtual@meetingmindsdubai.com", "meetingmindsexperts.com")).toBe(false);
    expect(isAllowedSenderAddress(" Virtual@MeetingMindsExperts.com ", "meetingmindsexperts.com")).toBe(true);
    expect(isAllowedSenderAddress("x@evil-meetingmindsexperts.com", "meetingmindsexperts.com")).toBe(false);
    expect(isAllowedSenderAddress("anything@x.com", null)).toBe(true);
  });
});
