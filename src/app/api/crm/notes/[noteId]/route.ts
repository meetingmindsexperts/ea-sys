import { NextResponse } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import { updateNote, deleteNote } from "@/crm/services/note-service";

const updateNoteSchema = z.object({
  body: z.string().min(1).max(10000).optional(),
  activityType: z.enum(["NOTE", "CALL", "MEETING"]).optional(),
});

/** An admin may DELETE any note but may never REWRITE one — see note-service. */
const ADMIN_ROLES = new Set(["SUPER_ADMIN", "ADMIN"]);

export async function PATCH(req: Request, { params }: { params: Promise<{ noteId: string }> }) {
  const [{ error, ctx }, { noteId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;
  // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
  return await runWithTenant(ctx.organizationId, async () => {

  const body = await req.json().catch(() => null);
  const parsed = updateNoteSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/notes/[noteId]:PATCH", organizationId: ctx.organizationId, noteId });
  }

  const result = await updateNote({
    ...parsed.data,
    noteId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    isAdmin: ADMIN_ROLES.has(ctx.role ?? "") || ctx.fromApiKey,
    source: ctx.fromApiKey ? "api" : "rest",
  });

  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ note: result.note });
  });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ noteId: string }> }) {
  const [{ error, ctx }, { noteId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;
  // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
  return await runWithTenant(ctx.organizationId, async () => {

  const result = await deleteNote({
    noteId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    isAdmin: ADMIN_ROLES.has(ctx.role ?? "") || ctx.fromApiKey,
    source: ctx.fromApiKey ? "api" : "rest",
  });

  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ success: true });
  });
}
