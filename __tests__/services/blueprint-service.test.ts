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
    blueprint: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
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
const BODY = { id: ID, v: 2, basics: { title: "Summit" } };
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
    mockDb.blueprint.findUnique.mockResolvedValue({ organizationId: "org-2", status: "DRAFT", archivedAt: null, editorIds: [] });
    expect(await saveBlueprint(ME, ID, BODY)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(mockDb.blueprint.update).not.toHaveBeenCalled();
    expect(mockDb.blueprint.create).not.toHaveBeenCalled();
  });

  it("an archived blueprint cannot be saved", async () => {
    mockDb.blueprint.findUnique.mockResolvedValue({ organizationId: "org-1", status: "DRAFT", archivedAt: new Date(), editorIds: [] });
    expect(await saveBlueprint(ME, ID, BODY)).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("records the editor of a submitted blueprint, once", async () => {
    mockDb.blueprint.findUnique.mockResolvedValue({ organizationId: "org-1", status: "SUBMITTED", archivedAt: null, editorIds: [] });
    await saveBlueprint(ME, ID, BODY);
    expect(mockDb.blueprint.update.mock.calls[0][0].data.editorIds).toEqual({ push: "u-1" });

    mockDb.blueprint.findUnique.mockResolvedValue({ organizationId: "org-1", status: "SUBMITTED", archivedAt: null, editorIds: ["u-1"] });
    await saveBlueprint(ME, ID, BODY);
    expect(mockDb.blueprint.update.mock.calls[1][0].data).not.toHaveProperty("editorIds");
  });

  it("does not record editors while it is a draft", async () => {
    mockDb.blueprint.findUnique.mockResolvedValue({ organizationId: "org-1", status: "DRAFT", archivedAt: null, editorIds: [] });
    await saveBlueprint(ME, ID, BODY);
    expect(mockDb.blueprint.update.mock.calls[0][0].data).not.toHaveProperty("editorIds");
  });

  it("two first saves that race: the loser updates", async () => {
    const race = new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "t" });
    mockDb.blueprint.create.mockRejectedValueOnce(race);
    mockDb.blueprint.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ organizationId: "org-1", status: "DRAFT", archivedAt: null, editorIds: [] });
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

describe("files", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(16)]);

  it("stores a real image under the organisation and answers the page's contract", async () => {
    mockStorage.uploadFile.mockResolvedValue("/uploads/blueprints/org-1/abc.png");
    mockDb.blueprintFile.create.mockResolvedValue({ id: "f1" });
    const res = await storeFile(ME, { buffer: png, name: "plan.png" });
    expect(res).toEqual({ ok: true, file: { id: "f1", url: "/api/blueprint/files/f1", sizeBytes: png.length, contentType: "image/png" } });
    expect(mockStorage.uploadFile.mock.calls[0][3]).toBe("blueprints/org-1");
  });

  it("refuses a file whose bytes are not an accepted type, before storing", async () => {
    expect(await storeFile(ME, { buffer: Buffer.from("<html>"), name: "x.png" })).toMatchObject({ ok: false, code: "UNSUPPORTED_FILE" });
    expect(mockStorage.uploadFile).not.toHaveBeenCalled();
  });

  it("refuses more than 10 MB", async () => {
    const big = Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]);
    expect(await storeFile(ME, { buffer: big, name: "x.png" })).toMatchObject({ ok: false, code: "FILE_TOO_LARGE" });
  });

  it("removing another organisation's file is not found", async () => {
    mockDb.blueprintFile.findFirst.mockResolvedValue(null);
    expect(await removeFile("org-1", "f9")).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(mockDb.blueprintFile.delete).not.toHaveBeenCalled();
  });
});
