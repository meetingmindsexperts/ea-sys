import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmRead, requireCrmWrite, crmErrorResponse, denyCrmProseRead } from "@/crm/lib/crm-route";
import { createNote } from "@/crm/services/note-service";

const createNoteSchema = z.object({
  body: z.string().min(1).max(10000),
  activityType: z.enum(["NOTE", "CALL", "MEETING"]).optional(),
  dealId: z.string().min(1).optional().nullable(),
  companyId: z.string().min(1).optional().nullable(),
  crmContactId: z.string().min(1).optional().nullable(),
});

/**
 * GET /api/crm/notes?dealId=|companyId=|crmContactId= — the notes log for one record.
 *
 * Read-gated PLUS the prose gate (CRM review M2): notes routinely contain deal
 * money in free text, so a money-blind MEMBER may not read them — key-based
 * redaction can't strip a number out of a sentence.
 */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;

  const proseDenied = denyCrmProseRead(ctx);
  if (proseDenied) return proseDenied;

  const { searchParams } = new URL(req.url);
  const dealId = searchParams.get("dealId")?.trim();
  const companyId = searchParams.get("companyId")?.trim();
  const crmContactId = searchParams.get("crmContactId")?.trim();

  if (!dealId && !companyId && !crmContactId) {
    apiLogger.warn({ msg: "crm/notes:list-no-filter", organizationId: ctx.organizationId });
    return NextResponse.json(
      { error: "Specify dealId, companyId or crmContactId", code: "NO_ATTACHMENT" },
      { status: 400 },
    );
  }

  try {
    const notes = await db.crmNote.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(dealId ? { dealId } : {}),
        ...(companyId ? { companyId } : {}),
        ...(crmContactId ? { crmContactId } : {}),
      },
      select: {
        id: true,
        body: true,
        activityType: true,
        createdAt: true,
        updatedAt: true,
        authorId: true,
        author: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    return NextResponse.json({ notes });
  } catch (err) {
    apiLogger.error({
      msg: "crm/notes:list-failed",
      organizationId: ctx.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load notes" }, { status: 500 });
  }
}

/** POST /api/crm/notes */
export async function POST(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;

  const limit = checkRateLimit({
    key: `crm-note-create:org:${ctx.organizationId}`,
    limit: 300,
    windowMs: 60 * 60 * 1000,
  });
  if (!limit.allowed) {
    apiLogger.warn({ msg: "crm/notes:rate-limited", organizationId: ctx.organizationId });
    return NextResponse.json(
      { error: "Too many notes — try again shortly", retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = createNoteSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/notes:POST", organizationId: ctx.organizationId });
  }

  const result = await createNote({
    ...parsed.data,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    source: ctx.fromApiKey ? "api" : "rest",
    requestIp: getClientIp(req) ?? undefined,
  });

  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ note: result.note }, { status: 201 });
}
