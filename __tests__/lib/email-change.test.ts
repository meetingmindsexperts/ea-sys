/**
 * Unit tests for src/lib/email-change.ts — shared helpers for the
 * dedicated email-change flows on Speaker / Registration / Contact.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { normalizeEmail, repointOrgContactEmail } from "@/lib/email-change";

describe("normalizeEmail", () => {
  it("trims and lowercases a valid email", () => {
    expect(normalizeEmail("  Alice@EXAMPLE.com  ")).toBe("alice@example.com");
  });

  it("returns null for invalid email", () => {
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail(123)).toBeNull();
  });

  it("rejects emails over 255 chars", () => {
    const long = "a".repeat(250) + "@x.com";
    expect(normalizeEmail(long)).toBeNull();
  });
});

describe("repointOrgContactEmail", () => {
  const makeTx = () => ({
    contact: {
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  });

  beforeEach(() => vi.clearAllMocks());

  it("returns 'none' when no contact exists at the old email", async () => {
    const tx = makeTx();
    tx.contact.findFirst.mockResolvedValueOnce(null);

    const result = await repointOrgContactEmail(tx as unknown as Parameters<typeof repointOrgContactEmail>[0], {
      organizationId: "org-1",
      oldEmail: "old@example.com",
      newEmail: "new@example.com",
    });

    expect(result).toBe("none");
    expect(tx.contact.update).not.toHaveBeenCalled();
    expect(tx.contact.delete).not.toHaveBeenCalled();
  });

  it("returns 'updated' when old exists and no collision at new", async () => {
    const tx = makeTx();
    tx.contact.findFirst
      .mockResolvedValueOnce({ id: "c-old" }) // find old
      .mockResolvedValueOnce(null); // no collision

    const result = await repointOrgContactEmail(tx as unknown as Parameters<typeof repointOrgContactEmail>[0], {
      organizationId: "org-1",
      oldEmail: "old@example.com",
      newEmail: "new@example.com",
    });

    expect(result).toBe("updated");
    expect(tx.contact.update).toHaveBeenCalledWith({
      where: { id: "c-old" },
      data: { email: "new@example.com" },
    });
    expect(tx.contact.delete).not.toHaveBeenCalled();
  });

  it("returns 'merged' and deletes the old row when a contact at new already exists", async () => {
    const tx = makeTx();
    tx.contact.findFirst
      .mockResolvedValueOnce({ id: "c-old" })
      .mockResolvedValueOnce({ id: "c-new" });

    const result = await repointOrgContactEmail(tx as unknown as Parameters<typeof repointOrgContactEmail>[0], {
      organizationId: "org-1",
      oldEmail: "old@example.com",
      newEmail: "new@example.com",
    });

    expect(result).toBe("merged");
    expect(tx.contact.delete).toHaveBeenCalledWith({ where: { id: "c-old" } });
    expect(tx.contact.update).not.toHaveBeenCalled();
  });
});
