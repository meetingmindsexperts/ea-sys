/**
 * Per-abstract reviewer-assignment notification. Both the REST assign route and
 * the MCP assign_reviewer_to_abstract executor call notifyReviewerAssigned on a
 * NEW assignment; previously a reviewer was assigned to an abstract silently.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendEmailSpy, speakerFindMany } = vi.hoisted(() => ({
  sendEmailSpy: vi.fn().mockResolvedValue(undefined),
  speakerFindMany: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/db", () => ({ db: { speaker: { findMany: speakerFindMany } } }));

vi.mock("@/lib/email", () => ({
  sendEmail: sendEmailSpy,
  loadActiveEventTemplateRow: vi.fn(),
  getEventTemplate: vi.fn().mockResolvedValue(null),
  getDefaultTemplate: vi.fn().mockReturnValue({ slug: "reviewer-assignment", subject: "s", htmlContent: "h", textContent: "t" }),
  renderAndWrap: vi.fn().mockImplementation((_tpl: unknown, vars: { role: string; abstractTitle: string }) => ({
    subject: `Assigned: ${vars.role}`,
    html: `<p>${vars.abstractTitle}</p>`,
    text: vars.abstractTitle,
  })),
  brandingFrom: vi.fn().mockReturnValue({ email: "from@x.com" }),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { notifyReviewerAssigned, notifyReviewerPoolAdded } from "@/lib/abstract-reviewer-notify";
import { getDefaultTemplate } from "@/lib/email";

const baseArgs = {
  eventId: "ev1",
  organizationId: "org1",
  reviewer: { id: "u1", firstName: "Jane", lastName: "Doe", email: "jane@x.com" },
  eventName: "MedCon",
  abstractTitle: "Novel Therapy",
  role: "PRIMARY",
  source: "rest" as const,
  triggeredByUserId: "admin1",
};

beforeEach(() => vi.clearAllMocks());

describe("notifyReviewerAssigned", () => {
  it("emails the reviewer with the role label + abstract title + USER log context", async () => {
    await notifyReviewerAssigned(baseArgs);
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    const call = sendEmailSpy.mock.calls[0][0];
    expect(call.to).toEqual([{ email: "jane@x.com", name: "Jane Doe" }]);
    expect(call.logContext).toMatchObject({
      entityType: "USER",
      entityId: "u1",
      eventId: "ev1",
      organizationId: "org1",
      templateSlug: "reviewer-assignment",
      triggeredByUserId: "admin1",
    });
    expect(call.subject).toContain("Primary reviewer"); // PRIMARY → friendly label
    expect(call.html).toContain("Novel Therapy");
  });

  it("maps each role to a friendly label", async () => {
    await notifyReviewerAssigned({ ...baseArgs, role: "CONSULTING" });
    expect(sendEmailSpy.mock.calls[0][0].subject).toContain("Consulting reviewer");
  });

  it("falls back to the raw email as the name when names are null", async () => {
    await notifyReviewerAssigned({ ...baseArgs, reviewer: { id: "u2", firstName: null, lastName: null, email: "anon@x.com" } });
    expect(sendEmailSpy.mock.calls[0][0].to).toEqual([{ email: "anon@x.com", name: "anon@x.com" }]);
  });

  it("does not throw if the email send fails (failure-isolated)", async () => {
    sendEmailSpy.mockRejectedValueOnce(new Error("SES down"));
    await expect(notifyReviewerAssigned(baseArgs)).resolves.toBeUndefined();
  });

  it("skips sending when no template is configured", async () => {
    vi.mocked(getDefaultTemplate).mockReturnValueOnce(undefined);
    await notifyReviewerAssigned(baseArgs);
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });
});

describe("notifyReviewerPoolAdded", () => {
  const poolArgs = {
    eventId: "ev1",
    organizationId: "org1",
    reviewer: { id: "u1", firstName: "Jane", lastName: "Doe", email: "jane@x.com" },
    eventName: "MedCon",
    triggeredByUserId: "admin1",
  };

  it("emails the reviewer the pool-invitation with USER log context", async () => {
    await notifyReviewerPoolAdded(poolArgs);
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    const call = sendEmailSpy.mock.calls[0][0];
    expect(call.to).toEqual([{ email: "jane@x.com", name: "Jane Doe" }]);
    expect(call.logContext).toMatchObject({
      entityType: "USER",
      entityId: "u1",
      eventId: "ev1",
      templateSlug: "reviewer-pool-invitation",
    });
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
});

describe("{{title}} in the reviewer emails (Nov 10, 2026)", () => {
  it("fills it from the reviewer's speaker record on the event, for both emails", async () => {
    speakerFindMany.mockResolvedValue([{ userId: "u1", email: "jane@x.com", title: "DR" }]);
    const { renderAndWrap } = await import("@/lib/email");
    await notifyReviewerAssigned(baseArgs);
    await notifyReviewerPoolAdded({ eventId: "ev1", organizationId: "org1", reviewer: baseArgs.reviewer, eventName: "MedCon" });
    const calls = vi.mocked(renderAndWrap).mock.calls;
    expect(calls[0][1]).toMatchObject({ title: "Dr.", lastName: "Doe" });
    expect(calls[1][1]).toMatchObject({ title: "Dr.", lastName: "Doe" });
    expect(speakerFindMany.mock.calls[0][0].where).toEqual({
      eventId: "ev1",
      OR: [{ userId: { in: ["u1"] } }, { email: { equals: "jane@x.com", mode: "insensitive" } }],
    });
  });

  it("prefers the account-linked speaker record over an older one at the address", async () => {
    speakerFindMany.mockResolvedValue([
      { userId: null, email: "JANE@x.com", title: "MS" },
      { userId: "u1", email: "old@x.com", title: "PROF" },
    ]);
    const { renderAndWrap } = await import("@/lib/email");
    await notifyReviewerAssigned(baseArgs);
    expect(vi.mocked(renderAndWrap).mock.calls[0][1]).toMatchObject({ title: "Prof." });
  });

  it("is empty, never missing, when there is no speaker record, so the send is not refused", async () => {
    speakerFindMany.mockResolvedValue([]);
    const { renderAndWrap } = await import("@/lib/email");
    await notifyReviewerAssigned(baseArgs);
    expect(vi.mocked(renderAndWrap).mock.calls[0][1]).toHaveProperty("title", "");
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
  });

  it("a failed lookup never costs the reviewer their email", async () => {
    speakerFindMany.mockRejectedValue(new Error("pool timeout"));
    const { renderAndWrap } = await import("@/lib/email");
    await notifyReviewerAssigned(baseArgs);
    expect(vi.mocked(renderAndWrap).mock.calls[0][1]).toHaveProperty("title", "");
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
  });
});
