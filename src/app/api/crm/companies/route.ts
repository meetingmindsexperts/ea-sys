import { NextResponse } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmRead, requireCrmWrite, redactForCaller, crmErrorResponse } from "@/crm/lib/crm-route";
import { CRM_COMPANIES_LIST_CAP, listMeta } from "@/crm/lib/list-caps";
import {
  CRM_LIST_PAGE_SIZE,
  decodeListCursor,
  encodeListCursor,
  keysetAfter,
  parseSortDir,
  type ListCursor,
  type ListSortDir,
} from "@/crm/lib/crm-list-paging";
import type { OrgContext } from "@/lib/api-auth";
import { isArchivedView } from "@/crm/lib/deal-filters";
import { findOrCreateCompany } from "@/crm/services/company-service";
import { companyDealTotals, companyPrimaryContact } from "@/crm/lib/company-rollup";

const createCompanySchema = z.object({
  name: z.string().min(1).max(255),
  industry: z.string().max(100).optional().nullable(),
  website: z.string().max(500).optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  country: z.string().max(100).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
  tags: z.array(z.string().min(1).max(50)).max(25).optional(),
});

const COMPANY_SELECT = {
  id: true,
  name: true,
  industry: true,
  website: true,
  phone: true,
  country: true,
  city: true,
  tags: true,
  needsReview: true,
  archivedAt: true,
  createdAt: true,
  owner: { select: { id: true, firstName: true, lastName: true } },
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
} satisfies Prisma.CrmCompanySelect;

type CompanyRow = Prisma.CrmCompanyGetPayload<{ select: typeof COMPANY_SELECT }>;

/** The row rollups (company-rollup.ts); the deal and contact reads they need are stripped. */
function withRollups(rows: CompanyRow[]) {
  return rows.map(({ deals, contacts, ...c }) => ({
    ...c,
    dealTotals: companyDealTotals(deals),
    primaryContact: companyPrimaryContact(deals, contacts[0]),
  }));
}

/**
 * The paged list's sorts (Oct 29, 2026; crm-list-paging.ts): name pages by
 * keyset, the two counts by offset (a relation count has no column to
 * compare). Every sort ends on id.
 */
const COMPANY_SORTS = { name: true, contacts: false, deals: false } as const;
type CompanySort = keyof typeof COMPANY_SORTS;

function companyOrderBy(sort: CompanySort, dir: ListSortDir): Prisma.CrmCompanyOrderByWithRelationInput[] {
  if (sort === "name") return [{ name: dir }, { id: dir }];
  return [{ [sort]: { _count: dir } }, { name: "asc" }, { id: "asc" }];
}

/**
 * ?paged=1 (the Accounts page): 100 rows at a time in a server-side sort, with
 * a cursor for the next page. The total rides the first page only.
 */
async function pagedCompanies(where: Prisma.CrmCompanyWhereInput, searchParams: URLSearchParams, ctx: OrgContext) {
  const rawSort = searchParams.get("sort");
  const sort: CompanySort = rawSort && rawSort in COMPANY_SORTS ? (rawSort as CompanySort) : "name";
  const dir = parseSortDir(searchParams.get("dir"));
  const rawCursor = searchParams.get("cursor");
  const cursor: ListCursor | null = rawCursor
    ? decodeListCursor(rawCursor, sort, dir, sort === "name" ? ["string", "string"] : undefined)
    : null;
  const after = cursor?.m === "k" && sort === "name" ? keysetAfter(["name", "id"], cursor.v, dir) : null;
  if ((rawCursor && !cursor) || (cursor?.m === "k" && !after)) {
    apiLogger.warn({ msg: "crm/companies:bad-cursor", organizationId: ctx.organizationId, sort, dir });
    return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
  }
  const offset = cursor?.m === "o" ? cursor.o : 0;

  const [rows, total] = await Promise.all([
    db.crmCompany.findMany({
      where: after ? { AND: [where, after as Prisma.CrmCompanyWhereInput] } : where,
      select: COMPANY_SELECT,
      orderBy: companyOrderBy(sort, dir),
      ...(offset ? { skip: offset } : {}),
      take: CRM_LIST_PAGE_SIZE + 1,
    }),
    cursor ? Promise.resolve(null) : db.crmCompany.count({ where }),
  ]);

  const page = rows.slice(0, CRM_LIST_PAGE_SIZE);
  const last = page[page.length - 1];
  let nextCursor: string | null = null;
  if (rows.length > CRM_LIST_PAGE_SIZE && last) {
    nextCursor = COMPANY_SORTS[sort]
      ? encodeListCursor({ m: "k", s: sort, d: dir, v: [last.name, last.id] })
      : encodeListCursor({ m: "o", s: sort, d: dir, o: offset + page.length });
  }
  // dealTotals is in FINANCIAL_KEYS: redacted for MEMBER, as on the capped list.
  return NextResponse.json({ companies: redactForCaller(withRollups(page), ctx), total, nextCursor });
}

/**
 * GET /api/crm/companies — list accounts, with their open-deal counts.
 *
 * Two shapes: ?paged=1 (the Accounts page, server-sorted, 100 at a time) and
 * the original capped list the pickers load.
 */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;
  // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
  return await runWithTenant(ctx.organizationId, async () => {

  try {
    const { searchParams } = new URL(req.url);
    const q = searchParams.get("q")?.trim();
    const needsReview = searchParams.get("needsReview") === "true";
    const industry = searchParams.get("industry")?.trim();
    const owner = searchParams.get("owner")?.trim();
    // Tag filter (any-of): comma-separated exact tags → hasSome (see /companies/tags).
    const tags = (searchParams.get("tags") || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    // Same honest-total rule as the deals board: the cap is a rendering budget,
    // the count is the truth.
    const companyWhere: Prisma.CrmCompanyWhereInput = {
      organizationId: ctx.organizationId,
      // Soft delete: active only by default; ?archived=1 shows the archived view.
      archivedAt: isArchivedView(searchParams.get("archived")) ? { not: null } : null,
      ...(needsReview ? { needsReview: true } : {}),
      ...(industry ? { industry: { equals: industry, mode: "insensitive" as const } } : {}),
      ...(owner ? { ownerId: owner } : {}),
      ...(tags.length ? { tags: { hasSome: tags } } : {}),
      ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
    };

    if (searchParams.get("paged") === "1") return await pagedCompanies(companyWhere, searchParams, ctx);

    const [rows, total] = await Promise.all([
      db.crmCompany.findMany({
      where: companyWhere,
      select: COMPANY_SELECT,
      orderBy: { name: "asc" },
      take: CRM_COMPANIES_LIST_CAP,
      }),
      db.crmCompany.count({ where: companyWhere }),
    ]);

    // dealTotals is in FINANCIAL_KEYS, so redactForCaller strips it for MEMBER
    // exactly like the per-deal dealValue it aggregates.
    const companies = withRollups(rows);

    return NextResponse.json({
      companies: redactForCaller(companies, ctx),
      ...listMeta(total, companies.length),
    });
  } catch (err) {
    apiLogger.error({
      msg: "crm/companies:list-failed",
      organizationId: ctx.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load accounts" }, { status: 500 });
  }
  });
}

/** POST /api/crm/companies — find-or-create (never mints a duplicate account). */
export async function POST(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;
  // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
  return await runWithTenant(ctx.organizationId, async () => {

  const limit = checkRateLimit({
    key: `crm-company-create:org:${ctx.organizationId}`,
    limit: 100,
    windowMs: 60 * 60 * 1000,
  });
  if (!limit.allowed) {
    apiLogger.warn({ msg: "crm/companies:rate-limited", organizationId: ctx.organizationId });
    return NextResponse.json(
      { error: "Too many accounts created — try again shortly", retryAfterSeconds: limit.retryAfterSeconds },
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
  });
}
