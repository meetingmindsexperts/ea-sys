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
  durationMinutes: 90,
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

/**
 * Aug 10, 2026: the email reported Format, which was removed from every
 * submitter surface on Aug 4 (form, list, sheet, CSV) but left in the email, so
 * it printed a value nobody could set. Duration replaces it and Theme is gone.
 */
describe("notifySessionProposalSubmitted — proposal detail vars", () => {
  /** Render through a stub template that actually carries the tokens under test. */
  const renderWith = async (proposal: unknown, textTemplate: string) => {
    mockDb.event.findUnique.mockResolvedValue({ name: "Ev", slug: "ev-2026" });
    const { getDefaultTemplate } = await import("@/lib/email");
    vi.mocked(getDefaultTemplate).mockReturnValueOnce({
      subject: "s",
      htmlContent: `<p>${textTemplate}</p>`,
      textContent: textTemplate,
    } as never);
    notifySessionProposalSubmitted({
      eventId: "ev1", organizationId: "org1", triggeredByUserId: "u1", isResubmission: false,
      proposal: proposal as never,
    });
    await vi.waitFor(() => expect(sendEmailSpy).toHaveBeenCalled());
    return sendEmailSpy.mock.calls[0][0];
  };

  it("reports the requested duration in minutes", async () => {
    const sent = await renderWith(PROPOSAL, "Duration: {{proposalDuration}}");
    expect(sent.textContent).toBe("Duration: 90 minutes");
  });

  it("renders a blank duration, not a dash, when none was stated", async () => {
    // The dashboard table shows "—" in a cell; an email row reading
    // "Duration: —" is noise where blank reads as "not stated".
    const sent = await renderWith({ ...PROPOSAL, durationMinutes: null }, "Duration: {{proposalDuration}}");
    expect(sent.textContent).toBe("Duration: ");
  });

  it("still fills the legacy theme/format keys so a customized template can't print a raw token", async () => {
    // Migration 20260810130000 rewrites saved templates matching the seeded
    // markup but deliberately leaves a customized one alone. renderTemplate
    // prints an unknown key LITERALLY, so those keys must resolve to blank
    // rather than reach a proposer as "{{proposalTheme}}".
    mockDb.event.findUnique.mockResolvedValue({ name: "Ev", slug: "ev-2026" });
    const { getDefaultTemplate } = await import("@/lib/email");
    vi.mocked(getDefaultTemplate).mockReturnValueOnce({
      subject: "s",
      htmlContent: "<p>Theme: {{proposalTheme}} / Format: {{proposalFormat}}</p>",
      textContent: "Theme: {{proposalTheme}} / Format: {{proposalFormat}}",
    } as never);

    notifySessionProposalSubmitted({
      eventId: "ev1", organizationId: "org1", triggeredByUserId: "u1", isResubmission: false,
      proposal: PROPOSAL as never,
    });
    await vi.waitFor(() => expect(sendEmailSpy).toHaveBeenCalled());
    const { htmlContent } = sendEmailSpy.mock.calls[0][0];
    expect(htmlContent).not.toContain("{{proposalTheme}}");
    expect(htmlContent).not.toContain("{{proposalFormat}}");
  });
});
