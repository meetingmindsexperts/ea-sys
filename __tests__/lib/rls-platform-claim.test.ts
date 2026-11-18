/**
 * A platform deployment (PLATFORM_ORG_ID set) must run with RLS_SET_LOCAL=1,
 * or no policy is ever consulted and nothing says so (CRM product review P0-3).
 * And it must wire the privileged lane (DATABASE_URL_OPERATOR, a different
 * connection from the app's): since Event carries a policy, a reviewer,
 * submitter or registrant opens an event through it (review of 9c0a24c5).
 * A deployment with row security OFF is untouched. One with it ON must wire
 * the privileged lane whether or not it calls itself the platform: since Nov
 * 18, 2026 the deployment that switches row security on is production itself.
 */
import { describe, expect, it } from "vitest";
import { assertPlatformClaimsRls } from "@/lib/tenant/rls-assert";

const env = (over: Record<string, string>) => over as unknown as NodeJS.ProcessEnv;

describe("assertPlatformClaimsRls", () => {
  it("refuses a platform deployment that forgot RLS_SET_LOCAL", () => {
    expect(() => assertPlatformClaimsRls(env({ PLATFORM_ORG_ID: "org-platform" }))).toThrow(/RLS_SET_LOCAL/);
    expect(() => assertPlatformClaimsRls(env({ PLATFORM_ORG_ID: "org-platform", RLS_SET_LOCAL: "true" }))).toThrow();
  });

  const PLATFORM = { PLATFORM_ORG_ID: "org-platform", RLS_SET_LOCAL: "1", DATABASE_URL: "postgres://app_user@db/ea" };

  it("passes a platform deployment that claims enforcement and wires the privileged lane, and master either way", () => {
    expect(() => assertPlatformClaimsRls(env({ ...PLATFORM, DATABASE_URL_OPERATOR: "postgres://owner@db/ea" }))).not.toThrow();
    expect(() => assertPlatformClaimsRls(env({}))).not.toThrow();
    expect(() => assertPlatformClaimsRls(env({ PLATFORM_ORG_ID: "  " }))).not.toThrow();
    // Row security off: never asked for the privileged lane.
    expect(() => assertPlatformClaimsRls(env({ DATABASE_URL: "postgres://owner@db/ea" }))).not.toThrow();
  });

  it("refuses ANY deployment with row security on and no privileged lane, platform or not", () => {
    // Production switching row security on sets no PLATFORM_ORG_ID. Without
    // this, two cleanup jobs would read every file as unclaimed and delete it.
    const ON = { RLS_SET_LOCAL: "1", DATABASE_URL: "postgres://app_user@db/ea" };
    expect(() => assertPlatformClaimsRls(env(ON))).toThrow(/DATABASE_URL_OPERATOR is not set/);
    expect(() => assertPlatformClaimsRls(env({ ...ON, DATABASE_URL_OPERATOR: ON.DATABASE_URL }))).toThrow(/same connection/);
    expect(() => assertPlatformClaimsRls(env({ ...ON, DATABASE_URL_OPERATOR: "postgres://owner@db/ea" }))).not.toThrow();
  });

  it("refuses a platform deployment with no privileged lane, or one that is the app's own connection", () => {
    expect(() => assertPlatformClaimsRls(env(PLATFORM))).toThrow(/DATABASE_URL_OPERATOR is not set/);
    expect(() => assertPlatformClaimsRls(env({ ...PLATFORM, DATABASE_URL_OPERATOR: "   " }))).toThrow(/DATABASE_URL_OPERATOR/);
    expect(() => assertPlatformClaimsRls(env({ ...PLATFORM, DATABASE_URL_OPERATOR: PLATFORM.DATABASE_URL }))).toThrow(/same connection/);
  });
});
