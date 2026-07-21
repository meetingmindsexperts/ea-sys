import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmRead, requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import { isArchivedView } from "@/crm/lib/deal-filters";
import { findOrCreateCrmContact } from "@/crm/services/crm-contact-service";
import { computeContactScore } from "@/crm/lib/contact-score";
import { CONTACT_STATUS_VALUES } from "@/crm/lib/crm-types";

const createSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email().max(255),
  companyId: z.string().min(1).optional().nullable(),
  jobTitle: z.string().max(255).optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  mobile: z.string().max(50).optional().nullable(),
  country: z.string().max(100).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
  lifecycleStage: z.enum(["LEAD", "ENGAGED", "CUSTOMER", "CHAMPION"]).optional().nullable(),
  status: z.enum(CONTACT_STATUS_VALUES).optional().nullable(),
  tags: z.array(z.string().min(1).max(50)).max(25).optional(),
  /** The owning rep; omitted/null defaults to the creator (service-level). */
  ownerId: z.string().min(1).optional().nullable(),
});

/**
 * GET /api/crm/contacts — business contacts (reps, exhibitor sales, procurement).
 *
 * This is NOT the event contact store. HCPs live in `Contact` and are mirrored to
 * the external marketing table; these people are not and must not be.
 */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;

  try {
    const { searchParams } = new URL(req.url);
    const q = searchParams.get("q")?.trim();
    const companyId = searchParams.get("companyId")?.trim();
    const lifecycle = searchParams.get("lifecycle")?.trim();
    const status = searchParams.get("status")?.trim();
    const owner = searchParams.get("owner")?.trim();
    const LIFECYCLE = new Set(["LEAD", "ENGAGED", "CUSTOMER", "CHAMPION"]);
    const STATUS = new Set<string>(CONTACT_STATUS_VALUES);

    const rows = await db.crmContact.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: isArchivedView(searchParams.get("archived")) ? { not: null } : null,
        ...(companyId ? { companyId } : {}),
        ...(owner ? { ownerId: owner } : {}),
        ...(lifecycle && LIFECYCLE.has(lifecycle) ? { lifecycleStage: lifecycle as "LEAD" | "ENGAGED" | "CUSTOMER" | "CHAMPION" } : {}),
        ...(status && STATUS.has(status) ? { status: status as (typeof CONTACT_STATUS_VALUES)[number] } : {}),
        ...(q
          ? {
              OR: [
                { firstName: { contains: q, mode: "insensitive" as const } },
                { lastName: { contains: q, mode: "insensitive" as const } },
                { email: { contains: q, mode: "insensitive" as const } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        jobTitle: true,
        phone: true,
        mobile: true,
        country: true,
        lifecycleStage: true,
        status: true,
        tags: true,
        createdAt: true,
        company: { select: { id: true, name: true } },
        owner: { select: { id: true, firstName: true, lastName: true } },
        // Non-null when this rep is ALSO in the event contact store (they attend).
        contactId: true,
        archivedAt: true,
        _count: { select: { deals: true } },
        // Deal statuses only — feeds the auto-computed score, stripped below.
        deals: { select: { deal: { select: { status: true, archivedAt: true } } } },
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      take: 500,
    });

    // Score is derived, never stored — computed here from live deal involvement
    // (archived deals excluded), so it cannot go stale.
    const contacts = rows.map(({ deals, ...c }) => {
      const live = deals.filter((d) => !d.deal.archivedAt);
      return {
        ...c,
        score: computeContactScore({
          openDeals: live.filter((d) => d.deal.status === "OPEN").length,
          wonDeals: live.filter((d) => d.deal.status === "WON").length,
        }).total,
      };
    });

    return NextResponse.json({ contacts });
  } catch (err) {
    apiLogger.error({
      msg: "crm/contacts:list-failed",
      organizationId: ctx.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load contacts" }, { status: 500 });
  }
}

/** POST /api/crm/contacts — find-or-create (never mints a second row for one person). */
export async function POST(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/contacts:POST", organizationId: ctx.organizationId });
  }

  const result = await findOrCreateCrmContact({
    ...parsed.data,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    source: ctx.fromApiKey ? "api" : "rest",
    requestIp: getClientIp(req) ?? undefined,
  });

  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json(
    { contact: result.crmContact, created: result.created },
    { status: result.created ? 201 : 200 },
  );
}
