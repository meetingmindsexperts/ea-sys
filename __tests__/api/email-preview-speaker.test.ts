/**
 * Email preview — target-speaker overrides (July 29, 2026, organizer-reported).
 *
 * Previewing from a SPECIFIC speaker's email dialog used to greet the
 * signed-in operator (buildEventPreviewVariables' user greeting) and show a
 * representative speaker's presentation blocks — so previewing Speaker A's
 * invitation could render Speaker B's name. With `speakerId` in the request,
 * the preview must render THAT speaker's identity + context ON TOP of the
 * sample vars, and must 404 a speaker from another event.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockCtx, mockRender } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
    speaker: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn() },
  },
  mockAuth: vi.fn(),
  mockCtx: vi.fn(),
  mockRender: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/auth-guards", () => ({ denyReviewer: () => null }));
vi.mock("@/lib/email-preview-data", () => ({
  // The representative-speaker layer — deliberately returns ANOTHER speaker's
  // blocks so the test proves the target speaker wins.
  buildRealPreviewOverrides: vi.fn(async () => ({ presentationDetails: "<p>REPRESENTATIVE</p>" })),
}));
vi.mock("@/lib/certificates/bundle", () => ({ buildCertCoverEmailPreview: vi.fn() }));
vi.mock("@/lib/speaker-agreement", () => ({ buildSpeakerEmailContext: (...a: unknown[]) => mockCtx(...a) }));
vi.mock("@/lib/email", () => ({
  getEventTemplate: vi.fn(async () => ({
    subject: "Invitation — {{eventName}}",
    htmlContent: "<p>Dear {{speakerName}},</p>{{presentationDetails}}",
    textContent: "",
    branding: { eventName: "Ev" },
  })),
  // Signed-in-operator greeting the target speaker must BEAT.
  buildEventPreviewVariables: vi.fn(() => ({
    speakerName: "Ops Casison",
    firstName: "Ops",
    lastName: "Casison",
    presentationDetails: "<p>REPRESENTATIVE</p>",
    eventName: "Ev",
  })),
  renderTemplate: (html: string, vars: Record<string, string>) => {
    mockRender(html, vars);
    return html.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
  },
  // Faithful-enough fake: substitutes tokens from vars (escaping fidelity is
  // pinned by the real helper's own unit suite).
  renderMessageValue: (m: string, vars: Record<string, string>) =>
    m.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? "")),
  renderTemplatePlain: (s: string, vars: Record<string, string>) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? ""),
  wrapWithBranding: (html: string) => html,
  inlineCss: (html: string) => html,
}));

import { POST } from "@/app/api/events/[eventId]/email-preview/route";

const params = { params: Promise.resolve({ eventId: "ev1" }) };
const req = (body: unknown) =>
  new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ORGANIZER", organizationId: "org1", firstName: "Ops", lastName: "Casison" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", name: "Ev", ticketTypes: [], registrations: [] });
  mockDb.user.findUnique.mockResolvedValue({ emailSignature: null });
});

describe("email-preview with speakerId", () => {
  it("greets the TARGET speaker with THEIR presentation context (beats operator + representative)", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "sp1", title: "DR", firstName: "Ahmed", lastName: "Osman", email: "osman@x.com" });
    mockCtx.mockResolvedValue({
      title: "Dr.",
      speakerName: "Dr. Ahmed Osman",
      jobTitle: "Consultant", speakerOrganization: "Org", speakerCountry: "AE",
      sessionTitles: "S1", topicTitles: "T1", sessionDateTime: "dt", trackNames: "", role: "Speaker",
      presentationDetails: "<p>OSMAN-SESSIONS</p>", presentationDetailsText: "OSMAN-SESSIONS",
      moderatorDetails: "", moderatorDetailsText: "",
    });

    const res = await POST(req({ slug: "speaker-invitation", speakerId: "sp1" }), params);
    expect(res.status).toBe(200);
    const body = await res.json() as { htmlContent: string };
    expect(body.htmlContent).toContain("Dear Dr. Ahmed Osman");
    expect(body.htmlContent).toContain("OSMAN-SESSIONS");
    expect(body.htmlContent).not.toContain("Casison");
    expect(body.htmlContent).not.toContain("REPRESENTATIVE");
    // Speaker resolved event-bound (no cross-event preview).
    expect(mockDb.speaker.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "sp1", eventId: "ev1" } }),
    );
  });

  it("falls back to the speaker ROW when the context returns null (session-less speaker)", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "sp1", title: "DR", firstName: "Ahmed", lastName: "Osman", email: "osman@x.com" });
    mockCtx.mockResolvedValue(null);
    const res = await POST(req({ slug: "speaker-invitation", speakerId: "sp1" }), params);
    expect(res.status).toBe(200);
    const body = await res.json() as { htmlContent: string };
    expect(body.htmlContent).toContain("Dear Ahmed Osman");
    expect(body.htmlContent).not.toContain("Casison");
  });

  it("404s a speakerId from another event", async () => {
    mockDb.speaker.findFirst.mockResolvedValue(null);
    const res = await POST(req({ slug: "speaker-invitation", speakerId: "foreign" }), params);
    expect(res.status).toBe(404);
  });

  it("a token TYPED INTO THE COMPOSE BOX resolves in preview like the send — the 'moderator block not rendering in preview' fix (July 30)", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "sp1", title: "DR", firstName: "Ahmed", lastName: "Osman", email: "osman@x.com" });
    mockCtx.mockResolvedValue({
      title: "Dr.", speakerName: "Dr. Ahmed Osman",
      jobTitle: "", speakerOrganization: "", speakerCountry: "",
      sessionTitles: "", topicTitles: "", sessionDateTime: "", trackNames: "", role: "Moderator",
      presentationDetails: "", presentationDetailsText: "",
      moderatorDetails: "<table>MOD-RUNSHEET</table>", moderatorDetailsText: "MOD-RUNSHEET",
    });
    // Template renders the typed message via {{personalMessage}} — the shape
    // where the bug bit: the token inside the message stayed literal.
    const { getEventTemplate } = await import("@/lib/email");
    (getEventTemplate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      subject: "Invitation",
      htmlContent: "<p>{{personalMessage}}</p>",
      textContent: "",
      branding: { eventName: "Ev" },
    });

    const res = await POST(
      req({ slug: "speaker-invitation", speakerId: "sp1", customMessage: "Your run-sheet: {{moderatorDetails}}" }),
      params,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { htmlContent: string };
    expect(body.htmlContent).toContain("MOD-RUNSHEET");
    expect(body.htmlContent).not.toContain("{{moderatorDetails}}");
  });

  it("{{moderatorDetails}} IN THE TEMPLATE renders the target moderator's run-sheet", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "sp1", title: "DR", firstName: "Ahmed", lastName: "Osman", email: "osman@x.com" });
    mockCtx.mockResolvedValue({
      title: "Dr.", speakerName: "Dr. Ahmed Osman",
      jobTitle: "", speakerOrganization: "", speakerCountry: "",
      sessionTitles: "", topicTitles: "", sessionDateTime: "", trackNames: "", role: "Moderator",
      presentationDetails: "", presentationDetailsText: "",
      moderatorDetails: "<table>MOD-RUNSHEET</table>", moderatorDetailsText: "MOD-RUNSHEET",
    });
    const { getEventTemplate } = await import("@/lib/email");
    (getEventTemplate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      subject: "Invitation",
      htmlContent: "<p>Dear {{speakerName}}</p>{{moderatorDetails}}",
      textContent: "",
      branding: { eventName: "Ev" },
    });
    const res = await POST(req({ slug: "speaker-invitation", speakerId: "sp1" }), params);
    expect(res.status).toBe(200);
    const body = await res.json() as { htmlContent: string };
    expect(body.htmlContent).toContain("MOD-RUNSHEET");
  });

  it("registrationId greets the registrant title-prefixed with their real Registration #", async () => {
    mockDb.registration.findFirst.mockResolvedValue({
      serialId: 7,
      attendee: { title: "DR", firstName: "Ahmed", lastName: "Osman", email: "osman@x.com" },
      ticketType: { name: "Physician" },
    });
    const res = await POST(req({ slug: "registration-confirmation", registrationId: "reg1" }), params);
    expect(res.status).toBe(200);
    // recipientName is title-prefixed via formatPersonName; registrationId is
    // the padded serial. The template mock only renders {{speakerName}}, so
    // assert via the vars handed to renderTemplate.
    const vars = mockRender.mock.calls[0][1] as Record<string, string>;
    expect(vars.recipientName).toBe("Dr. Ahmed Osman");
    expect(vars.title).toBe("Dr.");
    expect(vars.firstName).toBe("Ahmed");
    expect(vars.registrationId).toBe("007");
    expect(vars.ticketType).toBe("Physician");
    // Event-bound lookup — no cross-event preview.
    expect(mockDb.registration.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "reg1", eventId: "ev1" } }),
    );
  });

  it("404s a registrationId from another event", async () => {
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await POST(req({ slug: "registration-confirmation", registrationId: "foreign" }), params);
    expect(res.status).toBe(404);
  });

  it("without speakerId the existing behavior is unchanged (operator greeting)", async () => {
    const res = await POST(req({ slug: "speaker-invitation" }), params);
    expect(res.status).toBe(200);
    const body = await res.json() as { htmlContent: string };
    expect(body.htmlContent).toContain("Dear Ops Casison");
    expect(mockDb.speaker.findFirst).not.toHaveBeenCalled();
  });
});
