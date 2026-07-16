/**
 * CRM contact service + the population-separation guarantee.
 *
 * The load-bearing fact this file pins: a business contact (a pharma rep) is NOT a
 * `Contact` (an HCP). They live in different tables, and only `Contact` is mirrored
 * to the external HCP marketing list. If someone ever "simplifies" CrmContact back
 * into Contact, or writes a rep into the Contact table, these tests are the alarm.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => ({
  db: {
    crmContact: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    crmCompany: { findFirst: vi.fn() },
    contact: { findFirst: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    crmActivity: { create: vi.fn().mockResolvedValue({}) },
  },
}));

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  findOrCreateCrmContact,
  updateCrmContact,
  linkToEventContact,
  contactEmailKey,
} from "@/crm/services/crm-contact-service";

const ORG = "org-1";
const base = { organizationId: ORG, userId: "u-1", source: "rest" as const };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(db.crmCompany.findFirst).mockResolvedValue({ id: "c-1" } as never);
  // updateCrmContact now snapshots the row before writing (for the change log's
  // before→after diff), so give the pre-update read a default row.
  vi.mocked(db.crmContact.findFirst).mockResolvedValue({
    id: "cc-1", firstName: "Sara", lastName: "Khan", email: "old@abbott.com",
    jobTitle: null, phone: null, country: null, notes: null, lifecycleStage: null, companyId: null,
  } as never);
});

describe("population separation — a CRM contact NEVER touches the Contact table on create", () => {
  it("writes to crmContact, and does not read or write the event Contact store", async () => {
    vi.mocked(db.crmContact.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.crmContact.create).mockResolvedValue({ id: "cc-1", email: "s.khan@abbott.com" } as never);

    await findOrCreateCrmContact({
      ...base,
      firstName: "Sarah",
      lastName: "Khan",
      email: "s.khan@abbott.com",
      companyId: "c-1",
    });

    expect(db.crmContact.create).toHaveBeenCalled();
    // THE guarantee: creating a rep must not go anywhere near Contact — that's the
    // table that feeds the HCP marketing mirror.
    expect(db.contact.findFirst).not.toHaveBeenCalled();
  });
});

describe("contactEmailKey — the dedup key", () => {
  it("normalizes case + surrounding space", () => {
    expect(contactEmailKey("S.Khan@Abbott.com")).toBe("s.khan@abbott.com");
    expect(contactEmailKey("  s.khan@abbott.com ")).toBe("s.khan@abbott.com");
  });
});

describe("findOrCreateCrmContact", () => {
  it("REUSES an existing contact by normalized email", async () => {
    vi.mocked(db.crmContact.findUnique).mockResolvedValue({ id: "cc-1", email: "s.khan@abbott.com" } as never);

    const res = await findOrCreateCrmContact({
      ...base, firstName: "Sarah", lastName: "Khan", email: "S.Khan@Abbott.com",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.created).toBe(false);
    expect(db.crmContact.create).not.toHaveBeenCalled();
    expect(db.crmContact.findUnique).toHaveBeenCalledWith({
      where: { organizationId_emailKey: { organizationId: ORG, emailKey: "s.khan@abbott.com" } },
    });
  });

  it("requires name and email", async () => {
    const noName = await findOrCreateCrmContact({ ...base, firstName: "", lastName: "K", email: "x@y.com" });
    expect(noName.ok).toBe(false);
    if (noName.ok) throw new Error("unreachable");
    expect(noName.code).toBe("NAME_REQUIRED");

    const noEmail = await findOrCreateCrmContact({ ...base, firstName: "A", lastName: "B", email: "  " });
    expect(noEmail.ok).toBe(false);
    if (noEmail.ok) throw new Error("unreachable");
    expect(noEmail.code).toBe("EMAIL_REQUIRED");
  });

  it("rejects a company from another org (IDOR)", async () => {
    vi.mocked(db.crmContact.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.crmCompany.findFirst).mockResolvedValue(null as never);

    const res = await findOrCreateCrmContact({
      ...base, firstName: "A", lastName: "B", email: "a@b.com", companyId: "other-org-company",
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("COMPANY_NOT_FOUND");
    expect(db.crmContact.create).not.toHaveBeenCalled();
  });
});

describe("updateCrmContact — email collision is a 409-class business rejection, not a 500 (H4)", () => {
  it("maps P2002 on the email edit to EMAIL_TAKEN and logs it", async () => {
    vi.mocked(db.crmContact.updateMany).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }) as never,
    );

    const res = await updateCrmContact({ ...base, crmContactId: "cc-1", email: "taken@abbott.com" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    // EMAIL_TAKEN maps to 409 in STATUS_BY_CODE — as UNKNOWN this surfaced as an
    // unlogged HTTP 500 on an ordinary rename.
    expect(res.code).toBe("EMAIL_TAKEN");
    const { apiLogger } = await import("@/lib/logger");
    expect(vi.mocked(apiLogger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "crm-contact:update-email-taken" }),
    );
  });
});

describe("updateCrmContact keeps emailKey in lockstep with email", () => {
  it("re-derives emailKey on an email change", async () => {
    vi.mocked(db.crmContact.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmContact.findUniqueOrThrow).mockResolvedValue({ id: "cc-1" } as never);

    await updateCrmContact({ ...base, crmContactId: "cc-1", email: "NEW.Email@Abbott.com" });

    const data = vi.mocked(db.crmContact.updateMany).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(data.email).toBe("NEW.Email@Abbott.com");
    expect(data.emailKey).toBe("new.email@abbott.com");
  });
});

describe("linkToEventContact — the person who is both", () => {
  it("points the CRM contact at their event Contact row when it exists", async () => {
    vi.mocked(db.contact.findFirst).mockResolvedValue({ id: "evt-1" } as never);
    vi.mocked(db.crmContact.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmContact.findUniqueOrThrow).mockResolvedValue({ id: "cc-1", contactId: "evt-1" } as never);

    const res = await linkToEventContact({ ...base, crmContactId: "cc-1", contactId: "evt-1" });

    expect(res.ok).toBe(true);
    // A pointer, not a copy — updateMany sets contactId, nothing is written into Contact.
    expect(db.crmContact.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { contactId: "evt-1" } }),
    );
  });

  it("refuses to link to an event contact from another org", async () => {
    vi.mocked(db.contact.findFirst).mockResolvedValue(null as never);

    const res = await linkToEventContact({ ...base, crmContactId: "cc-1", contactId: "other-orgs-hcp" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("EVENT_CONTACT_NOT_FOUND");
    expect(db.crmContact.updateMany).not.toHaveBeenCalled();
  });

  it("unlinks with contactId: null without validating anything", async () => {
    vi.mocked(db.crmContact.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmContact.findUniqueOrThrow).mockResolvedValue({ id: "cc-1", contactId: null } as never);

    const res = await linkToEventContact({ ...base, crmContactId: "cc-1", contactId: null });

    expect(res.ok).toBe(true);
    expect(db.contact.findFirst).not.toHaveBeenCalled(); // nothing to validate when unlinking
  });
});
