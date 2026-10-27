import { describe, expect, it } from "vitest";
import { withVisibleSubmissions } from "@/lib/speaker-submission-visibility";

const row = () => ({
  id: "s1",
  abstracts: [{ id: "a1", title: "Secret title", status: "SUBMITTED" }],
  sessionProposals: [{ status: "SUBMITTED" }],
  submitterSource: "both" as string | null,
  _count: { sessions: 2, abstracts: 1 },
});

describe("withVisibleSubmissions", () => {
  it("keeps the row as it is when both are readable", () => {
    const s = row();
    expect(withVisibleSubmissions(s, { abstracts: true, proposals: true })).toBe(s);
  });

  it("drops the abstracts and their count without abstracts.read", () => {
    const out = withVisibleSubmissions(row(), { abstracts: false, proposals: true });
    expect(out).not.toHaveProperty("abstracts");
    expect(out._count).toEqual({ sessions: 2 });
    expect(out.sessionProposals).toEqual([{ status: "SUBMITTED" }]);
    expect(JSON.stringify(out)).not.toContain("Secret title");
  });

  it("drops the proposals without proposals.read", () => {
    const out = withVisibleSubmissions(row(), { abstracts: true, proposals: false });
    expect(out).not.toHaveProperty("sessionProposals");
    expect(out.abstracts).toHaveLength(1);
    expect(out._count).toEqual({ sessions: 2, abstracts: 1 });
  });

  it("drops the sign-up door unless both are readable: it says what the person came to submit (review LOW)", () => {
    expect(withVisibleSubmissions(row(), { abstracts: true, proposals: true }).submitterSource).toBe("both");
    for (const v of [{ abstracts: false, proposals: true }, { abstracts: true, proposals: false }, { abstracts: false, proposals: false }]) {
      expect(withVisibleSubmissions(row(), v)).not.toHaveProperty("submitterSource");
    }
  });

  it("does not change the row it was given", () => {
    const s = row();
    withVisibleSubmissions(s, { abstracts: false, proposals: false });
    expect(s.abstracts).toHaveLength(1);
    expect(s._count.abstracts).toBe(1);
  });
});
