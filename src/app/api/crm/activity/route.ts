import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { requireCrmRead, redactForCaller } from "@/crm/lib/crm-route";
import { listCrmActivity, type CrmActivityEntity } from "@/crm/lib/crm-activity";

const ENTITY_TYPES = new Set<CrmActivityEntity>(["DEAL", "COMPANY", "CONTACT", "TASK"]);

/**
 * GET /api/crm/activity?entityType=DEAL&entityId=... — the change log for one
 * record, newest first. Powers the History panel in every detail sheet.
 *
 * Read-gated (any CRM reader, incl. MEMBER) but money-redacted: a `dealValue`
 * anywhere in the change payload is stripped for a caller who may not see values,
 * by the same FINANCIAL_KEYS redactor the board uses — so a MEMBER can see THAT a
 * deal's value changed without seeing the numbers.
 */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;

  const { searchParams } = new URL(req.url);
  const entityType = searchParams.get("entityType");
  const entityId = searchParams.get("entityId")?.trim();

  if (!entityType || !ENTITY_TYPES.has(entityType as CrmActivityEntity) || !entityId) {
    apiLogger.warn({
      msg: "crm/activity:bad-params",
      entityType,
      hasEntityId: !!entityId,
      organizationId: ctx.organizationId,
    });
    return NextResponse.json(
      { error: "entityType (DEAL|COMPANY|CONTACT|TASK) and entityId are required", code: "BAD_PARAMS" },
      { status: 400 },
    );
  }

  try {
    const activity = await listCrmActivity({
      organizationId: ctx.organizationId,
      entityType: entityType as CrmActivityEntity,
      entityId,
    });

    // Redact deal money from the change payloads for callers who can't see it.
    return NextResponse.json({ activity: redactForCaller(activity, ctx) });
  } catch (err) {
    apiLogger.error({
      msg: "crm/activity:list-failed",
      entityType,
      entityId,
      organizationId: ctx.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load the activity log" }, { status: 500 });
  }
}
