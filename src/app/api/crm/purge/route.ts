/**
 * POST /api/crm/purge — PERMANENT deletion of ARCHIVED CRM records.
 *
 * The one deliberate exception to the CRM's no-hard-delete rule (owner request,
 * July 20 2026). Gated by requireCrmPurge: SUPER_ADMIN sessions only, API keys
 * refused — destruction is a human decision made in the UI. The service enforces
 * the other half of the contract: only ARCHIVED records are purgeable, every
 * purge leaves an AuditLog snapshot, and a company still referenced by deals is
 * refused (the FK is Restrict).
 *
 * Two shapes, one route (a discriminated union keeps the gate in one place):
 *   { scope: "record", entity: "deal" | "company" | "contact", id }
 *   { scope: "all",    entity: "deals" | "companies" | "contacts" | "all" }
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmPurge, crmErrorResponse } from "@/crm/lib/crm-route";
import { purgeDeal, purgeCompany, purgeCrmContact, purgeArchived } from "@/crm/services/crm-purge-service";

const purgeSchema = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("record"),
    entity: z.enum(["deal", "company", "contact"]),
    id: z.string().min(1),
  }),
  z.object({
    scope: z.literal("all"),
    entity: z.enum(["deals", "companies", "contacts", "all"]),
  }),
]);

export async function POST(req: Request) {
  const { error, ctx } = await requireCrmPurge(req);
  if (error) return error;

  const body = await req.json().catch(() => null);
  const parsed = purgeSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/purge:POST", organizationId: ctx.organizationId });
  }

  const base = { organizationId: ctx.organizationId, userId: ctx.userId };
  const ip = getClientIp(req);

  if (parsed.data.scope === "record") {
    const { entity, id } = parsed.data;
    const result =
      entity === "deal"
        ? await purgeDeal({ ...base, dealId: id })
        : entity === "company"
          ? await purgeCompany({ ...base, companyId: id })
          : await purgeCrmContact({ ...base, crmContactId: id });
    if (!result.ok) return crmErrorResponse(result);

    apiLogger.info({ msg: "crm/purge:record", entity, id, userId: ctx.userId, ip });
    return NextResponse.json({ ok: true });
  }

  const result = await purgeArchived({ ...base, entity: parsed.data.entity });
  if (!result.ok) return crmErrorResponse(result);

  apiLogger.info({
    msg: "crm/purge:all",
    entity: parsed.data.entity,
    userId: ctx.userId,
    ip,
    ...result.purged,
    skipped: result.skipped.length,
    capped: result.capped,
  });
  return NextResponse.json(result);
}
