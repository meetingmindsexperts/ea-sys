/**
 * Internal-domain detection drives org-attach at registration + promote-on-
 * invite. For now the only internal domain is meetingmindsdubai.com;
 * meetingmindsexperts.com / meetingmindsgroup.com are deliberately NOT internal
 * yet (slated for a verified-domain pass).
 */
import { describe, it, expect } from "vitest";
import { isInternalEmail, INTERNAL_EMAIL_DOMAINS } from "@/lib/internal-domains";
import { isTeamRole, TEAM_ROLES } from "@/lib/auth-guards";

describe("isInternalEmail", () => {
  it("matches the internal domain (case-insensitive, trimmed)", () => {
    expect(isInternalEmail("zaid@meetingmindsdubai.com")).toBe(true);
    expect(isInternalEmail("Zaid@MeetingMindsDubai.com")).toBe(true);
    expect(isInternalEmail(" zaid@meetingmindsdubai.com ")).toBe(true);
  });

  it("does NOT match the not-yet-internal / external domains", () => {
    expect(isInternalEmail("a@meetingmindsexperts.com")).toBe(false);
    expect(isInternalEmail("a@meetingmindsgroup.com")).toBe(false);
    expect(isInternalEmail("a@gmail.com")).toBe(false);
  });

  it("does not match a subdomain or a lookalike that merely contains the domain", () => {
    expect(isInternalEmail("a@evil-meetingmindsdubai.com")).toBe(false);
    expect(isInternalEmail("a@meetingmindsdubai.com.evil.com")).toBe(false);
  });

  it("handles malformed / empty input safely", () => {
    expect(isInternalEmail("")).toBe(false);
    expect(isInternalEmail(null)).toBe(false);
    expect(isInternalEmail(undefined)).toBe(false);
    expect(isInternalEmail("not-an-email")).toBe(false);
  });

  it("only meetingmindsdubai.com is internal for now", () => {
    expect([...INTERNAL_EMAIL_DOMAINS]).toEqual(["meetingmindsdubai.com"]);
  });
});

describe("isTeamRole", () => {
  it("treats staff roles as team members", () => {
    for (const r of TEAM_ROLES) expect(isTeamRole(r)).toBe(true);
  });

  it("treats attendee/reviewer roles as NOT team members", () => {
    expect(isTeamRole("REGISTRANT")).toBe(false);
    expect(isTeamRole("SUBMITTER")).toBe(false);
    expect(isTeamRole("REVIEWER")).toBe(false);
    expect(isTeamRole(null)).toBe(false);
    expect(isTeamRole(undefined)).toBe(false);
  });
});
