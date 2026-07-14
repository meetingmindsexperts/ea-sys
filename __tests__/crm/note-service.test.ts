/**
 * Note service — the manual activity log.
 *
 * The load-bearing rule here is AUTHORSHIP: a note is a first-person account of a
 * conversation ("I spoke to Dr Khan; he wants Gold"). Letting a colleague silently
 * rewrite it would put words in someone's mouth, in a record with no visible edit
 * history. So editing is author-only — admins get delete, not rewrite.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: {
    crmNote: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    crmDeal: { findFirst: vi.fn() },
    crmCompany: { findFirst: vi.fn() },
    contact: { findFirst: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

import { db } from "@/lib/db";
import { createNote, updateNote, deleteNote } from "@/crm/services/note-service";

const ORG = "org-1";
const AUTHOR = "u-author";
const base = { organizationId: ORG, userId: AUTHOR, source: "rest" as const };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({} as never);
});

describe("createNote", () => {
  it("creates a note attached to a deal", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ id: "d-1" } as never);
    vi.mocked(db.crmNote.create).mockResolvedValue({
      id: "n-1", activityType: "CALL", dealId: "d-1", companyId: null, contactId: null,
    } as never);

    const res = await createNote({ ...base, body: "Called Dr Khan — wants Gold", activityType: "CALL", dealId: "d-1" });

    expect(res.ok).toBe(true);
    expect(db.crmNote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ body: "Called Dr Khan — wants Gold", activityType: "CALL", authorId: AUTHOR }),
      }),
    );
  });

  it("REJECTS a note attached to nothing — it would render nowhere and be lost", async () => {
    const res = await createNote({ ...base, body: "a thought" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("NO_ATTACHMENT");
    expect(db.crmNote.create).not.toHaveBeenCalled();
  });

  it("rejects an empty body", async () => {
    const res = await createNote({ ...base, body: "   ", dealId: "d-1" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("BODY_REQUIRED");
  });

  it("refuses to attach to another org's deal (IDOR)", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue(null as never); // bound to org, not found

    const res = await createNote({ ...base, body: "note", dealId: "other-orgs-deal" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("DEAL_NOT_FOUND");
    expect(db.crmNote.create).not.toHaveBeenCalled();
  });
});

describe("updateNote — author-only", () => {
  it("lets the author edit their own note", async () => {
    vi.mocked(db.crmNote.findFirst).mockResolvedValue({ id: "n-1", authorId: AUTHOR } as never);
    vi.mocked(db.crmNote.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmNote.findUniqueOrThrow).mockResolvedValue({ id: "n-1" } as never);

    const res = await updateNote({ ...base, noteId: "n-1", isAdmin: false, body: "corrected" });

    expect(res.ok).toBe(true);
  });

  it("REFUSES a colleague — even an ADMIN — rewriting someone else's note", async () => {
    // An admin is not the author of your phone call. Rewriting a first-person
    // account, in a record with no visible edit history, misattributes words to a
    // person who never said them. Admins get delete, not rewrite.
    vi.mocked(db.crmNote.findFirst).mockResolvedValue({ id: "n-1", authorId: AUTHOR } as never);

    const res = await updateNote({
      ...base,
      userId: "u-someone-else",
      isAdmin: true, // ← even so
      noteId: "n-1",
      body: "words the author never wrote",
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("NOT_AUTHOR");
    expect(db.crmNote.updateMany).not.toHaveBeenCalled();
  });

  it("404s a note from another org rather than confirming it exists", async () => {
    vi.mocked(db.crmNote.findFirst).mockResolvedValue(null as never);

    const res = await updateNote({ ...base, noteId: "n-elsewhere", isAdmin: false, body: "x" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("NOTE_NOT_FOUND");
  });
});

describe("deleteNote", () => {
  it("lets the author delete their own note", async () => {
    vi.mocked(db.crmNote.findFirst).mockResolvedValue({ id: "n-1", authorId: AUTHOR, activityType: "NOTE" } as never);
    vi.mocked(db.crmNote.delete).mockResolvedValue({} as never);

    const res = await deleteNote({ ...base, noteId: "n-1", isAdmin: false });

    expect(res.ok).toBe(true);
    // The row is gone, so the audit entry is the ONLY surviving record it existed.
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "DELETE", entityType: "CrmNote" }),
      }),
    );
  });

  it("lets an ADMIN delete someone else's note (delete, unlike rewrite, is legitimate)", async () => {
    vi.mocked(db.crmNote.findFirst).mockResolvedValue({ id: "n-1", authorId: AUTHOR, activityType: "NOTE" } as never);
    vi.mocked(db.crmNote.delete).mockResolvedValue({} as never);

    const res = await deleteNote({ ...base, userId: "u-admin", isAdmin: true, noteId: "n-1" });

    expect(res.ok).toBe(true);
    const audited = vi.mocked(db.auditLog.create).mock.calls[0]![0]!.data as Record<string, unknown>;
    // Record that it was an admin removal, not the author tidying up after themselves.
    expect((audited.changes as Record<string, unknown>).deletedByAdmin).toBe(true);
  });

  it("refuses a non-author, non-admin", async () => {
    vi.mocked(db.crmNote.findFirst).mockResolvedValue({ id: "n-1", authorId: AUTHOR, activityType: "NOTE" } as never);

    const res = await deleteNote({ ...base, userId: "u-organizer", isAdmin: false, noteId: "n-1" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("NOT_AUTHOR");
    expect(db.crmNote.delete).not.toHaveBeenCalled();
  });
});
