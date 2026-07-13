/**
 * MCP bulk-tool parity fixes (July 13, 2026):
 *
 *  - M9: `create_speakers_bulk` used to drop role/country/city/state/zip/
 *    photo/additionalEmail/tags/registrationType and skipped the contact-store
 *    sync entirely — bulk-imported faculty got blank badge countries, "—"
 *    professions on their companion registrations, and never reached the CRM.
 *
 *  - send_bulk_email now routes through the SHARED executeBulkEmail pipeline
 *    (branding + custom-notification template + the INVALID_FILTER guard)
 *    instead of its own inline resolution/send loop, while keeping the
 *    synchronous JSON-RPC contract ({ success, sent, failed, total, errors }).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockSyncToContact, mockExecuteBulkEmail, MockBulkEmailError } = vi.hoisted(() => {
  class MockBulkEmailError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status = 400, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    mockDb: {
      speaker: { findFirst: vi.fn(), create: vi.fn(), count: vi.fn() },
      registration: { count: vi.fn() },
      user: { findUnique: vi.fn() },
      event: { findUnique: vi.fn() },
      auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
    },
    mockSyncToContact: vi.fn().mockResolvedValue(undefined),
    mockExecuteBulkEmail: vi.fn(),
    MockBulkEmailError,
  };
});

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: mockSyncToContact }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/speaker-companion", () => ({
  ensureCompanionsForSpeakerEmails: vi.fn().mockResolvedValue({ created: 1, linked: 0, failed: 0 }),
}));
vi.mock("@/lib/abstract-reviewer-notify", () => ({ notifyReviewerAssigned: vi.fn() }));
vi.mock("@/lib/person-tag-sync", () => ({
  computeTagDelta: vi.fn(() => ({ added: [], removed: [] })),
  syncSpeakerTagsToRegistrations: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/security", () => ({ checkRateLimit: vi.fn(() => ({ allowed: true })) }));
vi.mock("@/lib/sanitize", () => ({ sanitizeHtml: (h: string) => h }));
vi.mock("@/lib/bulk-email", () => ({
  executeBulkEmail: mockExecuteBulkEmail,
  BulkEmailError: MockBulkEmailError,
}));
vi.mock("@/services/speaker-service", () => ({
  createSpeaker: vi.fn(),
  cascadeSpeakerDecline: vi.fn(),
  isSpeakerDeclineTransition: vi.fn(() => false),
}));
vi.mock("@/lib/speaker-agreement", () => ({
  SPEAKER_AGREEMENT_TEMPLATE_MAX_SIZE: 2 * 1024 * 1024,
  SpeakerAgreementTemplateError: class extends Error {},
  saveSpeakerAgreementTemplate: vi.fn(),
}));
vi.mock("@/lib/registration-serial", () => ({ getNextSerialId: vi.fn(async () => 7) }));
const sendConfirmSpy = vi.hoisted(() => vi.fn());
vi.mock("@/services/registration-service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/registration-service")>();
  return { ...real, sendRegistrationConfirmationEmail: sendConfirmSpy };
});

import { SPEAKER_EXECUTORS } from "@/lib/agent/tools/speakers";
import { COMMUNICATION_EXECUTORS } from "@/lib/agent/tools/communications";

const ctx = { eventId: "ev1", organizationId: "org1", userId: "u1", counters: { creates: 0, emailsSent: 0 } } as never;

describe("create_speakers_bulk — M9 field + contact-sync parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.speaker.findFirst.mockResolvedValue(null); // no duplicate
    mockDb.speaker.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      id: "spk1",
      email: args.data.email,
      firstName: args.data.firstName,
      lastName: args.data.lastName,
      title: args.data.title ?? null,
      role: args.data.role ?? null,
      organization: args.data.organization ?? null,
      jobTitle: args.data.jobTitle ?? null,
      phone: args.data.phone ?? null,
      photo: args.data.photo ?? null,
      city: args.data.city ?? null,
      country: args.data.country ?? null,
      bio: args.data.bio ?? null,
      specialty: args.data.specialty ?? null,
      registrationType: args.data.registrationType ?? null,
    }));
  });

  it("persists the previously-dropped fields (role/country/city/state/zip/photo/additionalEmail/tags/registrationType)", async () => {
    const res = (await SPEAKER_EXECUTORS.create_speakers_bulk(
      {
        speakers: [
          {
            email: "doc@x.com", firstName: "A", lastName: "B",
            role: "PHYSICIAN", country: "UAE", city: "Dubai", state: "DXB",
            zipCode: "0000", photo: "/uploads/photos/a.jpg",
            additionalEmail: "CC@X.com", tags: ["committee"],
            registrationType: "Physician",
          },
        ],
      },
      ctx,
    )) as { createdCount: number };
    expect(res.createdCount).toBe(1);
    const data = mockDb.speaker.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      role: "PHYSICIAN",
      country: "UAE",
      city: "Dubai",
      state: "DXB",
      zipCode: "0000",
      photo: "/uploads/photos/a.jpg",
      additionalEmail: "cc@x.com", // lowercased
      registrationType: "Physician",
    });
    expect(data.tags).toEqual(["Committee"]); // normalizeTag Title-Case
  });

  it("syncs every created row to the org contact store (was skipped entirely)", async () => {
    await SPEAKER_EXECUTORS.create_speakers_bulk(
      { speakers: [{ email: "doc@x.com", firstName: "A", lastName: "B", role: "PHYSICIAN", country: "UAE" }] },
      ctx,
    );
    expect(mockSyncToContact).toHaveBeenCalledTimes(1);
    expect(mockSyncToContact).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org1", email: "doc@x.com", role: "PHYSICIAN", country: "UAE" }),
    );
  });

  it("rejects an invalid role per-row without killing the batch", async () => {
    const res = (await SPEAKER_EXECUTORS.create_speakers_bulk(
      {
        speakers: [
          { email: "bad@x.com", firstName: "A", lastName: "B", role: "WIZARD" },
          { email: "ok@x.com", firstName: "C", lastName: "D" },
        ],
      },
      ctx,
    )) as { createdCount: number; errors: Array<{ code: string }> };
    expect(res.createdCount).toBe(1);
    expect(res.errors[0]).toMatchObject({ code: "INVALID_ROLE" });
  });
});

describe("send_bulk_email — routed through executeBulkEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.registration.count.mockResolvedValue(3);
    mockDb.speaker.count.mockResolvedValue(3);
    mockDb.user.findUnique.mockResolvedValue({ firstName: "Org", lastName: "Anizer", email: "o@x.com", emailSignature: "<p>sig</p>" });
    mockDb.event.findUnique.mockResolvedValue({ name: "Ev", emailFromAddress: "from@x.com", emailFromName: "Ev Team" });
    mockExecuteBulkEmail.mockResolvedValue({ total: 3, successCount: 3, failureCount: 0, errors: [] });
  });

  it("delegates with emailType custom + the two filters, and maps the result to the JSON-RPC shape", async () => {
    const res = await COMMUNICATION_EXECUTORS.send_bulk_email(
      {
        recipientType: "registrations",
        subject: "Hi",
        htmlMessage: "<p>Body</p>",
        statusFilter: "CONFIRMED",
        paymentStatusFilter: "UNPAID",
      },
      ctx,
    );
    expect(mockExecuteBulkEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "ev1",
        recipientType: "registrations",
        emailType: "custom",
        customSubject: "Hi",
        customMessage: "<p>Body</p>",
        filters: { status: "CONFIRMED", paymentStatus: "UNPAID" },
        organizerName: "Org Anizer",
        organizerSignature: "<p>sig</p>",
        organizationId: "org1",
        triggeredByUserId: "u1",
      }),
    );
    expect(res).toEqual({ success: true, sent: 3, failed: 0, total: 3, errors: [] });
  });

  it("surfaces a BulkEmailError (e.g. INVALID_FILTER / NO_RECIPIENTS) as a coded error", async () => {
    mockExecuteBulkEmail.mockRejectedValue(new MockBulkEmailError("Invalid status filter", 400, "INVALID_FILTER"));
    const res = await COMMUNICATION_EXECUTORS.send_bulk_email(
      { recipientType: "registrations", subject: "Hi", htmlMessage: "<p>x</p>" },
      ctx,
    );
    expect(res).toMatchObject({ error: "Invalid status filter", code: "INVALID_FILTER" });
  });

  it("keeps the inline-send recipient cap", async () => {
    mockDb.registration.count.mockResolvedValue(501);
    const res = (await COMMUNICATION_EXECUTORS.send_bulk_email(
      { recipientType: "registrations", subject: "Hi", htmlMessage: "<p>x</p>" },
      ctx,
    )) as { error?: string };
    expect(res.error).toContain("Too many recipients");
    expect(mockExecuteBulkEmail).not.toHaveBeenCalled();
  });

  it("rejects paymentStatusFilter on the speakers branch (unchanged contract)", async () => {
    const res = (await COMMUNICATION_EXECUTORS.send_bulk_email(
      { recipientType: "speakers", subject: "Hi", htmlMessage: "<p>x</p>", paymentStatusFilter: "UNPAID" },
      ctx,
    )) as { error?: string };
    expect(res.error).toContain("only valid when recipientType is 'registrations'");
  });
});

// ── M8: create_registrations_bulk — 4 drifts vs the single-create service ────

import { REGISTRATION_EXECUTORS } from "@/lib/agent/tools/registrations";

// Loosely-typed view of the Prisma mock so this block can attach models
// (ticketType, $transaction, _regTx) and reach `.mock.calls[…].data` on
// dynamically-added mocks. Test-only plumbing — a single justified escape
// hatch instead of ten inline `any` casts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockDb = Record<string, any>;

describe("create_registrations_bulk — M8 parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (mockDb as MockDb).ticketType = {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "tt-paid", name: "Physician", quantity: 100, price: 250, currency: "USD",
          requiresApproval: false, salesStart: null, salesEnd: null,
        },
        {
          id: "tt-free", name: "Observer", quantity: 100, price: 0, currency: "USD",
          requiresApproval: false, salesStart: null, salesEnd: null,
        },
        {
          id: "tt-approval", name: "VIP", quantity: 100, price: 100, currency: "USD",
          requiresApproval: true, salesStart: null, salesEnd: null,
        },
        {
          id: "tt-closed", name: "Early Bird", quantity: 100, price: 100, currency: "USD",
          requiresApproval: false, salesStart: null, salesEnd: new Date("2020-01-01"),
        },
      ]),
    };
    (mockDb as MockDb).event.findFirst = vi.fn().mockResolvedValue({ id: "ev1", slug: "ev", name: "Ev", organization: {} });
    (mockDb as MockDb).registration.findFirst = vi.fn().mockResolvedValue(null);
    const tx = {
      attendee: { create: vi.fn().mockResolvedValue({ id: "att1", email: "a@b.com" }) },
      ticketType: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      registration: {
        create: vi.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => ({
          id: "reg1", serialId: 7, qrCode: args.data.qrCode,
        })),
      },
    };
    (mockDb as MockDb).$transaction = vi.fn(async (cb: (t: unknown) => unknown) => cb(tx));
    (mockDb as MockDb)._regTx = tx;
  });

  const row = (over: Record<string, unknown> = {}) => ({
    email: "a@b.com", firstName: "A", lastName: "B", ticketTypeId: "tt-paid", ...over,
  });

  it("paid tickets start UNASSIGNED + email the quote; free start COMPLIMENTARY with no email (drift #1 + #4)", async () => {
    await REGISTRATION_EXECUTORS.create_registrations_bulk({ registrations: [row()] }, ctx);
    let data = (mockDb as MockDb)._regTx.registration.create.mock.calls[0][0].data;
    expect(data.paymentStatus).toBe("UNASSIGNED");
    expect(sendConfirmSpy).toHaveBeenCalledTimes(1);
    expect(sendConfirmSpy.mock.calls[0][0]).toMatchObject({ price: 250, ticketTypeName: "Physician" });

    sendConfirmSpy.mockClear();
    (mockDb as MockDb)._regTx.registration.create.mockClear();
    await REGISTRATION_EXECUTORS.create_registrations_bulk(
      { registrations: [row({ email: "free@b.com", ticketTypeId: "tt-free" })] },
      ctx,
    );
    data = (mockDb as MockDb)._regTx.registration.create.mock.calls[0][0].data;
    expect(data.paymentStatus).toBe("COMPLIMENTARY");
    expect(sendConfirmSpy).not.toHaveBeenCalled();
  });

  it("the duplicate check excludes CANCELLED rows (drift #2)", async () => {
    await REGISTRATION_EXECUTORS.create_registrations_bulk({ registrations: [row()] }, ctx);
    expect((mockDb as MockDb).registration.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { not: "CANCELLED" } }),
      }),
    );
  });

  it("an approval-gated ticket type forces PENDING (drift #3)", async () => {
    await REGISTRATION_EXECUTORS.create_registrations_bulk(
      { registrations: [row({ ticketTypeId: "tt-approval", status: "CONFIRMED" })] },
      ctx,
    );
    const data = (mockDb as MockDb)._regTx.registration.create.mock.calls[0][0].data;
    expect(data.status).toBe("PENDING");
  });

  it("a closed sales window rejects the row with SALES_ENDED (drift #4)", async () => {
    const res = (await REGISTRATION_EXECUTORS.create_registrations_bulk(
      { registrations: [row({ ticketTypeId: "tt-closed" })] },
      ctx,
    )) as { createdCount: number; errors: Array<{ code: string }> };
    expect(res.createdCount).toBe(0);
    expect(res.errors[0]).toMatchObject({ code: "SALES_ENDED" });
  });
});
