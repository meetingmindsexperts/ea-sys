/**
 * Event Blueprint service: storage for the page's blueprints, templates and
 * files (docs/EVENT_BLUEPRINT_PLAN.md step 3).
 *
 * Every function takes the caller's organisation and runs inside its tenant
 * context, so the RLS policies in prisma/rls/blueprint.sql hold on the
 * platform instance. Authorisation (the blueprints.* keys, the module flag)
 * is the route's; the service trusts its caller and refuses only what is
 * wrong with the data. Errors are values (services/README.md).
 *
 * The workflow (submit, stages, approval) is NOT here yet: steps 5 and 6.
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { uploadFile, readStoredFile, deleteStoredFile } from "@/lib/storage";
import {
  BLUEPRINT_ID_RE,
  TEMPLATE_ID_RE,
  mergeForPage,
  parseBlueprintPayload,
  parseTemplatePayload,
  toPageStatus,
  type PayloadError,
} from "@/lib/blueprint/blueprint-payload";
import { MAX_BLUEPRINT_FILE_BYTES, sniffBlueprintFile } from "@/lib/blueprint/blueprint-files";

export type BlueprintErrorCode = PayloadError | "INVALID_ID" | "NOT_FOUND" | "UNSUPPORTED_FILE" | "FILE_TOO_LARGE";

type Fail = { ok: false; code: BlueprintErrorCode; message: string };

interface Caller {
  organizationId: string;
  userId: string;
}

const LIST_LIMIT = 100;
const FILES_DIR = "blueprints";

function fail(code: BlueprintErrorCode, message: string, ctx: Record<string, unknown>): Fail {
  apiLogger.warn({ msg: "blueprint-service:refused", code, ...ctx });
  return { ok: false, code, message };
}

// ── Blueprints ───────────────────────────────────────────────────────────────

/** The organisation's live blueprints, newest first, in the page's list shape. */
export function listBlueprints(organizationId: string) {
  return runWithTenant(organizationId, async () => {
    const rows = await db.blueprint.findMany({
      where: { organizationId, archivedAt: null },
      select: { id: true, title: true, type: true, status: true, ref: true, readiness: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take: LIST_LIMIT,
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      type: r.type,
      status: toPageStatus(r.status),
      ref: r.ref ?? "",
      readiness: r.readiness,
      updated: r.updatedAt.getTime(),
    }));
  });
}

export async function getBlueprint(
  organizationId: string,
  id: string,
): Promise<{ ok: true; blueprint: Record<string, unknown> } | Fail> {
  if (!BLUEPRINT_ID_RE.test(id)) return fail("INVALID_ID", "Not a blueprint id", { organizationId, id });
  return runWithTenant(organizationId, async () => {
    const row = await db.blueprint.findFirst({
      where: { id, organizationId, archivedAt: null },
      select: {
        id: true,
        status: true,
        ref: true,
        data: true,
        createdAt: true,
        updatedAt: true,
        statusLog: {
          select: { kind: true, toStatus: true, readiness: true, detail: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!row) return fail("NOT_FOUND", "Blueprint not found", { organizationId, id });
    return { ok: true as const, blueprint: mergeForPage(row, row.statusLog) };
  });
}

/**
 * Create or update a blueprint under the page's own id. An id held by another
 * organisation reads as not found, never as a conflict, so ids are not an
 * oracle. Someone other than the owner editing a SUBMITTED blueprint is
 * recorded in `editorIds`, which approval refuses (plan §4.7).
 */
export async function saveBlueprint(
  caller: Caller,
  id: string,
  raw: unknown,
): Promise<{ ok: true; updated: number } | Fail> {
  const ctx = { organizationId: caller.organizationId, userId: caller.userId, id };
  if (!BLUEPRINT_ID_RE.test(id)) return fail("INVALID_ID", "Not a blueprint id", ctx);
  const parsed = parseBlueprintPayload(raw, id);
  if (!parsed.ok) return fail(parsed.code, "The blueprint could not be saved as sent", ctx);

  return runWithTenant(caller.organizationId, async () => {
    const fields = {
      title: parsed.title,
      type: parsed.type,
      readiness: parsed.readiness,
      data: parsed.data as Prisma.InputJsonValue,
    };
    for (let attempt = 1; ; attempt++) {
      const existing = await db.blueprint.findUnique({
        where: { id },
        select: { organizationId: true, status: true, archivedAt: true, editorIds: true },
      });
      if (existing && (existing.organizationId !== caller.organizationId || existing.archivedAt)) {
        return fail("NOT_FOUND", "Blueprint not found", ctx);
      }
      if (existing) {
        const recordEditor = existing.status !== "DRAFT" && !existing.editorIds.includes(caller.userId);
        const row = await db.blueprint.update({
          where: { id },
          data: { ...fields, ...(recordEditor && { editorIds: { push: caller.userId } }) },
          select: { updatedAt: true },
        });
        return { ok: true as const, updated: row.updatedAt.getTime() };
      }
      try {
        const row = await db.blueprint.create({
          data: { id, organizationId: caller.organizationId, ownerId: caller.userId, ...fields },
          select: { updatedAt: true },
        });
        apiLogger.info({ msg: "blueprint-service:created", ...ctx });
        return { ok: true as const, updated: row.updatedAt.getTime() };
      } catch (err) {
        // Two first saves raced (the page saves on a 1 s debounce): the loser updates.
        const raced = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
        if (!raced || attempt >= 2) throw err;
      }
    }
  });
}

// ── Templates ────────────────────────────────────────────────────────────────

export function listTemplates(organizationId: string) {
  return runWithTenant(organizationId, async () => {
    const rows = await db.blueprintTemplate.findMany({
      where: { organizationId },
      select: { id: true, name: true, type: true, ownerId: true, data: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: LIST_LIMIT,
    });
    return rows.map((r) => ({ id: r.id, name: r.name, type: r.type, ownerId: r.ownerId, created: r.createdAt.getTime(), state: r.data }));
  });
}

/** Create or replace a template; another organisation's id reads as not found. */
export async function saveTemplate(caller: Caller, id: string, raw: unknown): Promise<{ ok: true } | Fail> {
  const ctx = { organizationId: caller.organizationId, userId: caller.userId, id };
  if (!TEMPLATE_ID_RE.test(id)) return fail("INVALID_ID", "Not a template id", ctx);
  const parsed = parseTemplatePayload(raw, id);
  if (!parsed.ok) return fail(parsed.code, "The template could not be saved as sent", ctx);

  return runWithTenant(caller.organizationId, async () => {
    const existing = await db.blueprintTemplate.findUnique({ where: { id }, select: { organizationId: true } });
    if (existing && existing.organizationId !== caller.organizationId) return fail("NOT_FOUND", "Template not found", ctx);
    const fields = { name: parsed.name, type: parsed.type, data: parsed.state as Prisma.InputJsonValue };
    await db.blueprintTemplate.upsert({
      where: { id },
      create: { id, organizationId: caller.organizationId, ownerId: caller.userId, ...fields },
      update: fields,
    });
    return { ok: true as const };
  });
}

// ── Files ────────────────────────────────────────────────────────────────────

export async function storeFile(
  caller: Caller,
  file: { buffer: Buffer; name: string },
): Promise<{ ok: true; file: { id: string; url: string; sizeBytes: number; contentType: string } } | Fail> {
  const ctx = { organizationId: caller.organizationId, userId: caller.userId, name: file.name.slice(0, 120) };
  if (file.buffer.length > MAX_BLUEPRINT_FILE_BYTES) return fail("FILE_TOO_LARGE", "The limit is 10 MB", { ...ctx, size: file.buffer.length });
  const type = sniffBlueprintFile(file.buffer, file.name);
  if (!type) return fail("UNSUPPORTED_FILE", "Images, PDF and Office documents only", ctx);

  const storedPath = await uploadFile(file.buffer, `${randomUUID()}.${type.ext}`, type.contentType, `${FILES_DIR}/${caller.organizationId}`);
  return runWithTenant(caller.organizationId, async () => {
    const row = await db.blueprintFile.create({
      data: {
        organizationId: caller.organizationId,
        uploadedById: caller.userId,
        storedPath,
        name: file.name.slice(0, 200),
        contentType: type.contentType,
        sizeBytes: file.buffer.length,
      },
      select: { id: true },
    });
    apiLogger.info({ msg: "blueprint-service:file-stored", ...ctx, fileId: row.id, contentType: type.contentType });
    return {
      ok: true as const,
      file: { id: row.id, url: `/api/blueprint/files/${row.id}`, sizeBytes: file.buffer.length, contentType: type.contentType },
    };
  });
}

export async function readFile(
  organizationId: string,
  id: string,
): Promise<{ ok: true; body: Buffer; contentType: string; name: string } | Fail> {
  return runWithTenant(organizationId, async () => {
    const row = await db.blueprintFile.findFirst({
      where: { id, organizationId },
      select: { storedPath: true, contentType: true, name: true },
    });
    if (!row) return fail("NOT_FOUND", "File not found", { organizationId, id });
    const body = await readStoredFile(row.storedPath, `/uploads/${FILES_DIR}/`);
    return { ok: true as const, body, contentType: row.contentType, name: row.name };
  });
}

/** Removes the row, then the stored file (best effort, never throws). */
export async function removeFile(organizationId: string, id: string): Promise<{ ok: true } | Fail> {
  return runWithTenant(organizationId, async () => {
    const row = await db.blueprintFile.findFirst({ where: { id, organizationId }, select: { storedPath: true } });
    if (!row) return fail("NOT_FOUND", "File not found", { organizationId, id });
    await db.blueprintFile.delete({ where: { id } });
    await deleteStoredFile(row.storedPath, `/uploads/${FILES_DIR}/`);
    return { ok: true as const };
  });
}
