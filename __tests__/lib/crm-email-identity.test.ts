/**
 * The CRM email identity, per organisation (Nov 6, 2026; CRM product review
 * P0). An organisation's own block is used whole; the environment applies only
 * to the organisation it names; anyone else gets nothing, never a neighbour's.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { claimsEnvironmentAddress, environmentOrgId, readCrmEmailSettings, resolveIdentity } from "@/lib/crm-email-identity";

const env = {
  CRM_CAPTURE_ORG_ID: "org-master",
  CRM_EMAIL_FROM_ADDRESS: "Partnerships@MeetingMindsDubai.com",
  CRM_EMAIL_FROM_NAME: "Partnerships",
  CRM_REPLY_DOMAIN: "reply.meetingmindsexperts.com",
  CRM_CAPTURE_ADDRESS: "capture-x@reply.meetingmindsexperts.com",
} as unknown as NodeJS.ProcessEnv;

describe("resolveIdentity", () => {
  it("the environment's organisation gets the environment (master needs no change)", () => {
    expect(resolveIdentity("org-master", {}, env)).toEqual({
      sender: { email: "partnerships@meetingmindsdubai.com", name: "Partnerships" },
      forwardTo: "partnerships@meetingmindsdubai.com",
      replyDomain: "reply.meetingmindsexperts.com",
      captureAddress: "capture-x@reply.meetingmindsexperts.com",
      source: "environment",
    });
  });

  it("any other organisation without its own block gets NOTHING, never the environment's mailbox", () => {
    expect(resolveIdentity("org-tenant-b", {}, env)).toEqual({ sender: null, forwardTo: null, replyDomain: null, captureAddress: null, source: "none" });
  });

  it("no environment organisation means the environment applies to nobody", () => {
    const { CRM_CAPTURE_ORG_ID: _drop, ...rest } = env;
    void _drop;
    expect(resolveIdentity("org-master", {}, rest as unknown as NodeJS.ProcessEnv).source).toBe("none");
  });

  it("an organisation's own block is used whole, never mixed with the environment", () => {
    const id = resolveIdentity("org-master", { crmEmail: { fromAddress: "sales@b.com" } }, env);
    expect(id).toEqual({ sender: { email: "sales@b.com" }, forwardTo: "sales@b.com", replyDomain: null, captureAddress: null, source: "organisation" });
  });

  it("CRM_EMAIL_ORG_ID names the environment's organisation ahead of CRM_CAPTURE_ORG_ID", () => {
    expect(environmentOrgId({ ...env, CRM_EMAIL_ORG_ID: "org-other" } as unknown as NodeJS.ProcessEnv)).toBe("org-other");
    expect(environmentOrgId(env)).toBe("org-master");
  });
});

describe("readCrmEmailSettings", () => {
  it("lowercases and accepts a complete block", () => {
    expect(readCrmEmailSettings({ crmEmail: { fromAddress: "Sales@B.com", replyDomain: "Reply.B.com" } })).toMatchObject({
      fromAddress: "sales@b.com",
      replyDomain: "reply.b.com",
    });
  });

  it("refuses a corrupt block rather than half-using it", () => {
    expect(readCrmEmailSettings({ crmEmail: { fromAddress: "not-an-email" } })).toBeNull();
    expect(readCrmEmailSettings({ crmEmail: { fromAddress: "a@b.com", replyDomain: "no spaces allowed" } })).toBeNull();
    expect(readCrmEmailSettings({})).toBeNull();
    expect(readCrmEmailSettings(null)).toBeNull();
  });
});

describe("claimsEnvironmentAddress", () => {
  it("only another organisation naming the environment's capture address is a claim", () => {
    expect(claimsEnvironmentAddress("org-b", "Capture-X@reply.meetingmindsexperts.com", env)).toBe(true);
    expect(claimsEnvironmentAddress("org-master", "capture-x@reply.meetingmindsexperts.com", env)).toBe(false);
    expect(claimsEnvironmentAddress("org-b", "capture-b@reply.b.com", env)).toBe(false);
  });
});
