/**
 * Streamed writes and batch deletes on the local provider (Nov 25, 2026), on
 * the real filesystem under public/uploads/, as storage.test.ts does: the
 * thing under test is where the bytes land and the prefix guard.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import { readFile, rm } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { deleteStoredFiles, StorageError, writeStoredFileStream } from "@/lib/storage";

const SEGMENT = "__storage_stream_test__";
const PREFIX = `/uploads/${SEGMENT}/`;
const root = path.resolve(process.cwd(), "public", "uploads", SEGMENT);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function* parts(...texts: string[]) {
  for (const t of texts) yield Buffer.from(t);
}

describe("writeStoredFileStream (local)", () => {
  it("writes the stream to the stored path, making its folders, and answers the size", async () => {
    const out = await writeStoredFileStream(parts("ab", "cde"), `${PREFIX}r1/recording.mp4`, PREFIX, "video/mp4");
    expect(out).toEqual({ bytes: 5 });
    expect((await readFile(path.join(root, "r1/recording.mp4"))).toString()).toBe("abcde");
  });

  it("refuses a path outside its prefix before writing anything", async () => {
    await expect(writeStoredFileStream(parts("x"), "/uploads/elsewhere/x.mp4", PREFIX, "video/mp4")).rejects.toBeInstanceOf(StorageError);
    await expect(writeStoredFileStream(parts("x"), `${PREFIX}../x.mp4`, PREFIX, "video/mp4")).rejects.toBeInstanceOf(StorageError);
  });
});

describe("deleteStoredFiles (local)", () => {
  it("deletes every file given and never throws, counting what is left", async () => {
    await writeStoredFileStream(parts("1"), `${PREFIX}r2/1.ts`, PREFIX, "video/mp2t");
    await writeStoredFileStream(parts("2"), `${PREFIX}r2/2.ts`, PREFIX, "video/mp2t");
    expect(await deleteStoredFiles([`${PREFIX}r2/1.ts`, `${PREFIX}r2/2.ts`, `${PREFIX}r2/never.ts`], PREFIX)).toEqual({ failed: 0 });
    expect(existsSync(path.join(root, "r2/1.ts"))).toBe(false);
  });

  it("a path outside the prefix fails the batch without deleting, and does not throw", async () => {
    await writeStoredFileStream(parts("3"), `${PREFIX}r3/3.ts`, PREFIX, "video/mp2t");
    expect(await deleteStoredFiles([`${PREFIX}r3/3.ts`, "/uploads/photos/x.jpg"], PREFIX)).toEqual({ failed: 2 });
    expect(existsSync(path.join(root, "r3/3.ts"))).toBe(true);
  });

  it("nothing given, nothing done", async () => {
    expect(await deleteStoredFiles([], PREFIX)).toEqual({ failed: 0 });
  });
});
