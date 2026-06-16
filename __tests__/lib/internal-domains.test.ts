/**
 * Internal-domain detection drives org-attach at registration + promote-on-
 * invite. Two tiers: meetingmindsdubai.com is internal but must VERIFY email
 * before org-attach; meetingmindsexperts.com / meetingmindsgroup.com are
 * TRUSTED temp-account domains (org immediately, no verification).
 */
import { describe, it, expect } from "vitest";
import {
  isInternalEmail,
  isTrustedInternalEmail,
  needsEmailVerification,
  INTERNAL_EMAIL_DOMAINS,
} from "@/lib/internal-domains";
import { isTeamRole, TEAM_ROLES } from "@/lib/auth-guards";

describe("isInternalEmail (either tier)", () => {
  it("matches all internal domains (case-insensitive, trimmed)", () => {
    expect(isInternalEmail("Zaid@MeetingMindsDubai.com")).toBe(true);
    expect(isInternalEmail(" zaid@meetingmindsdubai.com ")).toBe(true);
    expect(isInternalEmail("temp@meetingmindsexperts.com")).toBe(true);
    expect(isInternalEmail("temp@meetingmindsgroup.com")).toBe(true);
  });

  it("does NOT match external domains or lookalikes", () => {
    expect(isInternalEmail("a@gmail.com")).toBe(false);
    expect(isInternalEmail("a@evil-meetingmindsdubai.com")).toBe(false);
    expect(isInternalEmail("a@meetingmindsgroup.com.attacker.io")).toBe(false);
  });

  it("handles malformed / empty input safely", () => {
    expect(isInternalEmail("")).toBe(false);
    expect(isInternalEmail(null)).toBe(false);
    expect(isInternalEmail(undefined)).toBe(false);
    expect(isInternalEmail("not-an-email")).toBe(false);
  });

  it("covers exactly the three company domains", () => {
    expect([...INTERNAL_EMAIL_DOMAINS]).toEqual([
      "meetingmindsdubai.com",
      "meetingmindsexperts.com",
      "meetingmindsgroup.com",
    ]);
  });
});

describe("verified vs trusted tiers", () => {
  it("meetingmindsdubai.com needs verification (real mailbox)", () => {
    expect(needsEmailVerification("zaid@meetingmindsdubai.com")).toBe(true);
    expect(isTrustedInternalEmail("zaid@meetingmindsdubai.com")).toBe(false);
  });

  it("temp-account domains are trusted — org immediately, no verification", () => {
    for (const e of ["t@meetingmindsexperts.com", "t@meetingmindsgroup.com"]) {
      expect(isTrustedInternalEmail(e)).toBe(true);
      expect(needsEmailVerification(e)).toBe(false);
    }
  });

  it("external emails are neither", () => {
    expect(needsEmailVerification("a@gmail.com")).toBe(false);
    expect(isTrustedInternalEmail("a@gmail.com")).toBe(false);
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
