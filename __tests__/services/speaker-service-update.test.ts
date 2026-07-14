/**
 * Unit tests for `speaker-service.updateSpeaker()` — the cross-caller #6
 * extraction (contacts review H4, July 14 2026).
 *
 * WHY THIS EXISTS: the REST speaker PUT and MCP `update_speaker` were mirrored
 * ~full implementations and had drifted — the MCP copy synced only
 * `{ email, firstName, lastName }` to the org Contact store while REST synced
 * ~13 fields. Because `syncToContact` is ENRICH-ONLY, a name+email payload
 * against an existing contact is a silent NO-OP: it succeeded, logged nothing,
 * and changed nothing, so every agent/n8n speaker edit (phone, affiliation,
 * job title…) never reached the CRM.
 *
 * The regression guard that matters most here is "the contact sync carries the
 * FULL profile" — assert the EFFECT, not that the call happened. A test that
 * only checked `syncToContact` was called would have passed against the bug.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockDb,
  mockApiLogger,
  mockSyncToContact,
  mockRefreshStats,
  mockNotifyAdmins,
  mockCancelRegistration,
  mockRunOptimisticUpdate,
  mockSyncSpeakerTags,
} = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    speaker: { findFirst: vi.fn(), create: vi.fn(), findUniqueOrThrow: vi.fn() },
    registration: { findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  mockSyncToContact: vi.fn(),
  mockRefreshStats: vi.fn(),
  mockNotifyAdmins: vi.fn(),
  mockCancelRegistration: vi.fn(),
  mockRunOptimisticUpdate: vi.fn(),
  mockSyncSpeakerTags: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: mockSyncToContact }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: mockRefreshStats }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: mockNotifyAdmins }));
vi.mock("@/lib/speaker-companion", () => ({ ensureSpeakerCompanionRegistration: vi.fn() }));
vi.mock("@/services/payment-service", () => ({ cancelRegistration: mockCancelRegistration }));
vi.mock("@/lib/optimistic-lock", () => ({
  runOptimisticUpdate: (args: unknown) => mockRunOptimisticUpdate(args),
}));
// The tag-delta computation itself is pure and tested elsewhere; here we only
// care that the speaker→registration tag mirror is INVOKED on a tag change.
vi.mock("@/lib/person-tag-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/person-tag-sync")>();
  return { ...actual, syncSpeakerTagsToRegistrations: mockSyncSpeakerTags };
});

import { updateSpeaker } from "@/services/speaker-service";

/** The row as it exists BEFORE the update. */
const EXISTING = {
  id: "spk-1",
  eventId: "evt-1",
  email: "jane@hospital.com",
  firstName: "Jane",
  lastName: "Doe",
  status: "CONFIRMED",
  tags: ["Faculty"],
  sourceRegistrationId: null as string | null,
};

/** The row as it exists AFTER the update — what the contact sync must mirror. */
const UPDATED = {
  id: "spk-1",
  eventId: "evt-1",
  email: "jane@hospital.com",
  additionalEmail: "jane.alt@hospital.com",
  firstName: "Jane",
  lastName: "Doe",
  title: "DR",
  role: "PHYSICIAN",
  organization: "Cleveland Clinic",
  jobTitle: "Head of Cardiology",
  phone: "+971500000000",
  photo: "/uploads/photos/x.jpg",
  city: "Dubai",
  country: "AE",
  bio: "Bio text",
  specialty: "Cardiology",
  registrationType: "Physician",
  status: "CONFIRMED",
  tags: ["Faculty"],
  _count: { sessions: 1, abstracts: 0 },
};

const BASE = {
  speakerId: "spk-1",
  eventId: "evt-1",
  organizationId: "org-1",
  source: "mcp" as const,
  actorUserId: "user-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.speaker.findFirst.mockResolvedValue({ ...EXISTING });
  mockDb.speaker.findUniqueOrThrow.mockResolvedValue({ ...UPDATED });
  mockDb.auditLog.create.mockReturnValue({ catch: () => {} });
  mockRunOptimisticUpdate.mockResolvedValue({ ok: true });
  mockSyncToContact.mockResolvedValue(undefined);
  mockSyncSpeakerTags.mockResolvedValue(undefined);
  mockCancelRegistration.mockResolvedValue({ ok: true });
});

describe("H4 — the contact sync carries the FULL profile (was name+email on MCP)", () => {
  it("syncs every profile field from the freshly-updated row", async () => {
    const res = await updateSpeaker({ ...BASE, fields: { phone: "+971500000000" } });

    expect(res.ok).toBe(true);
    expect(mockSyncToContact).toHaveBeenCalledTimes(1);

    // The assertion that would have FAILED against the bug: not "was it called"
    // but "did it carry the profile".
    expect(mockSyncToContact).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        eventId: "evt-1",
        email: "jane@hospital.com",
        additionalEmail: "jane.alt@hospital.com",
        firstName: "Jane",
        lastName: "Doe",
        title: "DR",
        role: "PHYSICIAN",
        organization: "Cleveland Clinic",
        jobTitle: "Head of Cardiology",
        phone: "+971500000000",
        photo: "/uploads/photos/x.jpg",
        city: "Dubai",
        country: "AE",
        bio: "Bio text",
        specialty: "Cardiology",
        registrationType: "Physician",
      }),
    );
  });

  it("reads the sync payload from the UPDATED row, not the caller's input", async () => {
    // The service must mirror what was actually persisted (incl. the
    // empty-to-null collapse), not echo the request body back at the CRM.
    mockDb.speaker.findUniqueOrThrow.mockResolvedValue({ ...UPDATED, phone: null });

    await updateSpeaker({ ...BASE, fields: { phone: "" } });

    expect(mockSyncToContact).toHaveBeenCalledWith(
      expect.objectContaining({ phone: null }),
    );
  });
});

describe("the write itself", () => {
  it("collapses an empty string to null (clear) and trims first", async () => {
    await updateSpeaker({
      ...BASE,
      fields: { additionalEmail: "   ", organization: "", jobTitle: "Prof" },
    });

    const { data } = mockRunOptimisticUpdate.mock.calls[0][0];
    expect(data.additionalEmail).toBeNull();
    expect(data.organization).toBeNull();
    expect(data.jobTitle).toBe("Prof");
  });

  it("skips undefined fields entirely (leave-alone, not clear)", async () => {
    await updateSpeaker({ ...BASE, fields: { jobTitle: "Prof" } });

    const { data } = mockRunOptimisticUpdate.mock.calls[0][0];
    expect("phone" in data).toBe(false);
    expect("bio" in data).toBe(false);
  });

  it("binds the write to BOTH speakerId and eventId (no cross-event reach)", async () => {
    await updateSpeaker({ ...BASE, fields: { jobTitle: "Prof" } });

    expect(mockDb.speaker.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "spk-1", eventId: "evt-1" } }),
    );
    const { where } = mockRunOptimisticUpdate.mock.calls[0][0];
    expect(where).toEqual({ id: "spk-1", eventId: "evt-1" });
  });

  it("always bumps updatedAt so the version token moves", async () => {
    await updateSpeaker({ ...BASE, fields: { jobTitle: "Prof" } });
    const { data } = mockRunOptimisticUpdate.mock.calls[0][0];
    expect(data.updatedAt).toBeInstanceOf(Date);
  });

  it("threads the optimistic-lock token through", async () => {
    await updateSpeaker({
      ...BASE,
      fields: { jobTitle: "Prof" },
      expectedUpdatedAt: "2026-07-14T00:00:00.000Z",
    });
    expect(mockRunOptimisticUpdate.mock.calls[0][0].expectedUpdatedAt).toBe(
      "2026-07-14T00:00:00.000Z",
    );
  });
});

describe("error cases (errors-as-values)", () => {
  it("SPEAKER_NOT_FOUND when the row doesn't exist in that event", async () => {
    mockDb.speaker.findFirst.mockResolvedValue(null);

    const res = await updateSpeaker({ ...BASE, fields: { jobTitle: "Prof" } });

    expect(res).toMatchObject({ ok: false, code: "SPEAKER_NOT_FOUND" });
    expect(mockRunOptimisticUpdate).not.toHaveBeenCalled();
    expect(mockSyncToContact).not.toHaveBeenCalled();
  });

  it("NO_FIELDS when the caller supplies nothing to change", async () => {
    const res = await updateSpeaker({ ...BASE, fields: {} });

    expect(res).toMatchObject({ ok: false, code: "NO_FIELDS" });
    expect(mockRunOptimisticUpdate).not.toHaveBeenCalled();
  });

  it("STALE_WRITE when the optimistic lock rejects — and NOTHING fans out", async () => {
    mockRunOptimisticUpdate.mockResolvedValue({ ok: false, reason: "STALE_WRITE" });

    const res = await updateSpeaker({ ...BASE, fields: { jobTitle: "Prof" } });

    expect(res).toMatchObject({ ok: false, code: "STALE_WRITE" });
    // A rejected write must not sync, audit, or refresh stats.
    expect(mockSyncToContact).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    expect(mockRefreshStats).not.toHaveBeenCalled();
  });

  it("SPEAKER_NOT_FOUND when the row vanished between read and write", async () => {
    mockRunOptimisticUpdate.mockResolvedValue({ ok: false, reason: "NOT_FOUND" });

    const res = await updateSpeaker({ ...BASE, fields: { jobTitle: "Prof" } });

    expect(res).toMatchObject({ ok: false, code: "SPEAKER_NOT_FOUND" });
  });

  it("UNKNOWN (not a throw) when the DB blows up", async () => {
    mockDb.speaker.findUniqueOrThrow.mockRejectedValue(new Error("boom"));

    const res = await updateSpeaker({ ...BASE, fields: { jobTitle: "Prof" } });

    expect(res).toMatchObject({ ok: false, code: "UNKNOWN" });
    expect(mockApiLogger.error).toHaveBeenCalled();
  });
});

describe("side-effect fan-out", () => {
  it("mirrors a tag change onto the registration facet", async () => {
    await updateSpeaker({ ...BASE, fields: { tags: ["Faculty", "Committee"] } });

    expect(mockSyncSpeakerTags).toHaveBeenCalledTimes(1);
    const [eventId, changes] = mockSyncSpeakerTags.mock.calls[0];
    expect(eventId).toBe("evt-1");
    expect(changes[0]).toMatchObject({ speakerId: "spk-1", email: "jane@hospital.com" });
    expect(changes[0].delta.added).toContain("Committee");
  });

  it("does NOT touch the tag mirror when tags weren't in the payload", async () => {
    await updateSpeaker({ ...BASE, fields: { jobTitle: "Prof" } });
    expect(mockSyncSpeakerTags).not.toHaveBeenCalled();
  });

  it("writes an audit row tagged with the calling surface", async () => {
    await updateSpeaker({ ...BASE, source: "mcp", fields: { jobTitle: "Prof" } });

    const { data } = mockDb.auditLog.create.mock.calls[0][0];
    expect(data).toMatchObject({
      eventId: "evt-1",
      userId: "user-1",
      action: "UPDATE",
      entityType: "Speaker",
      entityId: "spk-1",
    });
    expect(data.changes).toMatchObject({ source: "mcp" });
    // Full before/after snapshots — the Activity timeline renders diffs from these.
    expect(data.changes.before).toBeTruthy();
    expect(data.changes.after).toBeTruthy();
    expect(data.changes.fieldsChanged).toContain("jobTitle");
  });

  it("an audit-write failure does NOT fail the committed update", async () => {
    mockDb.auditLog.create.mockReturnValue({
      catch: (fn: (e: unknown) => void) => fn(new Error("audit down")),
    });

    const res = await updateSpeaker({ ...BASE, fields: { jobTitle: "Prof" } });

    expect(res.ok).toBe(true);
  });

  it("refreshes event stats for the speaker's OWN event", async () => {
    await updateSpeaker({ ...BASE, fields: { jobTitle: "Prof" } });
    expect(mockRefreshStats).toHaveBeenCalledWith("evt-1");
  });
});

describe("decline cascade", () => {
  it("does not fire on a non-decline write", async () => {
    const res = await updateSpeaker({ ...BASE, fields: { jobTitle: "Prof" } });

    expect(res.ok && res.companionCascade).toBeNull();
    expect(mockCancelRegistration).not.toHaveBeenCalled();
  });

  it("fires on CONFIRMED → DECLINED and KEEPS the companion by default", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ ...EXISTING, sourceRegistrationId: "reg-1" });
    mockDb.speaker.findUniqueOrThrow.mockResolvedValue({ ...UPDATED, status: "DECLINED" });
    mockDb.registration.findFirst.mockResolvedValue({
      id: "reg-1",
      status: "CONFIRMED",
      createdSource: "SPEAKER_COMPANION",
    });

    const res = await updateSpeaker({ ...BASE, fields: { status: "DECLINED" } });

    expect(res.ok && res.companionCascade?.companion).toBe("kept");
    expect(mockCancelRegistration).not.toHaveBeenCalled();
  });

  it("cancels the companion when the caller opts in (revokes badge + barcode)", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ ...EXISTING, sourceRegistrationId: "reg-1" });
    mockDb.speaker.findUniqueOrThrow.mockResolvedValue({ ...UPDATED, status: "DECLINED" });
    mockDb.registration.findFirst.mockResolvedValue({
      id: "reg-1",
      status: "CONFIRMED",
      createdSource: "SPEAKER_COMPANION",
    });

    const res = await updateSpeaker({
      ...BASE,
      fields: { status: "DECLINED" },
      cancelCompanionRegistration: true,
    });

    expect(res.ok && res.companionCascade?.companion).toBe("cancelled");
    expect(mockCancelRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ registrationId: "reg-1", refund: false }),
    );
  });
});
