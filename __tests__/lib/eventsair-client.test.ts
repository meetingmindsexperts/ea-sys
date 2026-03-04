import { describe, it, expect, vi, beforeEach } from "vitest";
import { encryptSecret, decryptSecret } from "@/lib/eventsair-client";

// Mock the logger to avoid file system side effects
vi.mock("@/lib/logger", () => ({
  apiLogger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Credential Encryption ───────────────────────────────────────────

describe("encryptSecret / decryptSecret", () => {
  beforeEach(() => {
    // Set a consistent NEXTAUTH_SECRET for deterministic key derivation
    process.env.NEXTAUTH_SECRET = "test-secret-key-for-encryption";
  });

  it("encrypts and decrypts a secret successfully", () => {
    const plaintext = "my-super-secret-client-secret";
    const encrypted = encryptSecret(plaintext);
    const decrypted = decryptSecret(encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    const plaintext = "same-secret";
    const encrypted1 = encryptSecret(plaintext);
    const encrypted2 = encryptSecret(plaintext);

    // Different IVs should produce different ciphertexts
    expect(encrypted1).not.toBe(encrypted2);

    // Both should decrypt to the same value
    expect(decryptSecret(encrypted1)).toBe(plaintext);
    expect(decryptSecret(encrypted2)).toBe(plaintext);
  });

  it("encrypted format is iv:authTag:ciphertext (3 hex parts)", () => {
    const encrypted = encryptSecret("test");
    const parts = encrypted.split(":");

    expect(parts).toHaveLength(3);
    // IV is 16 bytes = 32 hex chars
    expect(parts[0]).toMatch(/^[0-9a-f]{32}$/);
    // Auth tag is 16 bytes = 32 hex chars
    expect(parts[1]).toMatch(/^[0-9a-f]{32}$/);
    // Ciphertext is hex
    expect(parts[2]).toMatch(/^[0-9a-f]+$/);
  });

  it("handles empty string", () => {
    const encrypted = encryptSecret("");
    expect(decryptSecret(encrypted)).toBe("");
  });

  it("handles special characters", () => {
    const special = '!@#$%^&*()_+-={}[]|\\:";\'<>?,./~`\n\t';
    const encrypted = encryptSecret(special);
    expect(decryptSecret(encrypted)).toBe(special);
  });

  it("handles unicode characters", () => {
    const unicode = "日本語テスト 🎉 événement";
    const encrypted = encryptSecret(unicode);
    expect(decryptSecret(encrypted)).toBe(unicode);
  });

  it("handles long secrets", () => {
    const longSecret = "a".repeat(10000);
    const encrypted = encryptSecret(longSecret);
    expect(decryptSecret(encrypted)).toBe(longSecret);
  });

  it("throws on invalid encrypted format (missing parts)", () => {
    expect(() => decryptSecret("invalid")).toThrow("Invalid encrypted format");
    expect(() => decryptSecret("part1:part2")).toThrow(
      "Invalid encrypted format"
    );
  });

  it("throws on tampered ciphertext", () => {
    const encrypted = encryptSecret("test-value");
    const parts = encrypted.split(":");
    // Tamper with the ciphertext
    parts[2] = "00".repeat(parts[2].length / 2);
    const tampered = parts.join(":");

    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("throws on tampered auth tag", () => {
    const encrypted = encryptSecret("test-value");
    const parts = encrypted.split(":");
    // Tamper with the auth tag
    parts[1] = "00".repeat(16);
    const tampered = parts.join(":");

    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("produces consistent results with the same NEXTAUTH_SECRET", () => {
    const secret = "consistent-test";
    const encrypted = encryptSecret(secret);

    // Same env var, should decrypt fine
    expect(decryptSecret(encrypted)).toBe(secret);
  });

  it("fails decryption when NEXTAUTH_SECRET changes", () => {
    const secret = "will-fail-later";
    const encrypted = encryptSecret(secret);

    // Change the secret
    process.env.NEXTAUTH_SECRET = "different-secret-key";

    expect(() => decryptSecret(encrypted)).toThrow();
  });
});
