/**
 * Request ID and document (Nov 4, 2026): who gets a link, who is skipped and
 * why, and that a link whose email failed is not left alive.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, sendEmailSpy, renderedVars } = vi.hoisted(() => {
  // Token hashing needs it; CI has no .env.
  process.env.NEXTAUTH_SECRET = "test-secret";
  return {
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findMany: vi.fn() },
    verificationToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn().mockResolvedValue({}) },
  },
  sendEmailSpy: vi.fn(),
  renderedVars: [] as Record<string, string>[],
  };
});

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/email", async (importOriginal) => ({
  getEventTemplate: vi.fn().mockResolvedValue({
    subject: "s", htmlContent: "{{evidenceItems}} {{evidenceLink}}", textContent: "t",
    branding: { emailCcAddresses: ["Office@Event.org", "r1@x.org"] },
  }),
  renderAndWrap: (_t: unknown, vars: Record<string, string>) => {
    renderedVars.push(vars);
    return { subject: "s", htmlContent: `${vars.evidenceItems}|${vars.evidenceLink}`, textContent: "t" };
  },
  brandingFrom: () => undefined,
  // The real rule: the event's addresses, then the person's own, never the recipient twice.
  brandingCc: (await importOriginal<typeof import("@/lib/email")>()).brandingCc,
  sendEmail: sendEmailSpy,
}));

import { sendEvidenceRequests } from "@/services/evidence-request-service";

const STUDENT_TYPE = {
  name: "Student",
  requiresMemberId: false,
  requiresStudentId: true,
  requiresStudentIdExpiry: true,
  requiresDocument: true,
  documentRequired: true,
  documentLabel: "Valid Student ID",
  documentInstructions: null,
};
const person = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  status: "CONFIRMED",
  supportingDocumentUrl: null,
  ticketType: STUDENT_TYPE,
  attendee: { title: null, firstName: "A", lastName: id, email: `${id}@x.org`, memberId: null, studentId: null, studentIdExpiry: null },
  ...over,
});

const INPUT = {
  eventId: "ev1",
  organizationId: "org1",
  expiryDays: 14,
  appUrl: "https://events.example",
  actorUserId: "u1",
};

beforeEach(() => {
  vi.clearAllMocks();
  renderedVars.length = 0;
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", slug: "MEHF2027", timezone: "Asia/Dubai" });
  sendEmailSpy.mockResolvedValue({ success: true });
});

describe("sendEvidenceRequests", () => {
  it("emails each person their own link, listing what their type still needs", async () => {
    mockDb.registration.findMany.mockResolvedValue([person("r1", { attendee: { ...person("r1").attendee, studentId: "S1" } })]);
    const res = await sendEvidenceRequests({ ...INPUT, registrationIds: ["r1"] });
    expect(res).toMatchObject({ ok: true, sent: 1, skipped: [] });
    const html = sendEmailSpy.mock.calls[0][0].htmlContent as string;
    expect(html).toContain("Student ID expiry date, Valid Student ID");
    expect(html).not.toContain("Student ID,");
    expect(html).toMatch(/https:\/\/events\.example\/e\/MEHF2027\/verify-details\?token=[0-9a-f]{64}/);
    expect(mockDb.verificationToken.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ identifier: "evidence:r1" }) }),
    );
  });

  // Organiser-reported, Nov 20, 2026: the email read "Dear DR. ..." and no copy
  // reached anyone. MUTATION: restore `${title}.` and the first fails; drop the
  // cc line and the second fails.
  it("greets with the title as it is written, \"Dr.\", never the stored value with a full stop", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      person("r1", { attendee: { ...person("r1").attendee, title: "DR" } }),
      person("r2"),
    ]);
    await sendEvidenceRequests({ ...INPUT, registrationIds: ["r1", "r2"] });
    expect(renderedVars.map((v) => v.title)).toEqual(["Dr.", ""]);
  });

  it("copies the event's CC addresses and the person's additional email, and never the recipient again", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      person("r1", { attendee: { ...person("r1").attendee, additionalEmail: "second@home.org" } }),
    ]);
    await sendEvidenceRequests({ ...INPUT, registrationIds: ["r1"] });
    // r1@x.org is on the event's list too: it is the recipient, so it is not copied.
    expect(sendEmailSpy.mock.calls[0][0].cc).toEqual([{ email: "office@event.org" }, { email: "second@home.org" }]);
    expect(mockDb.registration.findMany.mock.calls[0][0].select.attendee.select).toMatchObject({ additionalEmail: true });
  });

  it("skips, with a reason each, anyone with nothing to give", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      person("cancelled", { status: "CANCELLED" }),
      person("physician", { ticketType: { ...STUDENT_TYPE, requiresStudentId: false, requiresStudentIdExpiry: false, requiresDocument: false } }),
      person("complete", {
        supportingDocumentUrl: "/uploads/resident-letters/ev1/x.pdf",
        attendee: { ...person("complete").attendee, studentId: "S", studentIdExpiry: new Date() },
      }),
    ]);
    const res = await sendEvidenceRequests({ ...INPUT, registrationIds: ["cancelled", "physician", "complete", "gone"] });
    expect(res).toMatchObject({ ok: true, sent: 0 });
    expect(res.ok && res.skipped).toEqual([
      { registrationId: "cancelled", reason: "CANCELLED" },
      { registrationId: "physician", reason: "NOTHING_ASKED" },
      { registrationId: "complete", reason: "NOTHING_MISSING" },
      { registrationId: "gone", reason: "NOT_FOUND" },
    ]);
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });

  it("revokes the link of an email that failed, so no live link exists nobody received", async () => {
    mockDb.registration.findMany.mockResolvedValue([person("r1")]);
    sendEmailSpy.mockResolvedValue({ success: false, error: "bounced" });
    const res = await sendEvidenceRequests({ ...INPUT, registrationIds: ["r1"] });
    expect(res).toMatchObject({ ok: true, sent: 0 });
    expect(res.ok && res.errors[0]).toContain("bounced");
    // Once before minting (replacing an older link), once after the failure.
    expect(mockDb.verificationToken.deleteMany).toHaveBeenCalledTimes(2);
  });

  it("refuses an event outside the organisation", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    expect(await sendEvidenceRequests({ ...INPUT, registrationIds: ["r1"] })).toMatchObject({ ok: false, code: "EVENT_NOT_FOUND" });
  });
});
