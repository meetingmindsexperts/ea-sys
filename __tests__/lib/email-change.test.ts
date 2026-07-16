/**
 * Unit tests for src/lib/email-change.ts — shared helpers for the
 * dedicated email-change flows on Speaker / Registration / Contact.
 *
 * July 16, 2026 (contacts review round 2, H-A/M-B/M-C): the collision branch
 * is a real MERGE now — blank survivor scalars filled from the losing row,
 * tags/eventIds unioned, notes appended with provenance, CrmContact pointers
 * re-pointed BEFORE the delete (the FK is SetNull — a bare delete silently
 * severed the CRM link), and lookups tolerate legacy mixed-case rows.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { normalizeEmail, repointOrgContactEmail } from "@/lib/email-change";

vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

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

/** A full-shaped Contact row for the merge branch (which reads real fields). */
function contactRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "c-x",
    organizationId: "org-1",
    email: "x@example.com",
    firstName: "First",
    lastName: "Last",
    title: null,
    role: null,
    additionalEmail: null,
    organization: null,
    jobTitle: null,
    bio: null,
    specialty: null,
    customSpecialty: null,
    registrationType: null,
    phone: null,
    photo: null,
    city: null,
    state: null,
    zipCode: null,
    country: null,
    associationName: null,
    memberId: null,
    studentId: null,
    studentIdExpiry: null,
    tags: [] as string[],
    eventIds: [] as string[],
    notes: null as string | null,
    ...overrides,
  };
}

describe("repointOrgContactEmail", () => {
  const makeTx = () => ({
    contact: {
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    crmContact: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  });
  type Tx = Parameters<typeof repointOrgContactEmail>[0];

  beforeEach(() => vi.clearAllMocks());

  const run = (tx: ReturnType<typeof makeTx>, oldEmail = "old@example.com", newEmail = "new@example.com") =>
    repointOrgContactEmail(tx as unknown as Tx, { organizationId: "org-1", oldEmail, newEmail });

  it("returns 'none' when no contact exists at the old email (exact AND case-insensitive miss)", async () => {
    const tx = makeTx();
    tx.contact.findFirst.mockResolvedValue(null);

    expect(await run(tx)).toBe("none");
    // Exact lookup + case-insensitive fallback both ran.
    expect(tx.contact.findFirst).toHaveBeenCalledTimes(2);
    expect(tx.contact.findFirst).toHaveBeenNthCalledWith(2, {
      where: { organizationId: "org-1", email: { equals: "old@example.com", mode: "insensitive" } },
    });
    expect(tx.contact.update).not.toHaveBeenCalled();
    expect(tx.contact.delete).not.toHaveBeenCalled();
  });

  it("returns 'updated' when old exists and no collision at new", async () => {
    const tx = makeTx();
    tx.contact.findFirst
      .mockResolvedValueOnce(contactRow({ id: "c-old", email: "old@example.com" })) // exact old
      .mockResolvedValueOnce(null) // exact collision miss
      .mockResolvedValueOnce(null); // insensitive collision miss

    expect(await run(tx)).toBe("updated");
    expect(tx.contact.update).toHaveBeenCalledWith({
      where: { id: "c-old" },
      data: { email: "new@example.com" },
    });
    expect(tx.contact.delete).not.toHaveBeenCalled();
  });

  it("M-C: finds a legacy mixed-case row via the case-insensitive fallback instead of no-opping", async () => {
    const tx = makeTx();
    tx.contact.findFirst
      .mockResolvedValueOnce(null) // exact old miss (stored as Old@Example.com)
      .mockResolvedValueOnce(contactRow({ id: "c-legacy", email: "Old@Example.com" })) // insensitive hit
      .mockResolvedValueOnce(null) // exact collision miss
      .mockResolvedValueOnce(null); // insensitive collision miss

    expect(await run(tx)).toBe("updated");
    expect(tx.contact.update).toHaveBeenCalledWith({
      where: { id: "c-legacy" },
      data: { email: "new@example.com" },
    });
  });

  it("H-A: merge unions tags + eventIds, fills blank scalars, appends notes with provenance, then deletes", async () => {
    const tx = makeTx();
    const old = contactRow({
      id: "c-old",
      email: "old@example.com",
      tags: ["committee", "vip"],
      eventIds: ["evt-1", "evt-2"],
      notes: "Prefers morning sessions.",
      phone: "+971-50-1234567",
      city: "Dubai",
    });
    const survivor = contactRow({
      id: "c-new",
      email: "new@example.com",
      tags: ["vip", "faculty"],
      eventIds: ["evt-2", "evt-3"],
      notes: "Met at IOHNC.",
      city: "Abu Dhabi", // survivor value wins — never overwritten
    });
    tx.contact.findFirst
      .mockResolvedValueOnce(old) // exact old
      .mockResolvedValueOnce(survivor); // exact collision

    expect(await run(tx)).toBe("merged");

    expect(tx.contact.update).toHaveBeenCalledWith({
      where: { id: "c-new" },
      data: {
        phone: "+971-50-1234567", // blank on survivor → filled
        tags: ["vip", "faculty", "committee"], // survivor order first, unioned
        eventIds: ["evt-2", "evt-3", "evt-1"],
        notes:
          "Met at IOHNC.\n\n— Merged from a duplicate contact (old@example.com) —\nPrefers morning sessions.",
      },
    });
    // city NOT in the update payload — survivor's Abu Dhabi wins.
    const updateData = tx.contact.update.mock.calls[0][0].data;
    expect("city" in updateData).toBe(false);

    // M-B: CRM links re-pointed BEFORE the delete.
    expect(tx.crmContact.updateMany).toHaveBeenCalledWith({
      where: { contactId: "c-old" },
      data: { contactId: "c-new" },
    });
    const repointOrder = tx.crmContact.updateMany.mock.invocationCallOrder[0];
    const deleteOrder = tx.contact.delete.mock.invocationCallOrder[0];
    expect(repointOrder).toBeLessThan(deleteOrder);

    expect(tx.contact.delete).toHaveBeenCalledWith({ where: { id: "c-old" } });
  });

  it("merge with nothing to fill skips the survivor update but still re-points CRM links + deletes", async () => {
    const tx = makeTx();
    const old = contactRow({ id: "c-old", email: "old@example.com" }); // all blank
    const survivor = contactRow({ id: "c-new", email: "new@example.com" });
    tx.contact.findFirst.mockResolvedValueOnce(old).mockResolvedValueOnce(survivor);

    expect(await run(tx)).toBe("merged");
    expect(tx.contact.update).not.toHaveBeenCalled();
    expect(tx.crmContact.updateMany).toHaveBeenCalled();
    expect(tx.contact.delete).toHaveBeenCalledWith({ where: { id: "c-old" } });
  });

  it("merge takes the old row's notes verbatim when the survivor has none", async () => {
    const tx = makeTx();
    const old = contactRow({ id: "c-old", email: "old@example.com", notes: "Only note." });
    const survivor = contactRow({ id: "c-new", email: "new@example.com", notes: null });
    tx.contact.findFirst.mockResolvedValueOnce(old).mockResolvedValueOnce(survivor);

    await run(tx);
    expect(tx.contact.update).toHaveBeenCalledWith({
      where: { id: "c-new" },
      data: { notes: "Only note." },
    });
  });

  it("canonicalizes in place (updated, no delete) when old and collision resolve to the SAME legacy row", async () => {
    // e.g. the row is stored as `New@Example.com`; oldEmail misses everywhere
    // except... the degenerate guard: both lookups land on one row.
    const tx = makeTx();
    const same = contactRow({ id: "c-same", email: "New@Example.com" });
    tx.contact.findFirst
      .mockResolvedValueOnce(same) // old lookup resolves to the row
      .mockResolvedValueOnce(null) // exact collision miss
      .mockResolvedValueOnce(same); // insensitive collision → same row

    expect(await run(tx)).toBe("updated");
    expect(tx.contact.delete).not.toHaveBeenCalled();
    expect(tx.contact.update).toHaveBeenCalledWith({
      where: { id: "c-same" },
      data: { email: "new@example.com" },
    });
  });
});
