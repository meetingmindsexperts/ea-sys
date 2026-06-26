/**
 * Per-abstract reviewer-assignment notification. Both the REST assign route and
 * the MCP assign_reviewer_to_abstract executor call notifyReviewerAssigned on a
 * NEW assignment; previously a reviewer was assigned to an abstract silently.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendEmailSpy } = vi.hoisted(() => ({ sendEmailSpy: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@/lib/email", () => ({
  sendEmail: sendEmailSpy,
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

import { notifyReviewerAssigned } from "@/lib/abstract-reviewer-notify";
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
