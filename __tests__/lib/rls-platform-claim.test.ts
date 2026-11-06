/**
 * A platform deployment (PLATFORM_ORG_ID set) must run with RLS_SET_LOCAL=1,
 * or no policy is ever consulted and nothing says so (CRM product review P0-3).
 * Master (PLATFORM_ORG_ID unset) is untouched.
 */
import { describe, expect, it } from "vitest";
import { assertPlatformClaimsRls } from "@/lib/tenant/rls-assert";

const env = (over: Record<string, string>) => over as unknown as NodeJS.ProcessEnv;

describe("assertPlatformClaimsRls", () => {
  it("refuses a platform deployment that forgot RLS_SET_LOCAL", () => {
    expect(() => assertPlatformClaimsRls(env({ PLATFORM_ORG_ID: "org-platform" }))).toThrow(/RLS_SET_LOCAL/);
    expect(() => assertPlatformClaimsRls(env({ PLATFORM_ORG_ID: "org-platform", RLS_SET_LOCAL: "true" }))).toThrow();
  });

  it("passes a platform deployment that claims enforcement, and master either way", () => {
    expect(() => assertPlatformClaimsRls(env({ PLATFORM_ORG_ID: "org-platform", RLS_SET_LOCAL: "1" }))).not.toThrow();
    expect(() => assertPlatformClaimsRls(env({}))).not.toThrow();
    expect(() => assertPlatformClaimsRls(env({ PLATFORM_ORG_ID: "  " }))).not.toThrow();
  });
});
