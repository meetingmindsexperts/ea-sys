/**
 * Storage primitives (Phase 1 consolidation, Aug 2026).
 *
 * These tests exercise the REAL filesystem under `public/uploads/` rather than
 * mocking `fs`, because the thing under test is path resolution: prefix
 * containment, `..` rejection, and symlink escape. Mocking `fs/promises` would
 * mock away precisely the behaviour that matters and leave a suite that cannot
 * fail against the bug it exists to catch.
 *
 * See docs/UAE_DOCUMENT_RESIDENCY_PLAN.md.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdir, writeFile, rm, symlink, readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  uploadFile,
  readStoredFile,
  deleteStoredFile,
  uploadPhoto,
  StorageError,
} from "@/lib/storage";

const TEST_SEGMENT = "__storage_test__";
const TEST_PREFIX = `/uploads/${TEST_SEGMENT}/`;
const testRoot = path.resolve(process.cwd(), "public", "uploads", TEST_SEGMENT);
const outsideRoot = path.resolve(process.cwd(), "public", "uploads", "__storage_test_outside__");

async function expectStorageError(
  fn: () => Promise<unknown>,
  reason: StorageError["reason"],
) {
  await expect(fn()).rejects.toThrow(StorageError);
  await fn().catch((err: unknown) => {
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).reason).toBe(reason);
  });
}

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
  await rm(path.resolve(process.cwd(), "public", "uploads", `${TEST_SEGMENT}-sibling`), {
    recursive: true,
    force: true,
  });
});

describe("uploadFile", () => {
  it("writes to the exact subdirectory given and returns the stored path", async () => {
    const stored = await uploadFile(
      Buffer.from("hello"),
      "written.txt",
      "text/plain",
      `${TEST_SEGMENT}/nested/deep`,
    );

    expect(stored).toBe(`/uploads/${TEST_SEGMENT}/nested/deep/written.txt`);
    const onDisk = await readFile(path.join(testRoot, "nested", "deep", "written.txt"), "utf8");
    expect(onDisk).toBe("hello");
  });

  it("does NOT insert a YYYY/MM partition of its own", async () => {
    // The date partition used to be baked into the write primitive, which meant
    // every caller got it whether or not it wanted one. Document routes key by
    // event id instead, so partitioning is now the caller's explicit choice.
    const stored = await uploadFile(
      Buffer.from("x"),
      "flat.txt",
      "text/plain",
      `${TEST_SEGMENT}/by-event/evt_123`,
    );
    expect(stored).toBe(`/uploads/${TEST_SEGMENT}/by-event/evt_123/flat.txt`);
    expect(stored).not.toMatch(/\/\d{4}\/\d{2}\//);
  });

  it("creates missing directories", async () => {
    const stored = await uploadFile(
      Buffer.from("y"),
      "made.txt",
      "text/plain",
      `${TEST_SEGMENT}/a/b/c/d`,
    );
    expect(existsSync(path.join(testRoot, "a", "b", "c", "d", "made.txt"))).toBe(true);
    expect(stored).toContain("/a/b/c/d/made.txt");
  });
});

describe("readStoredFile", () => {
  it("reads back what uploadFile wrote", async () => {
    const stored = await uploadFile(
      Buffer.from("round trip"),
      "rt.txt",
      "text/plain",
      TEST_SEGMENT,
    );
    const buf = await readStoredFile(stored, TEST_PREFIX);
    expect(buf.toString("utf8")).toBe("round trip");
  });

  it("rejects a stored path outside the required prefix", async () => {
    await uploadFile(Buffer.from("nope"), "other.txt", "text/plain", "__storage_test_outside__");
    await expectStorageError(
      () => readStoredFile("/uploads/__storage_test_outside__/other.txt", TEST_PREFIX),
      "prefix-rejected",
    );
  });

  it("rejects a SIBLING directory that shares a string prefix", async () => {
    // The case a naive startsWith without a trailing slash would let through:
    // "/uploads/__storage_test__-sibling/" begins with "/uploads/__storage_test__".
    // Both the string check and the resolved-path check must refuse it.
    const siblingDir = path.resolve(process.cwd(), "public", "uploads", `${TEST_SEGMENT}-sibling`);
    await mkdir(siblingDir, { recursive: true });
    await writeFile(path.join(siblingDir, "leak.txt"), "leaked");

    await expectStorageError(
      () => readStoredFile(`/uploads/${TEST_SEGMENT}-sibling/leak.txt`, TEST_PREFIX),
      "prefix-rejected",
    );
  });

  it("rejects `..` traversal", async () => {
    await expectStorageError(
      () => readStoredFile(`/uploads/${TEST_SEGMENT}/../../../etc/passwd`, TEST_PREFIX),
      "traversal-blocked",
    );
  });

  it("rejects a null byte", async () => {
    await expectStorageError(
      () => readStoredFile(`/uploads/${TEST_SEGMENT}/evil\0.txt`, TEST_PREFIX),
      "traversal-blocked",
    );
  });

  it("rejects a symlink pointing outside the prefix", async () => {
    const target = path.join(outsideRoot, "secret.txt");
    await writeFile(target, "secret");
    const link = path.join(testRoot, "escape.txt");
    await rm(link, { force: true });
    await symlink(target, link);

    // The string checks pass here: the path really is under the prefix. Only
    // realpath resolution catches it, which is why the guard cannot be a
    // startsWith on the unresolved path.
    await expectStorageError(
      () => readStoredFile(`/uploads/${TEST_SEGMENT}/escape.txt`, TEST_PREFIX),
      "traversal-blocked",
    );
  });

  it("reports a missing file as not-found, distinctly from a rejection", async () => {
    await expectStorageError(
      () => readStoredFile(`/uploads/${TEST_SEGMENT}/does-not-exist.txt`, TEST_PREFIX),
      "not-found",
    );
  });

  it("refuses a requirePrefix that does not start with /uploads/", async () => {
    await expectStorageError(
      () => readStoredFile("/etc/passwd", "/etc/"),
      "prefix-rejected",
    );
  });

  it("refuses a requirePrefix with no trailing slash", async () => {
    // Without the trailing slash the sibling-directory case above becomes
    // reachable, so a malformed prefix is refused rather than tolerated.
    await expectStorageError(
      () => readStoredFile(`/uploads/${TEST_SEGMENT}/rt.txt`, `/uploads/${TEST_SEGMENT}`),
      "prefix-rejected",
    );
  });
});

describe("deleteStoredFile", () => {
  it("removes a file inside the prefix", async () => {
    const stored = await uploadFile(Buffer.from("d"), "gone.txt", "text/plain", TEST_SEGMENT);
    await deleteStoredFile(stored, TEST_PREFIX);
    expect(existsSync(path.join(testRoot, "gone.txt"))).toBe(false);
  });

  it("never throws when the file is already gone", async () => {
    await expect(
      deleteStoredFile(`/uploads/${TEST_SEGMENT}/never-existed.txt`, TEST_PREFIX),
    ).resolves.toBeUndefined();
  });

  it("never throws AND does not delete when the path is outside the prefix", async () => {
    // The guard has to actually protect, not merely swallow the error. A test
    // that only asserted "does not throw" would pass against an unguarded
    // unlink that happily deleted the file.
    const victim = path.join(outsideRoot, "victim.txt");
    await writeFile(victim, "still here");

    await expect(
      deleteStoredFile("/uploads/__storage_test_outside__/victim.txt", TEST_PREFIX),
    ).resolves.toBeUndefined();

    expect(existsSync(victim)).toBe(true);
    expect(await readFile(victim, "utf8")).toBe("still here");
  });
});

describe("existing path shapes are preserved", () => {
  it("uploadPhoto still writes under /uploads/photos/YYYY/MM/", async () => {
    // Regression guard for the datePartition move: the partition left the write
    // primitive and became the wrapper's job, and the stored path shape must be
    // byte-identical or every URL already in the database stops resolving.
    const stored = await uploadPhoto(Buffer.from("p"), "pic.jpg", "image/jpeg");
    expect(stored).toMatch(/^\/uploads\/photos\/\d{4}\/\d{2}\/pic\.jpg$/);

    const abs = path.resolve(process.cwd(), "public", stored.slice(1));
    await rm(abs, { force: true });
  });
});
