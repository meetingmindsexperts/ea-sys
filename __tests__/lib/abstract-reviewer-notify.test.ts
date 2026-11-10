/**
 * Reviewer emails. Since Nov 10, 2026 none is automatic: the organiser sends
 * the pool email from the Reviewers page, and "Send assignments" emails each
 * reviewer ONE message listing every assignment not emailed yet
 * (sendPendingAssignments), instead of one email per assignment.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendEmailSpy, speakerFindMany, userFindUnique, assignmentFindMany, assignmentUpdateMany } = vi.hoisted(() => ({
  sendEmailSpy: vi.fn(),
  speakerFindMany: vi.fn(),
  userFindUnique: vi.fn(),
  assignmentFindMany: vi.fn(),
  assignmentUpdateMany: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    speaker: { findMany: speakerFindMany },
    user: { findUnique: userFindUnique },
    abstractReviewer: { findMany: assignmentFindMany, updateMany: assignmentUpdateMany },
  },
}));

vi.mock("@/lib/email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
  return {
    sendEmail: sendEmailSpy,
    brandingCc: actual.brandingCc,
    getEventTemplate: vi.fn(),
    getDefaultTemplate: vi.fn().mockReturnValue({ slug: "reviewer-pool-invitation", subject: "s", htmlContent: "h", textContent: "t" }),
    renderAndWrap: vi.fn(actual.renderAndWrap),
    brandingFrom: vi.fn().mockReturnValue({ email: "from@x.com" }),
  };
});
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { notifyReviewerPoolAdded, sendPendingAssignments } from "@/lib/abstract-reviewer-notify";
import { getDefaultTemplate, getEventTemplate, renderAndWrap } from "@/lib/email";

const JANE = { id: "u1", firstName: "Jane", lastName: "Doe", email: "jane@x.com" };
const ASSIGNMENT_TEMPLATE = {
  subject: "Abstracts for Review | {{eventName}}",
  htmlContent: "<p>Dear {{title}} {{lastName}}, as {{role}}:</p><p>{{abstractTitle}}</p><p>{{abstractCount}}</p>",
  textContent: "Dear {{title}} {{lastName}}, as {{role}}:\n  {{abstractTitle}}",
  branding: { eventName: "MedCon", emailCcAddresses: ["ops@example.com", "JANE@x.com"] },
};
const sendArgs = { eventId: "ev1", organizationId: "org1", reviewerUserId: "u1", triggeredByUserId: "admin1" };

beforeEach(() => {
  vi.clearAllMocks();
  sendEmailSpy.mockResolvedValue({ success: true });
  speakerFindMany.mockResolvedValue([]);
  userFindUnique.mockResolvedValue(JANE);
  vi.mocked(getEventTemplate).mockResolvedValue(ASSIGNMENT_TEMPLATE);
  assignmentFindMany.mockResolvedValue([
    { id: "ar1", role: "PRIMARY", abstract: { title: "Novel Therapy" } },
    { id: "ar2", role: "PRIMARY", abstract: { title: "Heart <Failure> & CBT" } },
  ]);
  assignmentUpdateMany.mockResolvedValue({ count: 2 });
});

describe("sendPendingAssignments: one email per reviewer", () => {
  it("lists every unsent assignment in one email, then marks them notified", async () => {
    const r = await sendPendingAssignments(sendArgs);
    expect(r).toEqual({ ok: true, sent: 2 });
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    const call = sendEmailSpy.mock.calls[0][0];
    expect(call.subject).toBe("Abstracts for Review | MedCon");
    expect(call.htmlContent).toContain("Novel Therapy<br>Heart &lt;Failure&gt; &amp; CBT");
    expect(call.htmlContent).toMatch(/>2<\/p>/);
    expect(call.textContent).toContain("Novel Therapy\n  Heart <Failure> & CBT");
    expect(call.textContent).not.toContain("<br>");
    expect(call.logContext).toMatchObject({ entityType: "USER", entityId: "u1", eventId: "ev1", templateSlug: "reviewer-assignment" });
    expect(assignmentUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["ar1", "ar2"] }, notifiedAt: null },
      data: { notifiedAt: expect.any(Date) },
    });
  });

  it("asks only for this event's unsent, unconflicted assignments still up for review", async () => {
    await sendPendingAssignments(sendArgs);
    expect(assignmentFindMany.mock.calls[0][0].where).toEqual({
      userId: "u1",
      notifiedAt: null,
      conflictFlag: false,
      abstract: { eventId: "ev1", status: { in: ["SUBMITTED", "UNDER_REVIEW", "REVISION_REQUESTED"] } },
    });
  });

  it("names the role when all share it, and says Reviewer when they differ", async () => {
    await sendPendingAssignments(sendArgs);
    expect(sendEmailSpy.mock.calls[0][0].textContent).toContain("as Primary reviewer:");
    assignmentFindMany.mockResolvedValue([
      { id: "ar1", role: "PRIMARY", abstract: { title: "A" } },
      { id: "ar2", role: "SECONDARY", abstract: { title: "B" } },
    ]);
    await sendPendingAssignments(sendArgs);
    expect(sendEmailSpy.mock.calls[1][0].textContent).toContain("as Reviewer:");
  });

  it("copies the event's Auto-CC, never the reviewer themselves", async () => {
    await sendPendingAssignments(sendArgs);
    expect(sendEmailSpy.mock.calls[0][0].cc).toEqual([{ email: "ops@example.com" }]);
  });

  it("fills {{title}} from the reviewer's speaker record", async () => {
    speakerFindMany.mockResolvedValue([{ userId: "u1", email: "jane@x.com", title: "DR" }]);
    await sendPendingAssignments(sendArgs);
    expect(sendEmailSpy.mock.calls[0][0].textContent).toContain("Dear Dr. Doe");
  });

  it("sends nothing and marks nothing when nothing is pending", async () => {
    assignmentFindMany.mockResolvedValue([]);
    expect(await sendPendingAssignments(sendArgs)).toMatchObject({ ok: false, code: "NOTHING_PENDING" });
    expect(sendEmailSpy).not.toHaveBeenCalled();
    expect(assignmentUpdateMany).not.toHaveBeenCalled();
  });

  it("leaves them pending when the send fails, so they can be sent again", async () => {
    sendEmailSpy.mockResolvedValue({ success: false, error: "refused", code: "UNRESOLVED_TOKENS" });
    expect(await sendPendingAssignments(sendArgs)).toMatchObject({ ok: false, code: "SEND_FAILED" });
    expect(assignmentUpdateMany).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    sendEmailSpy.mockRejectedValue(new Error("SES down"));
    await expect(sendPendingAssignments(sendArgs)).resolves.toMatchObject({ ok: false, code: "SEND_FAILED" });
  });

  it("refuses an unknown reviewer and a missing template without sending", async () => {
    userFindUnique.mockResolvedValueOnce(null);
    expect(await sendPendingAssignments(sendArgs)).toMatchObject({ ok: false, code: "REVIEWER_NOT_FOUND" });
    vi.mocked(getEventTemplate).mockResolvedValueOnce(null);
    expect(await sendPendingAssignments(sendArgs)).toMatchObject({ ok: false, code: "NO_TEMPLATE" });
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });
});

describe("notifyReviewerPoolAdded", () => {
  const poolArgs = { eventId: "ev1", organizationId: "org1", reviewer: JANE, eventName: "MedCon", triggeredByUserId: "admin1" };

  beforeEach(() => vi.mocked(getEventTemplate).mockResolvedValue(null));

  it("emails the reviewer the pool-invitation with USER log context", async () => {
    await notifyReviewerPoolAdded(poolArgs);
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    const call = sendEmailSpy.mock.calls[0][0];
    expect(call.to).toEqual([{ email: "jane@x.com", name: "Jane Doe" }]);
    expect(call.logContext).toMatchObject({ entityType: "USER", entityId: "u1", eventId: "ev1", templateSlug: "reviewer-pool-invitation" });
  });

  it("does not throw if the email send fails (failure-isolated)", async () => {
    sendEmailSpy.mockRejectedValueOnce(new Error("SES down"));
    await expect(notifyReviewerPoolAdded(poolArgs)).resolves.toBeUndefined();
  });

  it("skips sending when no template is configured", async () => {
    vi.mocked(getDefaultTemplate).mockReturnValueOnce(undefined);
    await notifyReviewerPoolAdded(poolArgs);
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });

  it("fills {{title}} from the speaker record, the account-linked one first", async () => {
    speakerFindMany.mockResolvedValue([
      { userId: null, email: "JANE@x.com", title: "MS" },
      { userId: "u1", email: "old@x.com", title: "PROF" },
    ]);
    await notifyReviewerPoolAdded(poolArgs);
    expect(vi.mocked(renderAndWrap).mock.calls[0][1]).toMatchObject({ title: "Prof.", lastName: "Doe" });
    expect(speakerFindMany.mock.calls[0][0].where).toEqual({
      eventId: "ev1",
      OR: [{ userId: { in: ["u1"] } }, { email: { equals: "jane@x.com", mode: "insensitive" } }],
    });
  });

  it("an empty or failed title lookup never costs the reviewer their email", async () => {
    speakerFindMany.mockRejectedValue(new Error("pool timeout"));
    await notifyReviewerPoolAdded(poolArgs);
    expect(vi.mocked(renderAndWrap).mock.calls[0][1]).toHaveProperty("title", "");
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
  });
});
