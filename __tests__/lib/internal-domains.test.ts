/**
 * Internal-domain detection drives org-attach at registration + promote-on-
 * invite. All three company domains are internal with NO verification:
 * meetingmindsdubai.com (primary) + meetingmindsexperts.com /
 * meetingmindsgroup.com (temp-account domains, admin-deletable).
 */
import { describe, it, expect } from "vitest";
import { isInternalEmail, INTERNAL_EMAIL_DOMAINS } from "@/lib/internal-domains";
import { isTeamRole, TEAM_ROLES } from "@/lib/auth-guards";

describe("isInternalEmail", () => {
  it("matches the internal domains (case-insensitive, trimmed)", () => {
    expect(isInternalEmail("zaid@meetingmindsdubai.com")).toBe(true);
    expect(isInternalEmail("Zaid@MeetingMindsDubai.com")).toBe(true);
    expect(isInternalEmail(" zaid@meetingmindsdubai.com ")).toBe(true);
  });

  it("treats the temp-account domains as internal too (no verification)", () => {
    expect(isInternalEmail("temp1@meetingmindsexperts.com")).toBe(true);
    expect(isInternalEmail("temp2@meetingmindsgroup.com")).toBe(true);
    expect(isInternalEmail("TEMP@MeetingMindsGroup.com")).toBe(true);
  });

  it("does NOT match external domains", () => {
    expect(isInternalEmail("a@gmail.com")).toBe(false);
    expect(isInternalEmail("a@outlook.com")).toBe(false);
  });

  it("does not match a subdomain or a lookalike that merely contains the domain", () => {
    expect(isInternalEmail("a@evil-meetingmindsdubai.com")).toBe(false);
    expect(isInternalEmail("a@meetingmindsdubai.com.evil.com")).toBe(false);
    expect(isInternalEmail("a@meetingmindsgroup.com.attacker.io")).toBe(false);
  });

  it("handles malformed / empty input safely", () => {
    expect(isInternalEmail("")).toBe(false);
    expect(isInternalEmail(null)).toBe(false);
    expect(isInternalEmail(undefined)).toBe(false);
    expect(isInternalEmail("not-an-email")).toBe(false);
  });

  it("internal domains are the three company domains", () => {
    expect([...INTERNAL_EMAIL_DOMAINS]).toEqual([
      "meetingmindsdubai.com",
      "meetingmindsexperts.com",
      "meetingmindsgroup.com",
    ]);
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
