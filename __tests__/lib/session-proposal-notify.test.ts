/**
 * Session-proposal confirmation email — link + vars pins (Aug 6, 2026).
 *
 * The organizer-reported bug: "View Your Proposal" pointed at the INTERNAL
 * /login (dashboard) instead of the branded event login, so submitters landed
 * on a staff sign-in page. The link must be the event-scoped login with the
 * session-proposals redirect.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, sendEmailSpy } = vi.hoisted(() => ({
  mockDb: {
    event: { findUnique: vi.fn() },
    notification: { create: vi.fn() },
    user: { findMany: vi.fn() },
  },
  sendEmailSpy: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/email", () => ({
  sendEmail: sendEmailSpy,
  getEventTemplate: vi.fn().mockResolvedValue(null),
  getDefaultTemplate: vi.fn().mockReturnValue({
    subject: "Session Proposal Received - {{eventName}}",
    htmlContent: '<a href="{{managementLink}}">View Your Proposal</a>',
    textContent: "View: {{managementLink}}",
  }),
  renderAndWrap: (tpl: { subject: string; htmlContent: string; textContent: string }, vars: Record<string, string>) => {
    const sub = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
    return { subject: sub(tpl.subject), htmlContent: sub(tpl.htmlContent), textContent: sub(tpl.textContent) };
  },
  brandingCc: () => undefined,
  brandingFrom: () => undefined,
}));

import { notifySessionProposalSubmitted } from "@/lib/session-proposal-notify";

const PROPOSAL = {
  id: "sp1",
  title: "TAVR Workshop",
  serialId: 3,
  proposedFormat: null,
  theme: null,
  speaker: {
    id: "spk1", title: "DR", firstName: "Aisha", lastName: "Khan",
    email: "aisha@x.com", additionalEmail: null,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = "https://events.example.com";
});

describe("notifySessionProposalSubmitted — View Your Proposal link", () => {
  it("points at the BRANDED event login with the session-proposals redirect (never /login)", async () => {
    mockDb.event.findUnique.mockResolvedValue({ name: "Ev", slug: "BIGSKY2027" });
    notifySessionProposalSubmitted({
      eventId: "ev1", organizationId: "org1", triggeredByUserId: "u1", isResubmission: false,
      proposal: PROPOSAL as never,
    });
    await vi.waitFor(() => expect(sendEmailSpy).toHaveBeenCalled());
    const { htmlContent } = sendEmailSpy.mock.calls[0][0];
    expect(htmlContent).toContain(
      "https://events.example.com/e/BIGSKY2027/login?redirect=session-proposals",
    );
    expect(htmlContent).not.toContain("callbackUrl");
  });

  it("falls back to the app login when the event has no slug (never a broken /e//… URL)", async () => {
    mockDb.event.findUnique.mockResolvedValue({ name: "Ev", slug: null });
    notifySessionProposalSubmitted({
      eventId: "ev1", organizationId: "org1", triggeredByUserId: "u1", isResubmission: false,
      proposal: PROPOSAL as never,
    });
    await vi.waitFor(() => expect(sendEmailSpy).toHaveBeenCalled());
    const { htmlContent } = sendEmailSpy.mock.calls[0][0];
    expect(htmlContent).toContain("https://events.example.com/login");
    expect(htmlContent).not.toContain("/e//");
  });
});
