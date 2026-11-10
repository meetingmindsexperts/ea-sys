/**
 * Adding a reviewer sends no email (owner, Nov 10, 2026: "disable auto email
 * trigger on reviewer addition, send email manually"). The Reviewers page's
 * Send button (resend-invitation route) is the only way a reviewer hears.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, sendEmailSpy, notifyPoolSpy, findUserByEmail } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    speaker: { findFirst: vi.fn(), update: vi.fn() },
    user: { create: vi.fn(), findUnique: vi.fn() },
    verificationToken: { create: vi.fn() },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
    $transaction: vi.fn(),
  },
  sendEmailSpy: vi.fn(),
  notifyPoolSpy: vi.fn(),
  findUserByEmail: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({
  auth: () => Promise.resolve({ user: { id: "admin1", role: "ORGANIZER", organizationId: "org1" } }),
}));
vi.mock("@/lib/require-org", () => ({ requireOrgId: () => ({ orgId: "org1" }) }));
vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: () => ({ ok: true, eventWhere: { id: "ev1" } }),
  isLinkedRole: (role: string) => ["REVIEWER", "SUBMITTER", "REGISTRANT"].includes(role),
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/tenant/user-lookup", () => ({ findUserByEmail, userEmailScope: () => ({}), isUniqueViolation: () => false }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/event-settings", () => ({ updateEventSettings: vi.fn() }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn() }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/email", () => ({ sendEmail: sendEmailSpy }));
vi.mock("@/lib/abstract-reviewer-notify", () => ({ notifyReviewerPoolAdded: notifyPoolSpy }));

import { POST } from "@/app/api/events/[eventId]/reviewers/route";

const params = { params: Promise.resolve({ eventId: "ev1" }) };
const add = (body: unknown) => POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), params);
const byEmail = { type: "direct", email: "New.Reviewer@example.com", firstName: "New", lastName: "Reviewer" };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", name: "MedCon", settings: { reviewerUserIds: [] } });
  mockDb.user.create.mockResolvedValue({ id: "new1" });
});

describe("adding a reviewer", () => {
  it("creates a new account with no setup link and sends nothing", async () => {
    findUserByEmail.mockResolvedValue(null);
    const res = await add(byEmail);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ userId: "new1", invitationSent: false });
    expect(mockDb.user.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ email: "new.reviewer@example.com", role: "REVIEWER" }) }));
    expect(mockDb.verificationToken.create).not.toHaveBeenCalled();
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });

  it("does not send the 'added as a reviewer' email to an existing account either", async () => {
    findUserByEmail.mockResolvedValue({ id: "old1", role: "SUBMITTER", emailConfirmedAt: new Date() });
    const res = await add(byEmail);
    expect(res.status).toBe(201);
    expect(notifyPoolSpy).not.toHaveBeenCalled();
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });

  it("nor when added from a speaker already linked to an account", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "sp1", email: "s@example.com", firstName: "S", lastName: "P", userId: "linked1" });
    const res = await add({ type: "speaker", speakerId: "sp1" });
    expect(res.status).toBe(201);
    expect(notifyPoolSpy).not.toHaveBeenCalled();
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });
});
