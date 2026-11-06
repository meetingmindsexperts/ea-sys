import { NextResponse } from "next/server";
import { z } from "zod";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmPurge, crmErrorResponse } from "@/crm/lib/crm-route";
import { eraseCrmContact } from "@/crm/services/crm-privacy-service";

/**
 * POST /api/crm/contacts/[crmContactId]/erase: erase one person from the CRM
 * on request (crm-privacy-service.ts). The purge gate (SUPER_ADMIN sessions
 * only, API keys refused), because it cannot be undone; the body must repeat
 * the contact's email address.
 */
const schema = z.object({ confirmEmail: z.string().min(3).max(255) });

export async function POST(req: Request, { params }: { params: Promise<{ crmContactId: string }> }) {
  const [{ error, ctx }, { crmContactId }] = await Promise.all([requireCrmPurge(req), params]);
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return zodErrorResponse(parsed, { route: "POST /crm/contacts/[crmContactId]/erase", crmContactId });
    const result = await eraseCrmContact({
      organizationId: ctx.organizationId,
      crmContactId,
      userId: ctx.userId,
      confirmEmail: parsed.data.confirmEmail,
      source: "rest",
    });
    if (!result.ok) return crmErrorResponse(result);
    return NextResponse.json(result.report);
  });
}
