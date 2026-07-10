/**
 * Phase 0 — speaker companion registration helper.
 * Verifies the three idempotent paths + that companions are comp/uncapped
 * (COMPLIMENTARY, no soldCount increment, Faculty badge/barcode).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const ticketTypeFindFirst = vi.fn();
const ticketTypeCreate = vi.fn();
const registrationFindFirst = vi.fn();
const speakerUpdate = vi.fn();
const txAttendeeCreate = vi.fn();
const txRegistrationCreate = vi.fn();
const txSpeakerUpdate = vi.fn();

const tx = {
  attendee: { create: (...a: unknown[]) => txAttendeeCreate(...a) },
  registration: { create: (...a: unknown[]) => txRegistrationCreate(...a) },
  speaker: { update: (...a: unknown[]) => txSpeakerUpdate(...a) },
};

vi.mock("@/lib/db", () => ({
  db: {
    ticketType: {
      findFirst: (...a: unknown[]) => ticketTypeFindFirst(...a),
      create: (...a: unknown[]) => ticketTypeCreate(...a),
    },
    registration: { findFirst: (...a: unknown[]) => registrationFindFirst(...a) },
    speaker: { update: (...a: unknown[]) => speakerUpdate(...a) },
    $transaction: (cb: (t: typeof tx) => unknown) => cb(tx),
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/utils", () => ({ generateBarcode: () => "BC-TEST-123" }));
vi.mock("@/lib/registration-serial", () => ({ getNextSerialId: vi.fn(async () => 7) }));

import { ensureSpeakerCompanionRegistration } from "@/lib/speaker-companion";

const base = {
  id: "spk_1",
  eventId: "evt_1",
  email: "doc@example.com",
  firstName: "Jane",
  lastName: "Doe",
  sourceRegistrationId: null as string | null,
};

beforeEach(() => {
  [
    ticketTypeFindFirst, ticketTypeCreate, registrationFindFirst, speakerUpdate,
    txAttendeeCreate, txRegistrationCreate, txSpeakerUpdate,
  ].forEach((m) => m.mockReset());
  txAttendeeCreate.mockResolvedValue({ id: "att_new" });
  txRegistrationCreate.mockResolvedValue({ id: "reg_new" });
});

describe("ensureSpeakerCompanionRegistration", () => {
  it("no-ops when already linked", async () => {
    const res = await ensureSpeakerCompanionRegistration({ ...base, sourceRegistrationId: "reg_existing" });
    expect(res).toEqual({ status: "already-linked", registrationId: "reg_existing" });
    expect(registrationFindFirst).not.toHaveBeenCalled();
    expect(txRegistrationCreate).not.toHaveBeenCalled();
  });

  it("links an existing same-email registration instead of duplicating", async () => {
    registrationFindFirst.mockResolvedValueOnce({ id: "reg_match" });
    const res = await ensureSpeakerCompanionRegistration(base);
    expect(res).toEqual({ status: "linked-by-email", registrationId: "reg_match" });
    expect(speakerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "spk_1" }, data: { sourceRegistrationId: "reg_match" } }),
    );
    expect(txRegistrationCreate).not.toHaveBeenCalled();
  });

  it("never links a CANCELLED registration as the companion (review H3)", async () => {
    // The email-match query must exclude CANCELLED rows — a cancelled reg
    // hard-fails check-in, so linking it hands the speaker a dead barcode
    // permanently. The where clause is the contract.
    registrationFindFirst.mockResolvedValueOnce(null); // (post-filter: nothing linkable)
    ticketTypeFindFirst.mockResolvedValueOnce({ id: "ftype" });

    await ensureSpeakerCompanionRegistration(base);

    expect(registrationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { not: "CANCELLED" } }),
      }),
    );
    // Falls through to creating a fresh Faculty companion.
    expect(txRegistrationCreate).toHaveBeenCalled();
  });

  it("creates a comp, uncapped Faculty companion when no match exists", async () => {
    registrationFindFirst.mockResolvedValueOnce(null);
    ticketTypeFindFirst.mockResolvedValueOnce(null);
    ticketTypeCreate.mockResolvedValueOnce({ id: "ftype_new" });

    const res = await ensureSpeakerCompanionRegistration(base);
    expect(res).toEqual({ status: "created", registrationId: "reg_new" });

    // Faculty type provisioned.
    expect(ticketTypeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isFaculty: true, price: 0 }) }),
    );
    // Companion registration: comp, in-person, barcode minted, Faculty badge, tagged source.
    const regArg = txRegistrationCreate.mock.calls[0][0].data;
    expect(regArg).toMatchObject({
      eventId: "evt_1",
      ticketTypeId: "ftype_new",
      status: "CONFIRMED",
      paymentStatus: "COMPLIMENTARY",
      attendanceMode: "IN_PERSON",
      qrCode: "BC-TEST-123",
      serialId: 7,
      badgeType: "Faculty",
      createdSource: "SPEAKER_COMPANION",
    });
    // Linked back to the speaker.
    expect(txSpeakerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "spk_1" }, data: { sourceRegistrationId: "reg_new" } }),
    );
    // Uncapped: NO soldCount increment anywhere (no ticketType.update in the tx).
    expect(JSON.stringify(txRegistrationCreate.mock.calls[0][0])).not.toContain("soldCount");
  });

  it("sets the companion attendee's registrationType to the speaker's profession, never 'Faculty'", async () => {
    registrationFindFirst.mockResolvedValueOnce(null);
    ticketTypeFindFirst.mockResolvedValueOnce({ id: "ftype" });

    await ensureSpeakerCompanionRegistration({ ...base, registrationType: "Physician" });

    // Profession goes on the attendee's registrationType...
    expect(txAttendeeCreate.mock.calls[0][0].data.registrationType).toBe("Physician");
    // ...while "Faculty" stays where it belongs — the badge, not the reg type.
    expect(txRegistrationCreate.mock.calls[0][0].data.badgeType).toBe("Faculty");
  });

  it("leaves registrationType undefined (not 'Faculty') when the speaker has no profession", async () => {
    registrationFindFirst.mockResolvedValueOnce(null);
    ticketTypeFindFirst.mockResolvedValueOnce({ id: "ftype" });

    await ensureSpeakerCompanionRegistration(base); // base has no registrationType

    expect(txAttendeeCreate.mock.calls[0][0].data.registrationType).toBeUndefined();
  });

  it("reuses an existing Faculty type rather than creating a second", async () => {
    registrationFindFirst.mockResolvedValueOnce(null);
    ticketTypeFindFirst.mockResolvedValueOnce({ id: "ftype_existing" });
    await ensureSpeakerCompanionRegistration(base);
    expect(ticketTypeCreate).not.toHaveBeenCalled();
    expect(txRegistrationCreate.mock.calls[0][0].data.ticketTypeId).toBe("ftype_existing");
  });
});
