/**
 * Submitter surface separation (July 30, 2026) — the ONE truth table behind
 * both the sidebar and the page redirect guard. Rules: proposal signups see
 * only Session Proposals, abstract signups (incl. legacy null source) only
 * Abstracts; actually HAVING content on the other surface always reveals it.
 */
import { describe, it, expect } from "vitest";
import {
  submitterSeesAbstracts,
  submitterSeesProposals,
  submitterHomePath,
} from "@/lib/submitter-surfaces";

const ctx = (submitterSource: string | null, abstractCount = 0, proposalCount = 0) => ({
  submitterSource,
  abstractCount,
  proposalCount,
});

describe("submitter surface truth table", () => {
  it("abstract signup sees Abstracts, not Session Proposals", () => {
    expect(submitterSeesAbstracts(ctx("abstract"))).toBe(true);
    expect(submitterSeesProposals(ctx("abstract"))).toBe(false);
  });

  it("proposal signup sees Session Proposals, not Abstracts", () => {
    expect(submitterSeesProposals(ctx("proposal"))).toBe(true);
    expect(submitterSeesAbstracts(ctx("proposal"))).toBe(false);
  });

  it("legacy speaker (null source) counts as abstract", () => {
    expect(submitterSeesAbstracts(ctx(null))).toBe(true);
    expect(submitterSeesProposals(ctx(null))).toBe(false);
  });

  it("'both' (used both doors) sees BOTH surfaces — the registers are independent (Aug 4, 2026)", () => {
    expect(submitterSeesAbstracts(ctx("both"))).toBe(true);
    expect(submitterSeesProposals(ctx("both"))).toBe(true);
  });

  it("content overrides source in BOTH directions — owned rows are never hidden", () => {
    // Proposal person who was later given an abstract:
    expect(submitterSeesAbstracts(ctx("proposal", 1, 0))).toBe(true);
    // Abstract person who submitted a proposal:
    expect(submitterSeesProposals(ctx("abstract", 0, 1))).toBe(true);
    // Legacy person with proposals:
    expect(submitterSeesProposals(ctx(null, 0, 2))).toBe(true);
  });

  it("home path follows the visible surface", () => {
    expect(submitterHomePath("ev1", ctx("abstract"))).toBe("/events/ev1/abstracts/profile");
    expect(submitterHomePath("ev1", ctx("proposal"))).toBe("/events/ev1/session-proposals");
    // Proposal-only person with an abstract → abstracts is visible → home is abstracts.
    expect(submitterHomePath("ev1", ctx("proposal", 1, 0))).toBe("/events/ev1/abstracts/profile");
  });
});
