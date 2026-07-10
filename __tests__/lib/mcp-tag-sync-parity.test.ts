/**
 * MCP tag-write parity with REST (review H5) — the `update_speaker` and
 * `update_registration` executors must mirror tag deltas onto the person's
 * other facet via person-tag-sync, exactly like the REST PUT routes do.
 * Before this fix the MCP path wrote tags raw, so agent-tagged committee
 * speakers never reached attendee.tags (breaking ATTENDANCE cert auto-issue,
 * tagsInclude bulk-email filters, and ?tags= queries) and vice versa.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockSyncSpkToReg, mockSyncRegToSpk } = vi.hoisted(() => {
  const tx = {
    ticketType: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn() },
    pricingTier: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn() },
    registration: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn(),
    },
    attendee: { update: vi.fn().mockResolvedValue({}) },
    promoCode: { update: vi.fn().mockResolvedValue({}) },
  };
  return {
    mockDb: {
      speaker: {
        findFirst: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn(),
      },
      registration: { findFirst: vi.fn() },
      ticketType: { findFirst: vi.fn() },
      pricingTier: { findFirst: vi.fn() },
      auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
      $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
      _tx: tx,
    },
    mockSyncSpkToReg: vi.fn().mockResolvedValue(undefined),
    mockSyncRegToSpk: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn() }));
vi.mock("@/lib/speaker-companion", () => ({
  ensureCompanionsForSpeakerEmails: vi.fn().mockResolvedValue({ created: 0, linked: 0, failed: 0 }),
}));
vi.mock("@/lib/person-tag-sync", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/person-tag-sync")>();
  return {
    ...real, // keep the REAL computeTagDelta — the delta shape is part of the contract
    syncSpeakerTagsToRegistrations: mockSyncSpkToReg,
    syncRegistrationTagsToSpeakers: mockSyncRegToSpk,
  };
});

import { SPEAKER_EXECUTORS } from "@/lib/agent/tools/speakers";
import { REGISTRATION_EXECUTORS } from "@/lib/agent/tools/registrations";

const updateSpeaker = SPEAKER_EXECUTORS.update_speaker;
const updateRegistration = REGISTRATION_EXECUTORS.update_registration;
const ctx = { eventId: "ev1", organizationId: "org1", userId: "u1", counters: { creates: 0, emailsSent: 0 } };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.speaker.updateMany.mockResolvedValue({ count: 1 });
  mockDb._tx.registration.updateMany.mockResolvedValue({ count: 1 });
  // Stored tags are Title-Cased by normalizeTag at write time.
  mockDb.speaker.findFirst.mockResolvedValue({
    id: "spk1", eventId: "ev1", email: "doc@x.com", firstName: "A", lastName: "B",
    status: "CONFIRMED", tags: ["Committee"], sourceRegistrationId: "reg9",
  });
  mockDb.speaker.findUniqueOrThrow.mockResolvedValue({
    id: "spk1", title: null, firstName: "A", lastName: "B", email: "doc@x.com",
    status: "CONFIRMED", organization: null, jobTitle: null,
  });
  mockDb.registration.findFirst.mockResolvedValue({
    id: "reg1", eventId: "ev1", status: "CONFIRMED", paymentStatus: "UNPAID",
    sponsorId: null, ticketTypeId: "tt1", attendeeId: "att1", promoCodeId: null,
    discountAmount: null, attendanceMode: "IN_PERSON", qrCode: "QR",
    pricingTierId: null, createdSource: null,
    attendee: { id: "att1", firstName: "A", lastName: "B", email: "doc@x.com", tags: ["Vip"] },
    event: { settings: {} },
  });
  mockDb._tx.registration.findUniqueOrThrow.mockResolvedValue({
    id: "reg1", status: "CONFIRMED", paymentStatus: "UNPAID", ticketTypeId: "tt1",
    notes: null, attendee: { id: "att1", firstName: "A", lastName: "B", email: "doc@x.com" },
  });
});

describe("update_speaker → syncSpeakerTagsToRegistrations", () => {
  it("mirrors the tag delta onto the registration facet", async () => {
    const res = await updateSpeaker(
      { speakerId: "spk1", tags: ["committee", "committee-organizing"] },
      ctx,
    );
    expect(res).toMatchObject({ success: true });
    expect(mockSyncSpkToReg).toHaveBeenCalledTimes(1);
    // Input tags run through normalizeTag (Title-Case) before the delta.
    expect(mockSyncSpkToReg).toHaveBeenCalledWith("ev1", [
      {
        speakerId: "spk1",
        email: "doc@x.com",
        sourceRegistrationId: "reg9",
        delta: { added: ["Committee-organizing"], removed: [] },
      },
    ]);
  });

  it("does NOT sync when tags weren't part of the update", async () => {
    const res = await updateSpeaker({ speakerId: "spk1", status: "DECLINED" }, ctx);
    expect(res).toMatchObject({ success: true });
    expect(mockSyncSpkToReg).not.toHaveBeenCalled();
  });
});

describe("update_registration → syncRegistrationTagsToSpeakers", () => {
  it("mirrors the attendee tag delta onto the speaker facet", async () => {
    const res = await updateRegistration(
      { registrationId: "reg1", attendee: { tags: ["vip", "committee"] } },
      ctx,
    );
    expect(res).toMatchObject({ success: true });
    expect(mockSyncRegToSpk).toHaveBeenCalledTimes(1);
    expect(mockSyncRegToSpk).toHaveBeenCalledWith("ev1", [
      {
        registrationId: "reg1",
        email: "doc@x.com",
        delta: { added: ["Committee"], removed: [] },
      },
    ]);
  });

  it("does NOT sync when the update carried no tags", async () => {
    const res = await updateRegistration(
      { registrationId: "reg1", attendee: { firstName: "New" } },
      ctx,
    );
    expect(res).toMatchObject({ success: true });
    expect(mockSyncRegToSpk).not.toHaveBeenCalled();
  });
});
