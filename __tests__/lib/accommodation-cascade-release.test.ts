/**
 * releaseRoomForDeletedPerson — the cascade hole (review H4).
 *
 * `Accommodation` has `onDelete: Cascade` from BOTH `Registration` and
 * `Speaker`. A database cascade fires NO application code, so deleting a
 * registrant used to make their booking row vanish while `RoomType.bookedRooms`
 * kept counting it — permanently. The room type then reports sold out with an
 * empty room and every future booking fails NO_ROOMS_AVAILABLE, with no recovery
 * path short of hand-written SQL.
 *
 * The delete transactions already released the ticket seat and the promo-code
 * usage; accommodation was simply missed. These pin the release.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { releaseRoomForDeletedPerson } from "@/lib/accommodation-rooms";

function makeTx(booking: { status: string; roomTypeId: string } | null) {
  return {
    accommodation: { findFirst: vi.fn().mockResolvedValue(booking) },
    roomType: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  } as unknown as Parameters<typeof releaseRoomForDeletedPerson>[0] & {
    accommodation: { findFirst: ReturnType<typeof vi.fn> };
    roomType: { updateMany: ReturnType<typeof vi.fn> };
  };
}

describe("releaseRoomForDeletedPerson", () => {
  beforeEach(() => vi.clearAllMocks());

  it("releases the room held by a deleted REGISTRATION (guarded, never below 0)", async () => {
    const tx = makeTx({ status: "CONFIRMED", roomTypeId: "rt1" });
    await releaseRoomForDeletedPerson(tx, { registrationId: "reg1" });

    expect(tx.accommodation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { registrationId: "reg1" } }),
    );
    expect(tx.roomType.updateMany).toHaveBeenCalledWith({
      where: { id: "rt1", bookedRooms: { gt: 0 } },
      data: { bookedRooms: { decrement: 1 } },
    });
  });

  it("releases the room held by a deleted SPEAKER", async () => {
    const tx = makeTx({ status: "CHECKED_IN", roomTypeId: "rt2" });
    await releaseRoomForDeletedPerson(tx, { speakerId: "spk1" });

    expect(tx.accommodation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { speakerId: "spk1" } }),
    );
    expect(tx.roomType.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "rt2", bookedRooms: { gt: 0 } } }),
    );
  });

  it("does NOT release when the booking was already cancelled (it holds no room)", async () => {
    const tx = makeTx({ status: "CANCELLED", roomTypeId: "rt1" });
    await releaseRoomForDeletedPerson(tx, { registrationId: "reg1" });
    // Releasing here would be the double-release that drives the counter negative.
    expect(tx.roomType.updateMany).not.toHaveBeenCalled();
  });

  it("is a no-op when the person has no booking at all", async () => {
    const tx = makeTx(null);
    await releaseRoomForDeletedPerson(tx, { registrationId: "reg1" });
    expect(tx.roomType.updateMany).not.toHaveBeenCalled();
  });
});
