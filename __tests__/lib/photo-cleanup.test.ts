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
import { runWithTenant } from "@/lib/tenant-context";

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


describe("a count made outside a tenant lane is never trusted (Nov 18, 2026)", () => {
  // The three tables carry a row policy. With row security on and no lane the
  // counts read 0 whatever the truth is, so "nothing references it" would mean
  // nothing, and the file would be deleted from under the rows that use it.
  it("row security on and no lane: the file is left alone, nothing is counted, the skip is logged", async () => {
    vi.stubEnv("RLS_SET_LOCAL", "1");
    try {
      await deletePhotoIfUnreferenced(URL);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(mockDeletePhoto).not.toHaveBeenCalled();
    expect(mockDb.attendee.count).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "photo-cleanup:skipped-no-lane", photo: URL }));
  });

  it("row security on and IN a lane: counted and unlinked as before", async () => {
    vi.stubEnv("RLS_SET_LOCAL", "1");
    try {
      await runWithTenant("org-1", () => deletePhotoIfUnreferenced(URL));
    } finally {
      vi.unstubAllEnvs();
    }
    expect(mockDb.attendee.count).toHaveBeenCalled();
    expect(mockDeletePhoto).toHaveBeenCalledWith(URL);
  });

  it("row security off (production today): unchanged, lane or no lane", async () => {
    await deletePhotoIfUnreferenced(URL);
    expect(mockDeletePhoto).toHaveBeenCalledWith(URL);
  });
});
