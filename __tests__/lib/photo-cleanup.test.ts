/**
 * Reference-checked photo cleanup (INC-004). A shared photo path must NEVER
 * be unlinked while any Attendee/Speaker/Contact row still references it —
 * that is exactly how 27 prod photo files were destroyed on July 24, 2026.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockDeletePhoto, mockLogger } = vi.hoisted(() => ({
  mockDb: {
    attendee: { count: vi.fn() },
    speaker: { count: vi.fn() },
    contact: { count: vi.fn() },
  },
  mockDeletePhoto: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/storage", () => ({ deletePhoto: (u: string) => mockDeletePhoto(u) }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));

import { deletePhotoIfUnreferenced } from "@/lib/photo-cleanup";

const URL = "/uploads/photos/2026/07/b017b5f4.png";

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.attendee.count.mockResolvedValue(0);
  mockDb.speaker.count.mockResolvedValue(0);
  mockDb.contact.count.mockResolvedValue(0);
  mockDeletePhoto.mockResolvedValue(undefined);
});

describe("deletePhotoIfUnreferenced", () => {
  it("unlinks when nothing references the URL", async () => {
    await deletePhotoIfUnreferenced(URL);
    expect(mockDeletePhoto).toHaveBeenCalledWith(URL);
  });

  it("NEVER unlinks while a sibling row still references it — the INC-004 property", async () => {
    // The speaker was deleted, but the org Contact (synced copy of the same
    // path) survives — the file must stay.
    mockDb.contact.count.mockResolvedValue(1);
    await deletePhotoIfUnreferenced(URL);
    expect(mockDeletePhoto).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "photo-cleanup:still-referenced", references: 1 }),
    );
  });

  it("any of the three tables blocks the unlink", async () => {
    for (const table of ["attendee", "speaker", "contact"] as const) {
      vi.clearAllMocks();
      mockDb.attendee.count.mockResolvedValue(0);
      mockDb.speaker.count.mockResolvedValue(0);
      mockDb.contact.count.mockResolvedValue(0);
      mockDb[table].count.mockResolvedValue(2);
      await deletePhotoIfUnreferenced(URL);
      expect(mockDeletePhoto).not.toHaveBeenCalled();
    }
  });

  it("checks each table for the exact URL", async () => {
    await deletePhotoIfUnreferenced(URL);
    expect(mockDb.attendee.count).toHaveBeenCalledWith({ where: { photo: URL } });
    expect(mockDb.speaker.count).toHaveBeenCalledWith({ where: { photo: URL } });
    expect(mockDb.contact.count).toHaveBeenCalledWith({ where: { photo: URL } });
  });

  it("never throws — a DB blip logs a warning and skips the unlink", async () => {
    mockDb.speaker.count.mockRejectedValue(new Error("pool timeout"));
    await expect(deletePhotoIfUnreferenced(URL)).resolves.toBeUndefined();
    expect(mockDeletePhoto).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "photo-cleanup:failed" }),
    );
  });

  it("never throws even when the unlink itself fails", async () => {
    mockDeletePhoto.mockRejectedValue(new Error("EACCES"));
    await expect(deletePhotoIfUnreferenced(URL)).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});
