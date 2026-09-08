/** buildAbstractDecisionVars: one builder behind the automatic status email and the bulk resend. */
import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn() }));
vi.mock("@/lib/travel-grant/server", () => ({ resolveTravelGrantBlock: vi.fn() }));
import { buildAbstractDecisionVars } from "@/lib/abstract-notifications";

describe("buildAbstractDecisionVars", () => {
  it("heading and message follow the status; notes are wrapped in our block with the text escaped", () => {
    const v = buildAbstractDecisionVars({ status: "REVISION_REQUESTED", reviewNotes: "Fix <i>fig 2</i>", reviewScore: 61 });
    expect(v).toMatchObject({ newStatus: "REVISION REQUESTED", statusHeading: "Revision Requested", reviewScore: 61 });
    expect(String(v.reviewNotes)).toContain("Reviewer Notes");
    expect(String(v.reviewNotes)).toContain("Fix &lt;i&gt;fig 2&lt;/i&gt;");
  });
  it("no notes renders an empty block and no score stays undefined; feedback-only overrides the heading", () => {
    expect(buildAbstractDecisionVars({ status: "ACCEPTED", reviewNotes: null, reviewScore: null })).toMatchObject({ reviewNotes: "", reviewScore: undefined, statusHeading: "Abstract Accepted!" });
    expect(buildAbstractDecisionVars({ status: "ACCEPTED", reviewNotes: null, reviewScore: null, feedbackOnly: true }).statusHeading).toBe("Reviewer Feedback Received");
  });
});
