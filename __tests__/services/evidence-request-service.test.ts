/**
 * Request ID and document (Nov 4, 2026): who gets a link, who is skipped and
 * why, and that a link whose email failed is not left alive.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, sendEmailSpy } = vi.hoisted(() => {
  // Token hashing needs it; CI has no .env.
  process.env.NEXTAUTH_SECRET = "test-secret";
  return {
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findMany: vi.fn() },
    verificationToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn().mockResolvedValue({}) },
  },
  sendEmailSpy: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/email", () => ({
  getEventTemplate: vi.fn().mockResolvedValue({ subject: "s", htmlContent: "{{evidenceItems}} {{evidenceLink}}", textContent: "t", branding: {} }),
  renderAndWrap: (_t: unknown, vars: Record<string, string>) => ({ subject: "s", htmlContent: `${vars.evidenceItems}|${vars.evidenceLink}`, textContent: "t" }),
  brandingFrom: () => undefined,
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
