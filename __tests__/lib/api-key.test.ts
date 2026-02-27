import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {},
}));

import { generateApiKey, hashApiKey, keyPrefix } from "@/lib/api-key";

describe("generateApiKey", () => {
  it('starts with "mmg_" prefix', () => {
    expect(generateApiKey()).toMatch(/^mmg_/);
  });

  it("has correct length (4 prefix + 64 hex = 68)", () => {
    expect(generateApiKey()).toHaveLength(68);
  });

  it("generates unique keys", () => {
    const keys = new Set(Array.from({ length: 10 }, () => generateApiKey()));
    expect(keys.size).toBe(10);
  });
});

describe("hashApiKey", () => {
  it("returns a 64-char hex string (SHA-256)", () => {
    const hash = hashApiKey("mmg_test123");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic", () => {
    const key = "mmg_samekey";
    expect(hashApiKey(key)).toBe(hashApiKey(key));
  });

  it("produces different hashes for different keys", () => {
    expect(hashApiKey("mmg_key1")).not.toBe(hashApiKey("mmg_key2"));
  });
});

describe("keyPrefix", () => {
  it("returns first 12 characters", () => {
    const key = generateApiKey();
    expect(keyPrefix(key)).toBe(key.slice(0, 12));
    expect(keyPrefix(key)).toHaveLength(12);
  });

  it("starts with mmg_ for a generated key", () => {
    const key = generateApiKey();
    expect(keyPrefix(key)).toMatch(/^mmg_/);
  });
});
