/**
 * "Send test email" files under the staff member who sent it.
 *
 * The test send goes to the CLICKER's own inbox (the user row is looked up by
 * `session.user.id`), so it has a real entity. It previously passed no
 * logContext at all, which meant two things: the EmailLog row orphaned as
 * entityType OTHER with no id, and `sendEmail` logged
 * "sendEmail called without logContext" on every click — a warning whose whole
 * job is to mean "a developer FORGOT", firing on a caller that hadn't.
 *
 * `noEntityContext: true` would also have silenced the warning, and is the
 * wrong tool here: it asserts the mail belongs to nobody, which is untrue of a
 * self-directed send, and it would drop the record that answers "did I
 * actually send myself that test, and when?". USER + the sender's id is the
 * shape eight existing self-directed senders already use (password reset, org
 * invite, reviewer invite, email verification, CRM reminders).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockApiLogger, mockSendEmail } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    emailTemplate: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  mockSendEmail: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: { set: vi.fn() },
    }),
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/require-org", () => ({
  requireOrgId: (s: { user?: { organizationId?: string | null } } | null) =>
    s?.user?.organizationId
      ? { organizationId: s.user.organizationId }
      : { error: { status: 403, json: async () => ({ error: "No org" }) } },
}));
vi.mock("@/lib/event-access", () => ({
  buildEventAccessWhere: (_u: unknown, eventId: string) => ({ id: eventId, organizationId: "orgA" }),
}));
vi.mock("@/lib/auth-guards", () => ({
  WEBINAR_STAFF_ALLOW: ["WEBINARS"],
  denyReviewer: () => null,
}));
vi.mock("@/lib/email-preview-data", () => ({
  buildRealPreviewOverrides: vi.fn(async () => ({})),
}));
vi.mock("@/lib/email-template-slugs", () => ({ isCustomTemplateSlug: vi.fn(() => false) }));
vi.mock("@/lib/email", () => ({
  sendEmail: mockSendEmail,
  renderTemplate: vi.fn(() => "<p>body</p>"),
  renderTemplatePlain: vi.fn(() => "Your registration for Test Event"),
  getDefaultTemplate: vi.fn(() => ({ subject: "", htmlContent: "", textContent: "", name: "" })),
  TEMPLATE_VARIABLES: {},
  wrapWithBranding: vi.fn(() => "<html>wrapped</html>"),
  inlineCss: vi.fn((h: string) => h),
  brandingFrom: vi.fn(() => ({ email: "events@example.com", name: "Events" })),
  buildEventPreviewVariables: vi.fn(() => ({})),
}));

import { POST } from "@/app/api/events/[eventId]/email-templates/[templateId]/route";

const params = Promise.resolve({ eventId: "ev-1", templateId: "tpl-1" });
const session = { user: { id: "user-9", role: "ADMIN", organizationId: "orgA" } };

function testSendRequest() {
  return new Request("http://t", {
    method: "POST",
    body: JSON.stringify({ action: "test" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(session);
  mockDb.emailTemplate.findFirst.mockResolvedValue({
    id: "tpl-1",
    slug: "registration-confirmation",
    subject: "Your registration for {{eventName}}",
    htmlContent: "<p>hi</p>",
  });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev-1", name: "Test Event", emailCcAddresses: [] });
  // Both queries on db.user run through findUnique: the preview signature
  // lookup first, then the recipient lookup inside the test branch.
  mockDb.user.findUnique
    .mockResolvedValueOnce({ emailSignature: null })
    .mockResolvedValueOnce({ email: "staff@org.com", firstName: "Dinalyn" });
  mockSendEmail.mockResolvedValue({ success: true });
});

describe("email template test send — EmailLog attribution", () => {
  it("attributes the row to the staff member who sent it", async () => {
    const res = await POST(testSendRequest(), { params });
    expect(res.status).toBe(200);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const { logContext } = mockSendEmail.mock.calls[0][0];
    expect(logContext).toEqual({
      organizationId: "orgA",
      eventId: "ev-1",
      entityType: "USER",
      entityId: "user-9",
      templateSlug: "registration-confirmation",
      triggeredByUserId: "user-9",
    });
  });

  it("files under the SENDER, who is also the only recipient", async () => {
    // The recipient is resolved by `session.user.id`, so entityId and the
    // addressee are the same person by construction. Pinned because filing a
    // test under someone else's history would be worse than not filing it.
    await POST(testSendRequest(), { params });
    const call = mockSendEmail.mock.calls[0][0];
    expect(call.to).toEqual([{ email: "staff@org.com", name: "Dinalyn" }]);
    expect(call.logContext.entityId).toBe(session.user.id);
    expect(call.logContext.triggeredByUserId).toBe(session.user.id);
  });

  it("records WHICH template was tested, not a hardcoded slug", async () => {
    mockDb.emailTemplate.findFirst.mockResolvedValue({
      id: "tpl-2",
      slug: "speaker-invitation",
      subject: "s",
      htmlContent: "h",
    });
    await POST(testSendRequest(), { params });
    expect(mockSendEmail.mock.calls[0][0].logContext.templateSlug).toBe("speaker-invitation");
  });

  it("does NOT reach for noEntityContext", async () => {
    // The opt-out means "this mail genuinely belongs to nobody" (health
    // digest, admin alerts). Using it here would silence the warning while
    // leaving the row orphaned, which is the outcome this change exists to
    // avoid — so a future edit that swaps one for the other fails here.
    await POST(testSendRequest(), { params });
    expect(mockSendEmail.mock.calls[0][0].noEntityContext).toBeUndefined();
  });

  it("keeps the [TEST] subject prefix so a test is never mistaken for a real send", async () => {
    await POST(testSendRequest(), { params });
    expect(mockSendEmail.mock.calls[0][0].subject).toBe("[TEST] Your registration for Test Event");
  });

  it("preview mode sends nothing at all", async () => {
    const res = await POST(
      new Request("http://t", { method: "POST", body: JSON.stringify({ action: "preview" }) }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});
