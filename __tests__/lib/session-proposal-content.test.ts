import { describe, it, expect } from "vitest";
import {
  MAX_PROPOSAL_DESCRIPTION_CHARS,
  withinProposalDescriptionLimit,
} from "@/lib/session-proposal-content";

/**
 * The cap is enforced in three places (the form's `maxLength`, the form's
 * submit guard, and BOTH write routes' Zod). These pin the shared constant and
 * the boundary so a change moves all of them together instead of leaving the
 * form and the server disagreeing.
 */
describe("session proposal description limit", () => {
  it("is 3000 characters", () => {
    expect(MAX_PROPOSAL_DESCRIPTION_CHARS).toBe(3000);
  });

  it("accepts a description exactly at the cap", () => {
    expect(withinProposalDescriptionLimit("x".repeat(MAX_PROPOSAL_DESCRIPTION_CHARS))).toBe(true);
  });

  it("rejects one character over", () => {
    expect(withinProposalDescriptionLimit("x".repeat(MAX_PROPOSAL_DESCRIPTION_CHARS + 1))).toBe(false);
  });

  it("passes empty and null (required-ness is a separate rule)", () => {
    expect(withinProposalDescriptionLimit("")).toBe(true);
    expect(withinProposalDescriptionLimit(null)).toBe(true);
    expect(withinProposalDescriptionLimit(undefined)).toBe(true);
  });
});
