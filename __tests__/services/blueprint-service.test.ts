/**
 * blueprint-service: storage for the Event Blueprint page. Pins tenant
 * isolation by id (another organisation's id reads as not found), the
 * editor record that approval's separation of duties reads, the first-save
 * race, and the file type and size refusals.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const { mockDb, mockStorage } = vi.hoisted(() => ({
  mockDb: {
    blueprint: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    blueprintTemplate: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
    blueprintFile: { create: vi.fn(), findFirst: vi.fn(), delete: vi.fn() },
  },
  mockStorage: { uploadFile: vi.fn(), readStoredFile: vi.fn(), deleteStoredFile: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/storage", () => mockStorage);

import { saveBlueprint, getBlueprint, saveTemplate, storeFile, removeFile } from "@/services/blueprint-service";

const ME = { organizationId: "org-1", userId: "u-1" };
const ID = "bp_mg9x2k1abcde";
const SEEN = 5000;
const BODY = { id: ID, v: 2, basics: { title: "Summit" }, serverVersion: SEEN };
const updatedAt = new Date(9000);

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.blueprint.findUnique.mockResolvedValue(null);
  mockDb.blueprint.create.mockResolvedValue({ updatedAt });
  mockDb.blueprint.update.mockResolvedValue({ updatedAt });
});

describe("saveBlueprint", () => {
  it("creates a new blueprint owned by the caller in their organisation", async () => {
    const res = await saveBlueprint(ME, ID, BODY);
    expect(res).toEqual({ ok: true, updated: 9000 });
    expect(mockDb.blueprint.create.mock.calls[0][0].data).toMatchObject({ id: ID, organizationId: "org-1", ownerId: "u-1", title: "Summit" });
  });

  it("an id held by another organisation reads as not found and writes nothing", async () => {
    mockDb.blueprint.findUnique.mockResolvedValue({ organizationId: "org-2", ownerId: "x", archivedAt: null, editorIds: [], updatedAt: new Date(SEEN) });
    expect(await saveBlueprint(ME, ID, BODY)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(mockDb.blueprint.update).not.toHaveBeenCalled();
    expect(mockDb.blueprint.create).not.toHaveBeenCalled();
  });

  it("refuses a save made from an older version, so nobody's work is overwritten (review M5)", async () => {
    mockDb.blueprint.findUnique.mockResolvedValue({ organizationId: "org-1", ownerId: "u-1", archivedAt: null, editorIds: [], updatedAt: new Date(SEEN + 1) });
    expect(await saveBlueprint(ME, ID, BODY)).toMatchObject({ ok: false, code: "STALE_VERSION" });
    expect(mockDb.blueprint.update).not.toHaveBeenCalled();
  });

  it("a row that stays invisible after a clash is another organisation's: not found, not a 500 (review L13)", async () => {
    const clash = new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "t" });
    mockDb.blueprint.findUnique.mockResolvedValue(null);
    mockDb.blueprint.create.mockRejectedValue(clash);
    expect(await saveBlueprint(ME, ID, BODY)).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("an archived blueprint cannot be saved", async () => {
    mockDb.blueprint.findUnique.mockResolvedValue({ organizationId: "org-1", ownerId: "u-1", archivedAt: new Date(), editorIds: [], updatedAt: new Date(SEEN) });
    expect(await saveBlueprint(ME, ID, BODY)).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("records anyone but the owner who edits it, once, at any stage (review H1)", async () => {
    mockDb.blueprint.findUnique.mockResolvedValue({ organizationId: "org-1", ownerId: "someone-else", archivedAt: null, editorIds: [], updatedAt: new Date(SEEN) });
    await saveBlueprint(ME, ID, BODY);
    expect(mockDb.blueprint.update.mock.calls[0][0].data.editorIds).toEqual({ push: "u-1" });

    mockDb.blueprint.findUnique.mockResolvedValue({ organizationId: "org-1", ownerId: "someone-else", archivedAt: null, editorIds: ["u-1"], updatedAt: new Date(SEEN) });
    await saveBlueprint(ME, ID, BODY);
    expect(mockDb.blueprint.update.mock.calls[1][0].data).not.toHaveProperty("editorIds");
  });

  it("never records the owner as an editor", async () => {
    mockDb.blueprint.findUnique.mockResolvedValue({ organizationId: "org-1", ownerId: "u-1", archivedAt: null, editorIds: [], updatedAt: new Date(SEEN) });
    await saveBlueprint(ME, ID, BODY);
    expect(mockDb.blueprint.update.mock.calls[0][0].data).not.toHaveProperty("editorIds");
  });

  it("two first saves that race: the loser updates", async () => {
    const race = new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "t" });
    mockDb.blueprint.create.mockRejectedValueOnce(race);
    mockDb.blueprint.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ organizationId: "org-1", ownerId: "u-1", archivedAt: null, editorIds: [], updatedAt: new Date(SEEN) });
    expect(await saveBlueprint(ME, ID, BODY)).toEqual({ ok: true, updated: 9000 });
    expect(mockDb.blueprint.update).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a malformed id", "../etc", BODY, "INVALID_ID"],
    ["a body for another id", ID, { id: "bp_zzzzzzzz" }, "ID_MISMATCH"],
  ])("refuses %s", async (_l, id, body, code) => {
    expect(await saveBlueprint(ME, id, body)).toMatchObject({ ok: false, code });
  });
});

describe("getBlueprint", () => {
  it("looks up by id AND organisation", async () => {
    mockDb.blueprint.findFirst.mockResolvedValue(null);
    expect(await getBlueprint("org-1", ID)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(mockDb.blueprint.findFirst.mock.calls[0][0].where).toEqual({ id: ID, organizationId: "org-1", archivedAt: null });
  });
});

describe("saveTemplate", () => {
  it("refuses another organisation's template id", async () => {
    mockDb.blueprintTemplate.findUnique.mockResolvedValue({ organizationId: "org-2" });
    expect(await saveTemplate(ME, "tp_abcd1234", { name: "x", state: {} })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(mockDb.blueprintTemplate.upsert).not.toHaveBeenCalled();
  });
});

describe("files (each belongs to one blueprint, review L12)", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(16)]);
  const upload = (over: Partial<{ buffer: Buffer; name: string; blueprintId: string }> = {}) =>
    storeFile(ME, { buffer: png, name: "plan.png", blueprintId: ID, ...over });

  beforeEach(() => {
    mockDb.blueprint.findFirst.mockResolvedValue({ id: ID, updatedAt: new Date(7000) });
    mockDb.blueprint.updateMany.mockResolvedValue({ count: 1 });
    mockStorage.uploadFile.mockResolvedValue("/uploads/blueprints/org-1/abc.png");
    mockDb.blueprintFile.create.mockResolvedValue({ id: "f1" });
  });

  it("stores a real image for its blueprint, records the uploader as an editor, and returns the new version", async () => {
    const res = await upload();
    expect(res).toEqual({ ok: true, file: { id: "f1", url: "/api/blueprint/files/f1", sizeBytes: png.length, contentType: "image/png", serverVersion: 7000 } });
    expect(mockDb.blueprintFile.create.mock.calls[0][0].data).toMatchObject({ blueprintId: ID, organizationId: "org-1" });
    expect(mockDb.blueprint.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: ID, NOT: [{ ownerId: "u-1" }, { editorIds: { has: "u-1" } }] },
      data: { editorIds: { push: "u-1" } },
    });
  });

  it("refuses a blueprint that is not saved, or is another organisation's, before storing anything", async () => {
    mockDb.blueprint.findFirst.mockResolvedValue(null);
    expect(await upload()).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(mockStorage.uploadFile).not.toHaveBeenCalled();
  });

  it("refuses a file whose bytes are not an accepted type, and a ZIP merely named .docx", async () => {
    expect(await upload({ buffer: Buffer.from("<html>"), name: "x.png" })).toMatchObject({ ok: false, code: "UNSUPPORTED_FILE" });
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("notes.txt hello")]);
    expect(await upload({ buffer: zip, name: "brief.docx" })).toMatchObject({ ok: false, code: "UNSUPPORTED_FILE" });
    expect(mockStorage.uploadFile).not.toHaveBeenCalled();
  });

  it("refuses more than 10 MB", async () => {
    expect(await upload({ buffer: Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]) })).toMatchObject({ ok: false, code: "FILE_TOO_LARGE" });
  });

  it("removes the stored file when its row cannot be written", async () => {
    mockDb.blueprintFile.create.mockRejectedValue(new Error("db down"));
    await expect(upload()).rejects.toThrow("db down");
    expect(mockStorage.deleteStoredFile).toHaveBeenCalledWith("/uploads/blueprints/org-1/abc.png", "/uploads/blueprints/");
  });

  it("removing names the blueprint: a file of another blueprint is not found", async () => {
    mockDb.blueprintFile.findFirst.mockResolvedValue(null);
    expect(await removeFile(ME, "f9", "bp_otherone1")).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(mockDb.blueprintFile.findFirst.mock.calls[0][0].where).toMatchObject({ id: "f9", organizationId: "org-1", blueprintId: "bp_otherone1" });
    expect(mockDb.blueprintFile.delete).not.toHaveBeenCalled();
  });
});
