/**
 * CRM note service — the manual activity log.
 *
 * This is the "we actually phoned them on Tuesday" record: the one thing no
 * automated sync can produce. Everything else in EA-SYS's activity timeline is
 * derived (emails sent, fields changed); a note is a human saying what happened.
 *
 * Design notes:
 *
 * - A note is ATTACHED to at least one of {deal, company, contact}. A note
 *   attached to nothing is not a note, it's a diary entry — we reject it, because
 *   an unattached note is invisible in every surface that renders notes and would
 *   simply be lost.
 *
 * - Notes are EDITABLE ONLY BY THEIR AUTHOR, but readable by all CRM staff. A
 *   note is a first-person account ("I spoke to Dr Khan; he wants the Gold tier"),
 *   and letting a colleague silently rewrite your account of a call is both wrong
 *   and an audit hazard. Admins can delete, not rewrite.
 *
 * - `authorId` is SetNull at the DB level, so a note survives its author's account
 *   being deleted. The body is history; a note that vanishes when a temp account is
 *   cleaned up is worse than one attributed to "(deleted user)".
 */
import { Prisma, type CrmNote, type CrmActivityType } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

export interface CreateNoteInput {
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "api";
  requestIp?: string;

  body: string;
  activityType?: CrmActivityType;
  dealId?: string | null;
  companyId?: string | null;
  crmContactId?: string | null;
}

export interface UpdateNoteInput {
  noteId: string;
  organizationId: string;
  userId: string | null;
  /** Admins may delete any note; only the author may edit one. */
  isAdmin: boolean;
  source: "rest" | "mcp" | "api";

  body?: string;
  activityType?: CrmActivityType;
}

export type NoteErrorCode =
  | "BODY_REQUIRED"
  | "NO_ATTACHMENT"
  | "NOTE_NOT_FOUND"
  | "NOT_AUTHOR"
  | "DEAL_NOT_FOUND"
  | "DEAL_ARCHIVED"
  | "COMPANY_NOT_FOUND"
  | "COMPANY_ARCHIVED"
  | "CONTACT_NOT_FOUND"
  | "CONTACT_ARCHIVED"
  | "NO_FIELDS"
  | "UNKNOWN";

type Fail = { ok: false; code: NoteErrorCode; message: string; meta?: Record<string, unknown> };
export type NoteResult = { ok: true; note: CrmNote } | Fail;

/** Every attachment id is bound to the caller's org before it is written. */
async function validateAttachments(
  organizationId: string,
  rel: { dealId?: string | null; companyId?: string | null; crmContactId?: string | null },
): Promise<Fail | null> {
  const checks: Array<Promise<Fail | null>> = [];

  if (rel.dealId) {
    checks.push(
      db.crmDeal
        .findFirst({ where: { id: rel.dealId, organizationId }, select: { id: true, archivedAt: true } })
        .then((r) =>
          !r
            ? ({ ok: false, code: "DEAL_NOT_FOUND", message: "Deal not found" } as Fail)
            : r.archivedAt
              // R2-M1: an archived record is frozen — notes included.
              ? ({ ok: false, code: "DEAL_ARCHIVED", message: "That deal was archived — restore it before adding notes" } as Fail)
              : null,
        ),
    );
  }
  if (rel.companyId) {
    checks.push(
      db.crmCompany
        .findFirst({ where: { id: rel.companyId, organizationId }, select: { id: true, archivedAt: true } })
        .then((r) =>
          !r
            ? ({ ok: false, code: "COMPANY_NOT_FOUND", message: "Company not found" } as Fail)
            : r.archivedAt
              // R2-M1: an archived record is frozen — notes included.
              ? ({ ok: false, code: "COMPANY_ARCHIVED", message: "That company was archived — restore it before adding notes" } as Fail)
              : null,
        ),
    );
  }
  if (rel.crmContactId) {
    checks.push(
      db.crmContact
        .findFirst({ where: { id: rel.crmContactId, organizationId }, select: { id: true, archivedAt: true } })
        .then((r) =>
          !r
            ? ({ ok: false, code: "CONTACT_NOT_FOUND", message: "Contact not found" } as Fail)
            : r.archivedAt
              // R2-M1: an archived record is frozen — notes included.
              ? ({ ok: false, code: "CONTACT_ARCHIVED", message: "That contact was archived — restore it before adding notes" } as Fail)
              : null,
        ),
    );
  }

  const results = await Promise.all(checks);
  return results.find((r) => r !== null) ?? null;
}

export async function createNote(input: CreateNoteInput): Promise<NoteResult> {
  const body = input.body?.trim() ?? "";
  if (!body) return { ok: false, code: "BODY_REQUIRED", message: "The note is empty" };

  // A note attached to nothing renders nowhere — it would be silently lost.
  if (!input.dealId && !input.companyId && !input.crmContactId) {
    apiLogger.warn({ msg: "crm-note:no-attachment", organizationId: input.organizationId });
    return {
      ok: false,
      code: "NO_ATTACHMENT",
      message: "Attach the note to a deal, a company or a contact",
    };
  }

  const relFail = await validateAttachments(input.organizationId, input);
  if (relFail) {
    apiLogger.warn({ msg: "crm-note:create-bad-attachment", code: relFail.code, organizationId: input.organizationId });
    return relFail;
  }

  try {
    const note = await db.crmNote.create({
      data: {
        organizationId: input.organizationId,
        body,
        activityType: input.activityType ?? "NOTE",
        authorId: input.userId,
        dealId: input.dealId ?? null,
        companyId: input.companyId ?? null,
        crmContactId: input.crmContactId ?? null,
      },
    });

    void writeAudit({
      userId: input.userId,
      action: "CREATE",
      entityId: note.id,
      ipAddress: input.requestIp,
      changes: {
        source: input.source,
        activityType: note.activityType,
        dealId: note.dealId,
        companyId: note.companyId,
        crmContactId: note.crmContactId,
        // The note BODY is deliberately not copied into the audit blob: it can be
        // long, and it is already durably stored on the row itself. Audit records
        // that an entry was made, not a second copy of it.
      },
    });

    apiLogger.info({
      msg: "crm-note:created",
      noteId: note.id,
      organizationId: input.organizationId,
      activityType: note.activityType,
      source: input.source,
    });
    return { ok: true, note };
  } catch (err) {
    apiLogger.error({
      msg: "crm-note:create-failed",
      organizationId: input.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not save the note" };
  }
}

/**
 * Edit a note. AUTHOR ONLY.
 *
 * A note is a first-person account of a conversation. Letting a colleague rewrite
 * it — silently, since notes carry no visible edit history — would misattribute
 * words to a person who never said them. Admins get delete, not rewrite.
 */
export async function updateNote(input: UpdateNoteInput): Promise<NoteResult> {
  const data: Prisma.CrmNoteUpdateManyMutationInput = {};
  if (input.body !== undefined) {
    const body = input.body.trim();
    if (!body) return { ok: false, code: "BODY_REQUIRED", message: "The note cannot be empty" };
    data.body = body;
  }
  if (input.activityType !== undefined) data.activityType = input.activityType;

  if (Object.keys(data).length === 0) {
    return { ok: false, code: "NO_FIELDS", message: "No fields to update" };
  }

  try {
    const existing = await db.crmNote.findFirst({
      where: { id: input.noteId, organizationId: input.organizationId },
      select: { id: true, authorId: true },
    });
    if (!existing) {
      apiLogger.warn({ msg: "crm-note:update-not-found", noteId: input.noteId, organizationId: input.organizationId });
      return { ok: false, code: "NOTE_NOT_FOUND", message: "Note not found" };
    }

    // Authorship is the gate — not role. An admin is not the author of your call.
    if (!input.userId || existing.authorId !== input.userId) {
      apiLogger.warn({
        msg: "crm-note:update-not-author",
        noteId: input.noteId,
        userId: input.userId,
        authorId: existing.authorId,
      });
      return {
        ok: false,
        code: "NOT_AUTHOR",
        message: "Only the person who wrote a note can edit it",
      };
    }

    await db.crmNote.updateMany({
      where: { id: input.noteId, organizationId: input.organizationId },
      data,
    });

    const note = await db.crmNote.findUniqueOrThrow({ where: { id: input.noteId } });

    void writeAudit({
      userId: input.userId,
      action: "UPDATE",
      entityId: note.id,
      changes: { source: input.source, fields: Object.keys(data) },
    });

    apiLogger.info({ msg: "crm-note:updated", noteId: note.id, source: input.source });
    return { ok: true, note };
  } catch (err) {
    apiLogger.error({
      msg: "crm-note:update-failed",
      noteId: input.noteId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not update the note" };
  }
}

/** Delete a note. The author may delete their own; an admin may delete any. */
export async function deleteNote(input: {
  noteId: string;
  organizationId: string;
  userId: string | null;
  isAdmin: boolean;
  source: "rest" | "mcp" | "api";
}): Promise<{ ok: true } | Fail> {
  try {
    const existing = await db.crmNote.findFirst({
      where: { id: input.noteId, organizationId: input.organizationId },
      select: { id: true, authorId: true, activityType: true },
    });
    if (!existing) {
      apiLogger.warn({ msg: "crm-note:delete-not-found", noteId: input.noteId, organizationId: input.organizationId });
      return { ok: false, code: "NOTE_NOT_FOUND", message: "Note not found" };
    }

    const isAuthor = !!input.userId && existing.authorId === input.userId;
    if (!isAuthor && !input.isAdmin) {
      apiLogger.warn({ msg: "crm-note:delete-not-author", noteId: input.noteId, userId: input.userId });
      return { ok: false, code: "NOT_AUTHOR", message: "Only the author or an admin can delete a note" };
    }

    // deleteMany, not delete (CRM review L4): a concurrent double-delete's loser
    // gets NOTE_NOT_FOUND instead of a P2025 falling through as UNKNOWN.
    const res = await db.crmNote.deleteMany({ where: { id: existing.id, organizationId: input.organizationId } });
    if (res.count === 0) {
      apiLogger.warn({ msg: "crm-note:delete-raced", noteId: input.noteId });
      return { ok: false, code: "NOTE_NOT_FOUND", message: "Note not found" };
    }

    void writeAudit({
      userId: input.userId,
      action: "DELETE",
      entityId: existing.id,
      // After the delete there is nothing left to diff against — the audit row is
      // the only surviving record that the note existed and who removed it.
      changes: {
        source: input.source,
        activityType: existing.activityType,
        authorId: existing.authorId,
        deletedByAdmin: !isAuthor,
      },
    });

    apiLogger.info({ msg: "crm-note:deleted", noteId: existing.id, byAdmin: !isAuthor, source: input.source });
    return { ok: true };
  } catch (err) {
    apiLogger.error({
      msg: "crm-note:delete-failed",
      noteId: input.noteId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not delete the note" };
  }
}

function writeAudit(entry: {
  userId: string | null;
  action: string;
  entityId: string;
  ipAddress?: string;
  changes: Record<string, unknown>;
}) {
  return db.auditLog
    .create({
      data: {
        userId: entry.userId,
        action: entry.action,
        entityType: "CrmNote",
        entityId: entry.entityId,
        ipAddress: entry.ipAddress ?? null,
        changes: entry.changes as Prisma.InputJsonValue,
      },
    })
    .catch((err: unknown) => {
      apiLogger.error({
        msg: "crm-note:audit-failed",
        entityId: entry.entityId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
}
