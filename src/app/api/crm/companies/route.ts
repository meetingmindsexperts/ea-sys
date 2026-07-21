import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmRead, requireCrmWrite, redactForCaller, crmErrorResponse } from "@/crm/lib/crm-route";
import { isArchivedView } from "@/crm/lib/deal-filters";
import { findOrCreateCompany } from "@/crm/services/company-service";
import { companyDealTotals, companyPrimaryContact } from "@/crm/lib/company-rollup";

const createCompanySchema = z.object({
  name: z.string().min(1).max(255),
  industry: z.string().max(100).optional().nullable(),
  website: z.string().max(500).optional().nullable(),
  country: z.string().max(100).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
});

/** GET /api/crm/companies — list accounts, with their open-deal counts. */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;

  try {
    const { searchParams } = new URL(req.url);
    const q = searchParams.get("q")?.trim();
    const needsReview = searchParams.get("needsReview") === "true";
    const industry = searchParams.get("industry")?.trim();

    const rows = await db.crmCompany.findMany({
      where: {
        organizationId: ctx.organizationId,
        // Soft delete: active only by default; ?archived=1 shows the archived view.
        archivedAt: isArchivedView(searchParams.get("archived")) ? { not: null } : null,
        ...(needsReview ? { needsReview: true } : {}),
        ...(industry ? { industry: { equals: industry, mode: "insensitive" as const } } : {}),
        ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
      },
      select: {
        id: true,
        name: true,
        industry: true,
        website: true,
        country: true,
        city: true,
        needsReview: true,
        archivedAt: true,
        createdAt: true,
        _count: { select: { contacts: true, deals: true } },
        // Feeds the row rollups (company-rollup.ts), stripped below: per-currency
        // OPEN+WON deal totals + the derived primary contact (PRIMARY role on the
        // newest deal, else the newest company contact).
        deals: {
          where: { archivedAt: null },
          orderBy: { createdAt: "desc" },
          select: {
            status: true,
            dealValue: true,
            currency: true,
            contacts: {
              where: { role: "PRIMARY" },
              take: 1,
              select: { crmContact: { select: { id: true, firstName: true, lastName: true } } },
            },
          },
        },
        contacts: {
          where: { archivedAt: null },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, firstName: true, lastName: true },
        },
      },
      orderBy: { name: "asc" },
      take: 500,
    });

    // dealTotals is in FINANCIAL_KEYS, so redactForCaller strips it for MEMBER
    // exactly like the per-deal dealValue it aggregates.
    const companies = rows.map(({ deals, contacts, ...c }) => ({
      ...c,
      dealTotals: companyDealTotals(deals),
      primaryContact: companyPrimaryContact(deals, contacts[0]),
    }));

    return NextResponse.json({ companies: redactForCaller(companies, ctx) });
  } catch (err) {
    apiLogger.error({
      msg: "crm/companies:list-failed",
      organizationId: ctx.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load companies" }, { status: 500 });
  }
}

/** POST /api/crm/companies — find-or-create (never mints a duplicate account). */
export async function POST(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;

  const limit = checkRateLimit({
    key: `crm-company-create:org:${ctx.organizationId}`,
    limit: 100,
    windowMs: 60 * 60 * 1000,
  });
  if (!limit.allowed) {
    apiLogger.warn({ msg: "crm/companies:rate-limited", organizationId: ctx.organizationId });
    return NextResponse.json(
      { error: "Too many companies created — try again shortly", retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = createCompanySchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/companies:POST", organizationId: ctx.organizationId });
  }

  const result = await findOrCreateCompany({
    ...parsed.data,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    source: ctx.fromApiKey ? "api" : "rest",
    requestIp: getClientIp(req) ?? undefined,
  });

  if (!result.ok) return crmErrorResponse(result);

  // 200 (not 201) when an existing account was reused — the caller asked for a
  // company and got one, but nothing was created, and the UI wants to say
  // "linked to Abbott" rather than "created Abbott".
  return NextResponse.json(
    {
      company: redactForCaller(result.company, ctx),
      created: result.created,
      needsReview: result.needsReview,
    },
    { status: result.created ? 201 : 200 },
  );
}
