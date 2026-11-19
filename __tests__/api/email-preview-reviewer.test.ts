/**
 * Email preview: one reviewer's invitation (Nov 19, 2026).
 *
 * Every reviewer email now opens in the email dialog, whose Preview button
 * must show the invitation as THAT reviewer gets it: rendered by the sender's
 * own code (previewReviewerInvitation), and only for someone on the event's
 * reviewer list, the people the send can reach.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, previewSpy, logger } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  },
  mockAuth: vi.fn(),
  previewSpy: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: () => ({ ok: true, principal: { organizationId: "org1", baseRole: "ADMIN", fromApiKey: false }, eventWhere: { id: "ev1", organizationId: "org1" } }),
}));
vi.mock("@/lib/tenant/event-tenant", () => ({ findGatedEvent: (_gate: unknown, args: unknown) => mockDb.event.findFirst(args) }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/email-preview-data", () => ({ buildRealPreviewOverrides: vi.fn(async () => ({})) }));
vi.mock("@/lib/certificates/bundle", () => ({ buildCertCoverEmailPreview: vi.fn() }));
vi.mock("@/lib/speaker-agreement", () => ({ buildSpeakerEmailContext: vi.fn() }));
vi.mock("@/lib/public-brand-server", () => ({ loadPublicBrandForOrg: async () => ({ name: "Meeting Minds Experts" }) }));
vi.mock("@/lib/abstract-reviewer-notify", async () => {
  const actual = await vi.importActual<typeof import("@/lib/abstract-reviewer-notify")>("@/lib/abstract-reviewer-notify");
  return { previewReviewerInvitation: previewSpy, inviterNameOf: actual.inviterNameOf };
});
vi.mock("@/lib/email", () => ({
  getEventTemplate: vi.fn(async () => ({ subject: "Generic", htmlContent: "<p>GENERIC SAMPLE</p>", textContent: "", branding: { eventName: "MedCon" } })),
  buildEventPreviewVariables: vi.fn(() => ({})),
  renderTemplate: (html: string) => html,
  renderMessageValue: (m: string) => m,
  renderTemplatePlain: (s: string) => s,
  wrapWithBranding: (html: string) => html,
  inlineCss: (html: string) => html,
}));

import { POST } from "@/app/api/events/[eventId]/email-preview/route";

const REVIEWER = { id: "r1", email: "dina@x.com", firstName: "Dina", lastName: "Ortiz", emailVerified: null, role: "REVIEWER" };
const post = (body: unknown) =>
  POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ eventId: "ev1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ORGANIZER", organizationId: "org1", firstName: "Sarah", lastName: "Ahmed" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1", name: "MedCon", slug: "medcon", settings: { reviewerUserIds: ["r1", "r2"] } });
  // r1 has an account, r2 is on the pool with none, admin1 is whoever is looking.
  const accounts: Record<string, unknown> = { r1: REVIEWER, admin1: { emailSignature: null } };
  mockDb.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => accounts[where.id] ?? null);
  previewSpy.mockResolvedValue({ subject: "Invitation to review, MedCon", htmlContent: "<p>Dear Dr. Ortiz</p>", kind: "setup" });
});

describe("email-preview with reviewerId", () => {
  it("renders THAT reviewer's invitation through the sender's own code", async () => {
    const res = await post({ slug: "reviewer-invitation", reviewerId: "r1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subject: "Invitation to review, MedCon", htmlContent: "<p>Dear Dr. Ortiz</p>" });
    expect(previewSpy).toHaveBeenCalledWith({
      eventId: "ev1",
      organizationId: "org1",
      eventName: "MedCon",
      eventSlug: "medcon",
      reviewer: REVIEWER,
      // What the send passes: the attendee-facing brand and whoever is looking.
      organizationName: "Meeting Minds Experts",
      inviterName: "Sarah Ahmed",
      triggeredByUserId: "admin1",
    });
  });

  it("404s someone who is not on this event's reviewer list, without reading their account", async () => {
    const res = await post({ slug: "reviewer-invitation", reviewerId: "stranger" });
    expect(res.status).toBe(404);
    expect(previewSpy).not.toHaveBeenCalled();
    expect(mockDb.user.findUnique).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: "stranger" } }));
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "email-preview:reviewer-not-on-pool" }));
  });

  it("404s a pool id whose account is gone, and 500s a render that failed: each logged", async () => {
    expect((await post({ slug: "reviewer-invitation", reviewerId: "r2" })).status).toBe(404);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "email-preview:reviewer-account-not-found" }));

    previewSpy.mockResolvedValueOnce(null);
    expect((await post({ slug: "reviewer-invitation", reviewerId: "r1" })).status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "email-preview:reviewer-invitation-render-failed" }));
  });

  it("without a reviewer (a send to several) it stays the generic sample preview", async () => {
    const res = await post({ slug: "reviewer-invitation" });
    expect(res.status).toBe(200);
    expect((await res.json()).htmlContent).toContain("GENERIC SAMPLE");
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it("a reviewerId on any other email is ignored: it never swaps in the invitation", async () => {
    const res = await post({ slug: "custom-notification", reviewerId: "r1" });
    expect(res.status).toBe(200);
    expect(previewSpy).not.toHaveBeenCalled();
  });
});
