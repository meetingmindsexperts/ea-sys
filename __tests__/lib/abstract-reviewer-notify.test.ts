/**
 * Reviewer emails. Since Nov 10, 2026 none is automatic: the organiser sends
 * the pool email from the Reviewers page, and "Send assignments" emails each
 * reviewer ONE message listing every assignment not emailed yet
 * (sendPendingAssignments), instead of one email per assignment.
 *
 * The rows are leased before the send and marked after it (review of
 * 2df0f9e6). This file pins the ORDER and the outcomes with a mocked client;
 * the race itself needs real Postgres and lives in
 * tests/integration-db/reviewer-assignment-claim.db.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendEmailSpy, speakerFindMany, userFindUnique, assignmentFindMany, assignmentUpdateMany, logger } = vi.hoisted(() => ({
  sendEmailSpy: vi.fn(),
  speakerFindMany: vi.fn(),
  userFindUnique: vi.fn(),
  assignmentFindMany: vi.fn(),
  assignmentUpdateMany: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));

import { ASSIGNMENT_CLAIM_TTL_MS, notifyReviewerPoolAdded, sendPendingAssignments } from "@/lib/abstract-reviewer-notify";
import { sendableAssignmentWhere } from "@/lib/abstract-reviewer-access";
import { getDefaultTemplate, getEventTemplate, renderAndWrap } from "@/lib/email";
import { DEFAULT_TEMPLATE_BODIES } from "@/lib/email-template-defaults";
import { findUnresolvedTokens } from "@/lib/template-tokens";

const JANE = { id: "u1", firstName: "Jane", lastName: "Doe", email: "jane@x.com", emailVerified: new Date() };
const ASSIGNMENT_TEMPLATE = {
  subject: "Abstracts for Review | {{eventName}}",
  htmlContent: "<p>Dear {{title}} {{lastName}}, as {{role}}:</p><p>{{abstractTitle}}</p><p>{{abstractCount}}</p>",
  textContent: "Dear {{title}} {{lastName}}, as {{role}}:\n  {{abstractTitle}}",
  branding: { eventName: "MedCon", emailCcAddresses: ["ops@example.com", "JANE@x.com"] },
};
const sendArgs = { eventId: "ev1", organizationId: "org1", reviewerUserId: "u1", triggeredByUserId: "admin1" };

const PENDING = [
  { id: "ar1", notifyClaimedAt: null },
  { id: "ar2", notifyClaimedAt: null },
];
const MINE = [
  { id: "ar1", role: "PRIMARY", abstract: { title: "Novel Therapy" } },
  { id: "ar2", role: "PRIMARY", abstract: { title: "Heart <Failure> & CBT" } },
];

/** The two reads: first the pending rows, then (by claim token) the rows this call owns. */
function assignmentReads(pending: unknown[], mine: unknown[]) {
  assignmentFindMany.mockImplementation(({ where }: { where: { notifyClaimToken?: string } }) =>
    Promise.resolve(where.notifyClaimToken ? mine : pending),
  );
}
const claimCall = () => assignmentUpdateMany.mock.calls.find(([arg]) => arg.data.notifyClaimToken)?.[0];
const markCall = () => assignmentUpdateMany.mock.calls.find(([arg]) => arg.data.notifiedAt)?.[0];
const releaseCall = () =>
  assignmentUpdateMany.mock.calls.find(([arg]) => arg.data.notifyClaimToken === null && !arg.data.notifiedAt)?.[0];
const sent = () => sendEmailSpy.mock.calls[0][0];

beforeEach(() => {
  vi.clearAllMocks();
  sendEmailSpy.mockResolvedValue({ success: true });
  speakerFindMany.mockResolvedValue([]);
  userFindUnique.mockResolvedValue(JANE);
  vi.mocked(getEventTemplate).mockResolvedValue(ASSIGNMENT_TEMPLATE);
  assignmentReads(PENDING, MINE);
  assignmentUpdateMany.mockResolvedValue({ count: 2 });
});

describe("sendPendingAssignments: one email per reviewer", () => {
  it("lists every unsent assignment in one email, then marks them notified", async () => {
    expect(await sendPendingAssignments(sendArgs)).toEqual({ ok: true, sent: 2, recorded: true, reclaimed: false });
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    expect(sent().subject).toBe("Abstracts for Review | MedCon");
    expect(sent().htmlContent).toContain("1. Novel Therapy<br>2. Heart &lt;Failure&gt; &amp; CBT");
    expect(sent().htmlContent).toMatch(/>2<\/p>/);
    expect(sent().textContent).toContain("1. Novel Therapy\n  2. Heart <Failure> & CBT");
    expect(sent().textContent).not.toContain("<br>");
    expect(sent().logContext).toMatchObject({ entityType: "USER", entityId: "u1", eventId: "ev1", templateSlug: "reviewer-assignment" });
    expect(markCall()).toEqual({
      where: { userId: "u1", notifyClaimToken: claimCall().data.notifyClaimToken },
      data: { notifiedAt: expect.any(Date), notifyClaimedAt: null, notifyClaimToken: null },
    });
  });

  it("asks for exactly what the page counts: the shared sendable rule", async () => {
    await sendPendingAssignments(sendArgs);
    expect(assignmentFindMany.mock.calls[0][0].where).toEqual({ ...sendableAssignmentWhere("ev1"), userId: "u1" });
    expect(sendableAssignmentWhere("ev1")).toEqual({
      notifiedAt: null,
      conflictFlag: false,
      abstract: { eventId: "ev1", status: { in: ["SUBMITTED", "UNDER_REVIEW", "REVISION_REQUESTED"] } },
    });
  });

  it("names the role when all share it, and says Reviewer when they differ", async () => {
    await sendPendingAssignments(sendArgs);
    expect(sent().textContent).toContain("as Primary reviewer:");
    assignmentReads(PENDING, [
      { id: "ar1", role: "PRIMARY", abstract: { title: "A" } },
      { id: "ar2", role: "SECONDARY", abstract: { title: "B" } },
    ]);
    await sendPendingAssignments(sendArgs);
    expect(sendEmailSpy.mock.calls[1][0].textContent).toContain("as Reviewer:");
  });

  it("copies the event's Auto-CC, never the reviewer themselves", async () => {
    await sendPendingAssignments(sendArgs);
    expect(sent().cc).toEqual([{ email: "ops@example.com" }]);
  });

  it("fills {{title}} from the reviewer's speaker record", async () => {
    speakerFindMany.mockResolvedValue([{ userId: "u1", email: "jane@x.com", title: "DR" }]);
    await sendPendingAssignments(sendArgs);
    expect(sent().textContent).toContain("Dear Dr. Doe");
  });

  it("sends nothing and claims nothing when nothing is pending", async () => {
    assignmentReads([], []);
    expect(await sendPendingAssignments(sendArgs)).toMatchObject({ ok: false, code: "NOTHING_PENDING" });
    expect(sendEmailSpy).not.toHaveBeenCalled();
    expect(assignmentUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses an unknown reviewer and a missing template without claiming or sending", async () => {
    userFindUnique.mockResolvedValueOnce(null);
    expect(await sendPendingAssignments(sendArgs)).toMatchObject({ ok: false, code: "REVIEWER_NOT_FOUND" });
    vi.mocked(getEventTemplate).mockResolvedValueOnce(null);
    expect(await sendPendingAssignments(sendArgs)).toMatchObject({ ok: false, code: "NO_TEMPLATE" });
    expect(sendEmailSpy).not.toHaveBeenCalled();
    expect(assignmentUpdateMany).not.toHaveBeenCalled();
  });

  it("an account that never accepted its invitation gets no digest: it has no password to log in with", async () => {
    userFindUnique.mockResolvedValue({ ...JANE, emailVerified: null });
    expect(await sendPendingAssignments(sendArgs)).toMatchObject({ ok: false, code: "ACCOUNT_NOT_SET_UP" });
    expect(sendEmailSpy).not.toHaveBeenCalled();
    expect(assignmentUpdateMany).not.toHaveBeenCalled();
  });
});

describe("the send lease: no duplicate, nothing silently lost", () => {
  it("claims BEFORE sending, with a WHERE on the row's own columns only", async () => {
    await sendPendingAssignments(sendArgs);
    const claimOrder = assignmentUpdateMany.mock.invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(sendEmailSpy.mock.invocationCallOrder[0]);
    const claim = claimCall();
    expect(claim.where).toEqual({
      id: { in: ["ar1", "ar2"] },
      userId: "u1",
      notifiedAt: null,
      conflictFlag: false,
      OR: [{ notifyClaimedAt: null }, { notifyClaimedAt: { lt: expect.any(Date) } }],
    });
    // A relation filter here would not be re-tested after a row lock wait.
    expect(claim.where).not.toHaveProperty("abstract");
    expect(claim.data).toEqual({ notifyClaimedAt: expect.any(Date), notifyClaimToken: expect.any(String) });
  });

  it("emails only the rows this call owns, read back by its token", async () => {
    assignmentReads(PENDING, [MINE[0]]);
    assignmentUpdateMany.mockResolvedValue({ count: 1 });
    expect(await sendPendingAssignments(sendArgs)).toMatchObject({ ok: true, sent: 1 });
    expect(assignmentFindMany.mock.calls[1][0].where).toEqual({ userId: "u1", notifyClaimToken: claimCall().data.notifyClaimToken });
    expect(sent().htmlContent).toContain("Novel Therapy");
    expect(sent().htmlContent).not.toContain("CBT");
  });

  it("another send holds every row: IN_PROGRESS, no claim, no email", async () => {
    assignmentReads([{ id: "ar1", notifyClaimedAt: new Date() }], MINE);
    expect(await sendPendingAssignments(sendArgs)).toMatchObject({ ok: false, code: "IN_PROGRESS" });
    expect(assignmentUpdateMany).not.toHaveBeenCalled();
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });

  it("losing the claim to a send that got there first: IN_PROGRESS, no email", async () => {
    assignmentUpdateMany.mockResolvedValue({ count: 0 });
    expect(await sendPendingAssignments(sendArgs)).toMatchObject({ ok: false, code: "IN_PROGRESS" });
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });

  it("a failed send releases the claim, so the rows stay pending and can be sent again", async () => {
    sendEmailSpy.mockResolvedValue({ success: false, error: "provider said no", code: "PROVIDER" });
    expect(await sendPendingAssignments(sendArgs)).toEqual({ ok: false, code: "SEND_FAILED", message: "The email could not be sent" });
    expect(releaseCall()).toEqual({
      where: { userId: "u1", notifyClaimToken: claimCall().data.notifyClaimToken, notifiedAt: null },
      data: { notifyClaimedAt: null, notifyClaimToken: null },
    });
    expect(markCall()).toBeUndefined();
  });

  it("a template fault reaches the organiser in its own words", async () => {
    sendEmailSpy.mockResolvedValue({ success: false, error: "Email not sent: it still contains {{venue}}", code: "UNRESOLVED_TOKENS" });
    expect(await sendPendingAssignments(sendArgs)).toMatchObject({ code: "SEND_FAILED", message: "Email not sent: it still contains {{venue}}" });
  });

  it("never throws, and a throwing send releases too", async () => {
    sendEmailSpy.mockRejectedValue(new Error("SES down"));
    await expect(sendPendingAssignments(sendArgs)).resolves.toMatchObject({ ok: false, code: "SEND_FAILED" });
    expect(releaseCall()).toBeDefined();
  });

  it("sent but not recorded is NOT a failed send: ok, logged at error, claim kept", async () => {
    assignmentUpdateMany.mockImplementation(({ data }: { data: { notifiedAt?: Date } }) =>
      data.notifiedAt ? Promise.reject(new Error("db unreachable")) : Promise.resolve({ count: 2 }),
    );
    expect(await sendPendingAssignments(sendArgs)).toEqual({ ok: true, sent: 2, recorded: false, reclaimed: false });
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    expect(releaseCall()).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "reviewer-assignment:sent-not-recorded", count: 2 }));
  });

  it("takes over a claim older than the lease and says the earlier send was interrupted", async () => {
    const old = new Date(Date.now() - ASSIGNMENT_CLAIM_TTL_MS - 60_000);
    assignmentReads([{ id: "ar1", notifyClaimedAt: old }, { id: "ar2", notifyClaimedAt: null }], MINE);
    expect(await sendPendingAssignments(sendArgs)).toMatchObject({ ok: true, reclaimed: true });
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "reviewer-assignment:interrupted-send-reclaimed", rows: 1 }));
  });
});

describe("what the titles become in each part of the email", () => {
  const withTemplate = (over: Partial<typeof ASSIGNMENT_TEMPLATE>) =>
    vi.mocked(getEventTemplate).mockResolvedValue({ ...ASSIGNMENT_TEMPLATE, ...over });

  it("a subject using {{abstractTitle}} gets plain text, never entities or <br>", async () => {
    withTemplate({ subject: "Assigned: {{abstractTitle}}" });
    await sendPendingAssignments(sendArgs);
    expect(sent().subject).toBe("Assigned: 2 abstracts");
    assignmentReads(PENDING, [MINE[1]]);
    await sendPendingAssignments(sendArgs);
    expect(sendEmailSpy.mock.calls[1][0].subject).toBe("Assigned: Heart <Failure> & CBT");
  });

  it("one abstract is not numbered", async () => {
    assignmentReads(PENDING, [MINE[0]]);
    await sendPendingAssignments(sendArgs);
    expect(sent().htmlContent).toContain(">Novel Therapy<");
    expect(sent().textContent).toContain("\n  Novel Therapy");
    expect(sent().textContent).not.toContain("1. ");
  });

  it("a title holding {{...}} or line breaks cannot get the whole email refused or split a subject", async () => {
    withTemplate({ subject: "Assigned: {{abstractTitle}}" });
    assignmentReads(PENDING, [{ id: "ar1", role: "PRIMARY", abstract: { title: "Role of {{IL-6}}\nin  heart\tfailure" } }]);
    await sendPendingAssignments(sendArgs);
    expect(sent().subject).toBe("Assigned: Role of { {IL-6} } in heart failure");
    expect(findUnresolvedTokens(sent().subject, sent().htmlContent)).toEqual([]);
  });

  it("an apostrophe is escaped in the HTML list (the shared five-character helper)", async () => {
    assignmentReads(PENDING, [{ id: "ar1", role: "PRIMARY", abstract: { title: "Crohn's disease" } }]);
    await sendPendingAssignments(sendArgs);
    expect(sent().htmlContent).toContain("Crohn&#39;s disease");
    expect(sent().textContent).toContain("Crohn's disease");
  });

  it.each([1, 3])("the REAL default reads right and leaves no token for %i abstract(s)", async (n) => {
    const def = DEFAULT_TEMPLATE_BODIES["reviewer-assignment"];
    vi.mocked(getEventTemplate).mockResolvedValue({ ...def, branding: { eventName: "MedCon" } });
    assignmentReads(PENDING, MINE.concat([{ id: "ar3", role: "PRIMARY", abstract: { title: "Third" } }]).slice(0, n));
    await sendPendingAssignments(sendArgs);
    expect(findUnresolvedTokens(sent().subject, sent().htmlContent)).toEqual([]);
    expect(findUnresolvedTokens(sent().textContent)).toEqual([]);
    expect(sent().textContent).not.toMatch(/the following abstract|Review Abstract|this abstract/);
    expect(sent().subject).toBe("Your abstract review assignment for MedCon");
  });
});

describe("notifyReviewerPoolAdded", () => {
  const poolArgs = { eventId: "ev1", organizationId: "org1", reviewer: JANE, eventName: "MedCon", triggeredByUserId: "admin1" };

  beforeEach(() => vi.mocked(getEventTemplate).mockResolvedValue(null));

  it("emails the reviewer the pool-invitation with USER log context and says it went", async () => {
    expect(await notifyReviewerPoolAdded(poolArgs)).toEqual({ ok: true });
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    expect(sent().to).toEqual([{ email: "jane@x.com", name: "Jane Doe" }]);
    expect(sent().logContext).toMatchObject({ entityType: "USER", entityId: "u1", eventId: "ev1", templateSlug: "reviewer-pool-invitation" });
  });

  it("a refused send is reported, not swallowed (the row button said 'sent' whatever happened)", async () => {
    sendEmailSpy.mockResolvedValueOnce({ success: false, error: "Email not sent: it still contains {{title}}", code: "UNRESOLVED_TOKENS" });
    expect(await notifyReviewerPoolAdded(poolArgs)).toEqual({ ok: false, code: "SEND_FAILED", message: "Email not sent: it still contains {{title}}" });
  });

  it("does not throw if the email send throws", async () => {
    sendEmailSpy.mockRejectedValueOnce(new Error("SES down"));
    await expect(notifyReviewerPoolAdded(poolArgs)).resolves.toMatchObject({ ok: false, code: "SEND_FAILED" });
  });

  it("skips sending when no template is configured", async () => {
    vi.mocked(getDefaultTemplate).mockReturnValueOnce(undefined);
    expect(await notifyReviewerPoolAdded(poolArgs)).toMatchObject({ ok: false, code: "NO_TEMPLATE" });
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
