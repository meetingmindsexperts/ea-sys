/**
 * The approval emails: the right sentence for each moment, a link rather than
 * an approve button, every typed string escaped, and no em dash.
 */
import { describe, it, expect } from "vitest";
import { buildApprovalEmail, subjectWordFor, waitedPhrase, type ApprovalEmailInput } from "@/lib/approvals/approval-emails";

const base: Omit<ApprovalEmailInput, "kind"> = {
  recipientFirstName: "Lina",
  subjectWord: "spend request",
  subjectLabel: "PR-2026-0004 · LED wall",
  amountLine: "AED 5,000.00",
  requesterName: "Dev Admin",
  link: "https://events.example.test/procurement/approvals",
};

describe("buildApprovalEmail", () => {
  it("assignment: who asked, what, and where to decide", () => {
    const e = buildApprovalEmail({ ...base, kind: "assigned" });
    expect(e.subject).toBe("Approval needed: PR-2026-0004 · LED wall");
    expect(e.text).toContain("Dev Admin has asked for approval of a spend request.");
    expect(e.text).toContain("Decide it on the Approvals page in EA-SYS");
    expect(e.text).toContain("Open the Approvals page: https://events.example.test/procurement/approvals");
    expect(e.html).toContain('<a href="https://events.example.test/procurement/approvals">Open the Approvals page</a>');
    expect(e.html).not.toMatch(/approve<\/a>|>Approve</i);
  });
  it("reminder, delegation and escalation say how long it waited and on whom", () => {
    expect(buildApprovalEmail({ ...base, kind: "reminder", hoursWaiting: 25.5 }).text).toContain("has been waiting 25 hours for your decision.");
    const delegated = buildApprovalEmail({ ...base, kind: "delegated", recipientFirstName: "Medhat", previousApproverName: "Lina H", hoursWaiting: 49 });
    expect(delegated.subject).toBe("You can now approve: PR-2026-0004 · LED wall");
    expect(delegated.text).toContain("has waited 2 days for Lina H, so it has been passed to you as well. Either of you can decide it.");
    const escalated = buildApprovalEmail({ ...base, kind: "escalated", previousApproverName: "Lina H", hoursWaiting: 97 });
    expect(escalated.subject).toBe("Approval passed to you: PR-2026-0004 · LED wall");
    expect(escalated.text).toContain("waited 4 days without a decision from Lina H, so it now comes to you.");
  });
  it("stuck: tells an admin the approver can no longer decide and what unblocks it, without the approver footer", () => {
    const e = buildApprovalEmail({ ...base, kind: "stuck", previousApproverName: "Lina H", hoursWaiting: 30 });
    expect(e.subject).toContain("Nobody can approve: ");
    expect(e.text).toContain("is waiting on Lina H, who can no longer decide it, and nobody else holds an approval grant that covers it");
    expect(e.text).toContain("Give someone an approval grant that covers it");
    expect(e.text).not.toContain("cannot approve anything");
  });
  it("an over-budget exception says only the final approver decides it", () => {
    expect(buildApprovalEmail({ ...base, kind: "assigned", exception: true }).text).toContain("Over-budget exception: only the final approver decides it.");
  });
  it("the decision goes back to the requester with the note, and no approver footer", () => {
    const e = buildApprovalEmail({ ...base, kind: "decided", recipientFirstName: "Dev", decision: "REJECTED", deciderName: "Lina H", note: "Get a second quote", link: "https://events.example.test/procurement/requests/sr1" });
    expect(e.subject).toBe("Rejected: PR-2026-0004 · LED wall");
    expect(e.text).toContain("Lina H rejected your spend request.");
    expect(e.text).toContain("Note: Get a second quote");
    expect(e.text).toContain("Open it in EA-SYS: https://events.example.test/procurement/requests/sr1");
    expect(e.text).not.toContain("Approvals page");
    expect(buildApprovalEmail({ ...base, kind: "decided", decision: "APPROVED", deciderName: null, link: null }).text).toContain("The approver approved your spend request.");
  });
  it("escapes every typed string in the HTML, and leaves the text readable", () => {
    const e = buildApprovalEmail({
      ...base,
      kind: "decided",
      decision: "APPROVED",
      subjectLabel: 'PR-1 · <img src=x onerror="alert(1)">',
      requesterName: "<b>Dev</b>",
      deciderName: "<script>x</script>",
      note: "a & b <i>",
      recipientFirstName: "<Lina>",
    });
    expect(e.html).not.toContain("<img");
    expect(e.html).not.toContain("<script>");
    expect(e.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(e.html).toContain("a &amp; b &lt;i&gt;");
    expect(e.html).toContain("Hi &lt;Lina&gt;,");
    expect(e.text).toContain("a & b <i>");
  });
  it("omits the link when the app URL is not configured", () => {
    const e = buildApprovalEmail({ ...base, kind: "assigned", link: null });
    expect(e.html).not.toContain("<a ");
    expect(e.text).not.toContain("Open the Approvals page:");
  });
  it("never writes an em dash", () => {
    for (const kind of ["assigned", "escalated", "reminder", "delegated", "decided"] as const) {
      const e = buildApprovalEmail({ ...base, kind, hoursWaiting: 50, previousApproverName: "Lina", decision: "APPROVED", note: "ok", exception: true });
      expect(`${e.subject} ${e.text} ${e.html}`).not.toMatch(/\u2014/);
    }
  });
});

describe("waitedPhrase and subjectWordFor", () => {
  it("hours under two days, whole days after", () => {
    expect(waitedPhrase(1)).toBe("1 hour");
    expect(waitedPhrase(47.9)).toBe("47 hours");
    expect(waitedPhrase(48)).toBe("2 days");
    expect(waitedPhrase(-3)).toBe("0 hours");
  });
  it("names each subject in words, with the article right", () => {
    expect(subjectWordFor("BUDGET")).toBe("budget");
    expect(subjectWordFor("BUDGET_REALLOCATION")).toBe("move between budget lines");
    expect(subjectWordFor("SPEND_REQUEST", "AMENDMENT")).toBe("change to a spend request's amount");
    expect(buildApprovalEmail({ ...base, kind: "assigned", subjectWord: "amount change" }).text).toContain("approval of an amount change.");
  });
});
