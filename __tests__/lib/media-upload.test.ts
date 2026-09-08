/**
 * storeUploadedMedia (src/lib/media-upload.ts): the storage-then-row half of
 * a media upload, shared by the org and event upload routes.
 *
 * The load-bearing case is the second one: a failed row insert must delete
 * the object that was just uploaded, or it outlives the request in PUBLIC
 * storage with nothing pointing at it (review Sep 8, 2026, P2c, the org
 * route's actual behaviour before this helper).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock factories are hoisted above every const in this file, so the fns
// they close over must be hoisted too.
const { uploadMedia, deleteMedia, create, error } = vi.hoisted(() => ({
  uploadMedia: vi.fn(async () => "/uploads/media/2026/09/abc.png"),
  deleteMedia: vi.fn(async () => undefined),
  create: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/storage", () => ({ uploadMedia, deleteMedia }));
vi.mock("@/lib/db", () => ({ db: { mediaFile: { create } } }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error, debug: vi.fn() },
}));

import { storeUploadedMedia, safeMediaFilename } from "@/lib/media-upload";

const input = {
  buffer: Buffer.from("png"),
  detectedMime: "image/png",
  originalFilename: "logo.png",
  size: 3,
  organizationId: "org1",
  uploadedById: "u1",
};

beforeEach(() => vi.clearAllMocks());

describe("storeUploadedMedia", () => {
  it("uploads the object, inserts the row, and returns the row without touching delete", async () => {
    create.mockResolvedValueOnce({ id: "m1", url: "/uploads/media/2026/09/abc.png" });
    const row = await storeUploadedMedia(input);
    expect(row).toEqual({ id: "m1", url: "/uploads/media/2026/09/abc.png" });
    expect(uploadMedia).toHaveBeenCalledWith(input.buffer, expect.stringMatching(/\.png$/), "image/png");
    expect(create.mock.calls[0]?.[0]?.data).toMatchObject({
      organizationId: "org1",
      uploadedById: "u1",
      filename: "logo.png",
      url: "/uploads/media/2026/09/abc.png",
      mimeType: "image/png",
      size: 3,
    });
    expect(deleteMedia).not.toHaveBeenCalled();
  });

  it("deletes the just-uploaded object when the row insert fails, and rethrows the ORIGINAL error", async () => {
    const dbErr = new Error("connection reset");
    create.mockRejectedValueOnce(dbErr);
    await expect(storeUploadedMedia(input)).rejects.toBe(dbErr);
    expect(deleteMedia).toHaveBeenCalledWith("/uploads/media/2026/09/abc.png");
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "media:row-create-failed-deleting-orphaned-object", url: "/uploads/media/2026/09/abc.png" }),
    );
  });

  it("a failed cleanup is logged and still surfaces the row error, never the cleanup error", async () => {
    const dbErr = new Error("connection reset");
    create.mockRejectedValueOnce(dbErr);
    deleteMedia.mockRejectedValueOnce(new Error("s3 down"));
    await expect(storeUploadedMedia(input)).rejects.toBe(dbErr);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ msg: "media:orphaned-object-cleanup-failed" }));
  });

  it("carries eventId only when given, so an org upload stays event-less", async () => {
    create.mockResolvedValueOnce({ id: "m2" });
    await storeUploadedMedia({ ...input, eventId: "ev1" });
    expect(create.mock.calls[0]?.[0]?.data).toMatchObject({ eventId: "ev1" });
    create.mockResolvedValueOnce({ id: "m3" });
    await storeUploadedMedia(input);
    expect(create.mock.calls[1]?.[0]?.data).not.toHaveProperty("eventId");
  });
});

describe("safeMediaFilename", () => {
  it("strips path components, caps the length, and never returns empty", () => {
    expect(safeMediaFilename("../../etc/passwd")).toBe("....etcpasswd");
    expect(safeMediaFilename("C:\\Users\\x\\logo.png")).toBe("C:Usersxlogo.png");
    expect(safeMediaFilename("a".repeat(300))).toHaveLength(255);
    expect(safeMediaFilename("")).toBe("upload");
  });
});
