/**
 * notifyAbstractStatusChange ANSWERS what became of the author's email
 * (review of 9fd484fd, Nov 19, 2026). It never throws and used to return
 * nothing, so every caller read "no throw" as "sent": a send the mail service
 * refused, or an author with no address, was reported as emailed, and a bulk
 * change told the organiser 165 authors had been told when none had.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendEmailSpy, logger, adminSpy } = vi.hoisted(() => ({
  sendEmailSpy: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  adminSpy: vi.fn(),
}));

vi.mock("@/lib/email", () => ({
  sendEmail: sendEmailSpy,
  loadActiveEventTemplateRow: vi.fn(),
  getEventTemplate: vi.fn().mockResolvedValue(null),
  getDefaultTemplate: vi.fn().mockReturnValue({ slug: "tpl", subject: "s", htmlContent: "h", textContent: "t" }),
  renderAndWrap: vi.fn().mockReturnValue({ subject: "s", htmlContent: "h", textContent: "t" }),
  getAbstractStatusInfo: vi.fn().mockReturnValue({ heading: "Accepted", message: "m" }),
  brandingFrom: vi.fn().mockReturnValue({ email: "from@x.com" }),
  brandingCc: vi.fn().mockReturnValue(undefined),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: adminSpy }));
vi.mock("@/lib/db", () => ({
  db: { abstract: { findUnique: vi.fn().mockResolvedValue({ presentationType: "ORAL", coAuthors: null, theme: null }) } },
}));

import { notifyAbstractStatusChange } from "@/lib/abstract-notifications";

const params = (over: Record<string, unknown> = {}) => ({
  eventId: "ev1",
  organizationId: "org1",
  eventName: "MedCon",
  eventSlug: "medcon",
  abstractId: "ab1",
  abstractTitle: "A study",
  previousStatus: "UNDER_REVIEW",
  newStatus: "ACCEPTED",
  reviewNotes: null,
  reviewScore: 80,
  speaker: { id: "sp1", email: "author@x.com" as string | null, firstName: "Jane", lastName: "Doe" },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  sendEmailSpy.mockResolvedValue({ success: true });
  adminSpy.mockResolvedValue(undefined);
});

describe("notifyAbstractStatusChange: what became of the email", () => {
  it("'sent' when the mail service took it", async () => {
    expect(await notifyAbstractStatusChange(params())).toBe("sent");
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
  });

  it("'failed' when the mail service refused it (a token left in the event's template), logged with the reason", async () => {
    sendEmailSpy.mockResolvedValue({ success: false, code: "UNRESOLVED_TOKENS", error: "Unknown token {{abstractTitel}}" });
    expect(await notifyAbstractStatusChange(params())).toBe("failed");
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "abstract-notification:email-refused", code: "UNRESOLVED_TOKENS" }));
  });

  it("'failed', never a throw, when the send itself throws", async () => {
    sendEmailSpy.mockRejectedValue(new Error("provider down"));
    expect(await notifyAbstractStatusChange(params())).toBe("failed");
  });

  it("'no-recipient' for an author with no address: nothing is sent, it is logged, and the admins still hear", async () => {
    expect(await notifyAbstractStatusChange(params({ speaker: { id: "sp1", email: null, firstName: "Jane", lastName: "Doe" } }))).toBe("no-recipient");
    expect(sendEmailSpy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "abstract-notification:author-has-no-email" }));
    expect(adminSpy).toHaveBeenCalledTimes(1);
  });

  it("'not-due' when the status did not change into a review status: nothing is sent to anyone", async () => {
    expect(await notifyAbstractStatusChange(params({ newStatus: "WITHDRAWN" }))).toBe("not-due");
    expect(await notifyAbstractStatusChange(params({ previousStatus: "ACCEPTED" }))).toBe("not-due");
    expect(sendEmailSpy).not.toHaveBeenCalled();
    expect(adminSpy).not.toHaveBeenCalled();
  });
});
