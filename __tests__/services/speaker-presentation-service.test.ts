import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Speaker presentations (Nov 19, 2026; docs/SPEAKER_PRESENTATIONS_PLAN.md):
 * the service that decides everything about a file, for both doors. Storage
 * is mocked, which is how the S3 path is covered: the browser suite runs the
 * local provider.
 */

const { mockDb, storage } = vi.hoisted(() => ({
  mockDb: {
    topicSpeaker: { findMany: vi.fn() },
    sessionSpeaker: { findMany: vi.fn() },
    speakerPresentation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
  },
  storage: {
    provider: "s3" as string,
    signDirectUpload: vi.fn(),
    headStoredFile: vi.fn(),
    readStoredFileStart: vi.fn(),
    signStoredFileDownload: vi.fn(),
    deleteStoredFile: vi.fn(),
    uploadFile: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (fn: (tx: unknown) => unknown) => fn(mockDb),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/storage", () => ({
  get storageProvider() {
    return storage.provider;
  },
  signDirectUpload: (...a: unknown[]) => storage.signDirectUpload(...a),
  headStoredFile: (...a: unknown[]) => storage.headStoredFile(...a),
  readStoredFileStart: (...a: unknown[]) => storage.readStoredFileStart(...a),
  signStoredFileDownload: (...a: unknown[]) => storage.signStoredFileDownload(...a),
  deleteStoredFile: (...a: unknown[]) => storage.deleteStoredFile(...a),
  uploadFile: (...a: unknown[]) => storage.uploadFile(...a),
}));

import {
  completePresentationUpload,
  listSpeakerPresentations,
  presentationDownload,
  presentationsAvailable,
  presentationSlotsForSpeaker,
  receiveLocalPresentationFile,
  startPresentationUpload,
} from "@/services/speaker-presentation-service";
import { PRESENTATION_MAX_BYTES_PER_SPEAKER, PRESENTATION_MAX_FILES_PER_SPEAKER } from "@/lib/speaker-presentations";

const scope = { eventId: "ev1", organizationId: "org1", speakerId: "sp1" };
const speakerActor = { source: "speaker-form" as const };
const start = new Date("2026-11-20T10:00:00Z");
const topic = (id: string, title: string, sessionId = "s1") => ({
  topic: { id, title, sortOrder: 0, session: { id: sessionId, name: "Morning session", startTime: start } },
});
const PDF_START = Buffer.from("%PDF-1.7 and more");

beforeEach(() => {
  vi.clearAllMocks();
  storage.provider = "s3";
  // On S3 the owner switches presentations on after preparing the bucket.
  vi.stubEnv("SPEAKER_PRESENTATIONS_ENABLED", "true");
  mockDb.topicSpeaker.findMany.mockResolvedValue([topic("t1", "SGLT2 in practice")]);
  mockDb.sessionSpeaker.findMany.mockResolvedValue([]);
  mockDb.speakerPresentation.findMany.mockResolvedValue([]);
  mockDb.speakerPresentation.create.mockResolvedValue({});
  mockDb.speakerPresentation.updateMany.mockResolvedValue({ count: 1 });
  storage.signDirectUpload.mockResolvedValue({ via: "s3", url: "https://bucket.example/", fields: { key: "k", Policy: "p" } });
  storage.deleteStoredFile.mockResolvedValue(undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe("the talks a speaker can upload for (one file per talk)", () => {
  it("gives a slot per topic, and per session they present in without a topic there", async () => {
    mockDb.sessionSpeaker.findMany.mockResolvedValue([
      { role: "SPEAKER", session: { id: "s1", name: "Morning session", startTime: start } },
      { role: "PANELIST", session: { id: "s2", name: "Panel", startTime: new Date("2026-11-20T12:00:00Z") } },
    ]);
    const slots = await presentationSlotsForSpeaker("ev1", "sp1");
    // s1 is covered by its topic; s2 has no topic of theirs.
    expect(slots.map((s) => s.key)).toEqual(["topic:t1", "session:s2"]);
    expect(slots[0]).toMatchObject({ sessionId: "s1", topicId: "t1", title: "SGLT2 in practice", sessionName: "Morning session" });
  });

  it("gives none for running a session: a moderator or chair presents nothing", async () => {
    mockDb.topicSpeaker.findMany.mockResolvedValue([]);
    mockDb.sessionSpeaker.findMany.mockResolvedValue([
      { role: "MODERATOR", session: { id: "s1", name: "Morning session", startTime: start } },
      { role: "CHAIRPERSON", session: { id: "s2", name: "Panel", startTime: start } },
    ]);
    // On no talk of their own: the one general slot.
    expect((await presentationSlotsForSpeaker("ev1", "sp1")).map((s) => s.key)).toEqual(["general"]);
  });
});

describe("starting an upload", () => {
  const input = { ...scope, slotKey: "topic:t1", filename: "Deck.pdf", size: 5_000_000, actor: speakerActor };

  it("signs a form for one key under the speaker, with the server's type and the cap for that kind", async () => {
    const res = await startPresentationUpload(input);
    expect(res.ok).toBe(true);
    const signed = storage.signDirectUpload.mock.calls[0][0];
    expect(signed.storedPath).toMatch(/^\/uploads\/presentations\/ev1\/sp1\/[0-9a-f]{32}\.pdf$/);
    expect(signed).toMatchObject({ requirePrefix: "/uploads/presentations/", contentType: "application/pdf", maxBytes: 200 * 1024 * 1024, expiresSeconds: 900 });
    const row = mockDb.speakerPresentation.create.mock.calls[0][0].data;
    expect(row).toMatchObject({ eventId: "ev1", organizationId: "org1", speakerId: "sp1", sessionId: "s1", topicId: "t1", filename: "Deck.pdf", mimeType: "application/pdf", uploadedVia: "speaker-form" });
    expect(row.url).toBe(signed.storedPath);
  });

  it("gives a video its larger cap", async () => {
    await startPresentationUpload({ ...input, filename: "talk.mp4", size: 300 * 1024 * 1024 });
    expect(storage.signDirectUpload.mock.calls[0][0].maxBytes).toBe(500 * 1024 * 1024);
  });

  it("refuses before anything is signed or written: a type, a size, a talk that is not theirs", async () => {
    for (const [over, code] of [
      [{ filename: "notes.docx" }, "TYPE_NOT_ALLOWED"],
      [{ size: 201 * 1024 * 1024 }, "FILE_TOO_LARGE"],
      [{ slotKey: "topic:someone-elses" }, "INVALID_SLOT"],
    ] as const) {
      const res = await startPresentationUpload({ ...input, ...over });
      expect(res).toMatchObject({ ok: false, code });
    }
    expect(storage.signDirectUpload).not.toHaveBeenCalled();
    expect(mockDb.speakerPresentation.create).not.toHaveBeenCalled();
  });

  it("holds a speaker to a number of files and a total size, so a leaked link cannot fill the bucket", async () => {
    // First call inside start is the stale sweep, the second the quota read.
    mockDb.speakerPresentation.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce(Array.from({ length: PRESENTATION_MAX_FILES_PER_SPEAKER }, () => ({ size: BigInt(1) })));
    expect(await startPresentationUpload(input)).toMatchObject({ ok: false, code: "TOO_MANY_FILES" });
    mockDb.speakerPresentation.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ size: BigInt(PRESENTATION_MAX_BYTES_PER_SPEAKER - 1000) }]);
    expect(await startPresentationUpload(input)).toMatchObject({ ok: false, code: "QUOTA_EXCEEDED" });
    expect(storage.signDirectUpload).not.toHaveBeenCalled();
  });

  it("clears uploads never finished, with what they left in storage", async () => {
    mockDb.speakerPresentation.findMany.mockResolvedValueOnce([{ id: "old", url: "/uploads/presentations/ev1/sp1/old.pdf" }]).mockResolvedValueOnce([]);
    await startPresentationUpload(input);
    expect(mockDb.speakerPresentation.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["old"] }, status: "UPLOADING" }, data: { status: "FAILED" } });
    expect(storage.deleteStoredFile).toHaveBeenCalledWith("/uploads/presentations/ev1/sp1/old.pdf", "/uploads/presentations/");
  });

});

describe("switched off until the bucket is prepared", () => {
  const input = { ...scope, slotKey: "topic:t1", filename: "Deck.pdf", size: 5_000_000, actor: speakerActor };

  it("is off on S3 unless the owner has switched it on: the list says so and reads nothing, an upload is refused", async () => {
    vi.stubEnv("SPEAKER_PRESENTATIONS_ENABLED", "");
    expect(presentationsAvailable()).toBe(false);
    expect(await listSpeakerPresentations(scope)).toEqual({ enabled: false, slots: [], presentations: [] });
    expect(mockDb.topicSpeaker.findMany).not.toHaveBeenCalled();
    expect(await startPresentationUpload(input)).toMatchObject({ ok: false, code: "UPLOADS_UNAVAILABLE" });
    expect(storage.signDirectUpload).not.toHaveBeenCalled();
  });

  it("is on with the switch on S3, always on the local provider, and never on another provider", async () => {
    expect(presentationsAvailable()).toBe(true);
    expect((await listSpeakerPresentations(scope)).enabled).toBe(true);
    vi.stubEnv("SPEAKER_PRESENTATIONS_ENABLED", "");
    storage.provider = "local";
    expect(presentationsAvailable()).toBe(true);
    storage.provider = "supabase";
    vi.stubEnv("SPEAKER_PRESENTATIONS_ENABLED", "true");
    expect(presentationsAvailable()).toBe(false);
  });
});

describe("completing an upload", () => {
  const uploading = { id: "p1", sessionId: "s1", topicId: "t1", filename: "Deck.pdf", size: BigInt(5), status: "UPLOADING", uploadedVia: "speaker-form", createdAt: new Date(), readyAt: null, url: "/uploads/presentations/ev1/sp1/p1.pdf" };
  const input = { ...scope, presentationId: "p1", actor: speakerActor };

  beforeEach(() => {
    mockDb.speakerPresentation.findFirst.mockResolvedValue(uploading);
    storage.headStoredFile.mockResolvedValue({ size: 4321, versionId: "v-checked", etag: '"abc"' });
    storage.readStoredFileStart.mockResolvedValue(PDF_START);
    mockDb.speakerPresentation.findUniqueOrThrow.mockResolvedValue({ ...uploading, status: "READY", size: BigInt(4321), readyAt: new Date() });
  });

  it("checks the object that landed and records the version it checked", async () => {
    const res = await completePresentationUpload(input);
    expect(res).toMatchObject({ ok: true, presentation: { id: "p1", status: "READY", size: 4321, slotKey: "topic:t1" } });
    // The signature is read from the version just measured.
    expect(storage.readStoredFileStart).toHaveBeenCalledWith(uploading.url, "/uploads/presentations/", 16, "v-checked");
    expect(mockDb.speakerPresentation.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: expect.objectContaining({ status: "READY", size: BigInt(4321), s3VersionId: "v-checked", etag: '"abc"' }),
    });
  });

  it("replaces the file the talk already had: one file per talk", async () => {
    mockDb.speakerPresentation.findMany.mockResolvedValue([{ id: "p0", url: "/uploads/presentations/ev1/sp1/p0.pdf" }]);
    await completePresentationUpload(input);
    expect(mockDb.speakerPresentation.findMany.mock.calls[0][0].where).toMatchObject({ speakerId: "sp1", sessionId: "s1", topicId: "t1", status: "READY", id: { not: "p1" } });
    expect(mockDb.speakerPresentation.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["p0"] } }, data: { status: "REPLACED" } });
    expect(storage.deleteStoredFile).toHaveBeenCalledWith("/uploads/presentations/ev1/sp1/p0.pdf", "/uploads/presentations/");
  });

  it("fails a file that is not what its name says, and removes it", async () => {
    storage.readStoredFileStart.mockResolvedValue(Buffer.from("MZ this is a program"));
    const res = await completePresentationUpload(input);
    expect(res).toMatchObject({ ok: false, code: "SIGNATURE_MISMATCH" });
    expect(mockDb.speakerPresentation.updateMany).toHaveBeenCalledWith({ where: { id: "p1", status: "UPLOADING" }, data: { status: "FAILED" } });
    expect(storage.deleteStoredFile).toHaveBeenCalledWith(uploading.url, "/uploads/presentations/");
    expect(mockDb.speakerPresentation.update).not.toHaveBeenCalled();
  });

  it("leaves the upload open when the file has not arrived, so it can be tried again", async () => {
    storage.headStoredFile.mockResolvedValue(null);
    expect(await completePresentationUpload(input)).toMatchObject({ ok: false, code: "UPLOAD_NOT_FOUND" });
    expect(mockDb.speakerPresentation.updateMany).not.toHaveBeenCalled();
  });

  it("answers a repeated call as the first, and nothing for someone else's upload", async () => {
    mockDb.speakerPresentation.findFirst.mockResolvedValue({ ...uploading, status: "READY" });
    expect((await completePresentationUpload(input)).ok).toBe(true);
    expect(storage.headStoredFile).not.toHaveBeenCalled();
    mockDb.speakerPresentation.findFirst.mockResolvedValue(null);
    expect(await completePresentationUpload(input)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(mockDb.speakerPresentation.findFirst.mock.calls[0][0].where).toEqual({ id: "p1", eventId: "ev1", speakerId: "sp1" });
  });
});

describe("downloading", () => {
  it("signs a short link for the version that was checked, under the uploaded name", async () => {
    mockDb.speakerPresentation.findFirst.mockResolvedValue({ url: "/uploads/presentations/ev1/sp1/p1.pdf", filename: "SGLT2 deck.pdf", mimeType: "application/pdf", s3VersionId: "v-checked" });
    storage.signStoredFileDownload.mockResolvedValue("https://signed.example/x");
    expect(await presentationDownload({ ...scope, presentationId: "p1" })).toEqual({ ok: true, redirectUrl: "https://signed.example/x" });
    expect(storage.signStoredFileDownload.mock.calls[0][0]).toMatchObject({ versionId: "v-checked", expiresSeconds: 300, contentType: "application/pdf" });
    expect(storage.signStoredFileDownload.mock.calls[0][0].contentDisposition).toMatch(/^attachment; filename="SGLT2 deck.pdf"/);
    // Only a READY file of this speaker on this event.
    expect(mockDb.speakerPresentation.findFirst.mock.calls[0][0].where).toEqual({ id: "p1", eventId: "ev1", speakerId: "sp1", status: "READY" });
  });
});

describe("the app never carries the file on S3", () => {
  it("answers NOT_AVAILABLE to the file route unless the provider is local", async () => {
    expect(await receiveLocalPresentationFile({ ...scope, presentationId: "p1", bytes: Buffer.from("x") })).toMatchObject({ ok: false, code: "NOT_AVAILABLE" });
    expect(mockDb.speakerPresentation.findFirst).not.toHaveBeenCalled();
    storage.provider = "local";
    mockDb.speakerPresentation.findFirst.mockResolvedValue({ id: "p1", url: "/uploads/presentations/ev1/sp1/p1.pdf", filename: "Deck.pdf", mimeType: "application/pdf" });
    expect(await receiveLocalPresentationFile({ ...scope, presentationId: "p1", bytes: Buffer.from("x") })).toEqual({ ok: true });
    expect(storage.uploadFile).toHaveBeenCalledWith(expect.any(Buffer), "p1.pdf", "application/pdf", "presentations/ev1/sp1");
  });
});
