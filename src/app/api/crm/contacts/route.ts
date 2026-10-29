import { NextResponse } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmRead, requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import { CRM_CONTACTS_LIST_CAP, listMeta } from "@/crm/lib/list-caps";
import {
  CRM_LIST_PAGE_SIZE,
  decodeListCursor,
  encodeListCursor,
  keysetAfter,
  parseSortDir,
  type ListCursor,
  type ListSortDir,
} from "@/crm/lib/crm-list-paging";
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

const CONTACT_SELECT = {
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
  // The STORED score: only the paged sort's cursor reads it (the row shows the live one).
  score: true,
  _count: { select: { deals: true } },
  // Deal statuses only — feeds the auto-computed score, stripped below.
  deals: { select: { deal: { select: { status: true, archivedAt: true } } } },
} satisfies Prisma.CrmContactSelect;

type ContactRow = Prisma.CrmContactGetPayload<{ select: typeof CONTACT_SELECT }>;

/** Score is shown live from deal involvement (archived deals excluded), never from the stored copy. */
function withLiveScore(rows: ContactRow[]) {
  return rows.map(({ deals, ...c }) => {
    const live = deals.filter((d) => !d.deal.archivedAt);
    return {
      ...c,
      // Overrides the stored copy the row was read with.
      score: computeContactScore({
        openDeals: live.filter((d) => d.deal.status === "OPEN").length,
        wonDeals: live.filter((d) => d.deal.status === "WON").length,
      }).total,
    };
  });
}

/**
 * The paged list's sorts (Oct 29, 2026; crm-list-paging.ts). name and score
 * page by keyset on stored columns; deals is a relation count, so it pages by
 * offset. Every sort ends on id.
 */
const CONTACT_SORTS = {
  name: { keyset: ["lastName", "firstName", "id"] },
  score: { keyset: ["score", "lastName", "firstName", "id"] },
  deals: { keyset: null },
} as const;
type ContactSort = keyof typeof CONTACT_SORTS;

function contactOrderBy(sort: ContactSort, dir: ListSortDir): Prisma.CrmContactOrderByWithRelationInput[] {
  const keyset = CONTACT_SORTS[sort].keyset;
  if (keyset) return keyset.map((f) => ({ [f]: dir }));
  return [{ deals: { _count: dir } }, { lastName: "asc" }, { firstName: "asc" }, { id: "asc" }];
}

function contactCursorAfter(sort: ContactSort, dir: ListSortDir, row: ContactRow, offset: number): string {
  const keyset = CONTACT_SORTS[sort].keyset;
  if (!keyset) return encodeListCursor({ m: "o", s: sort, d: dir, o: offset });
  return encodeListCursor({ m: "k", s: sort, d: dir, v: keyset.map((f) => row[f]) });
}

/**
 * ?paged=1 (the Contacts page): 100 rows at a time in a server-side sort, with
 * a cursor for the next page. The total rides the first page only.
 */
async function pagedContacts(where: Prisma.CrmContactWhereInput, searchParams: URLSearchParams, organizationId: string) {
  const rawSort = searchParams.get("sort");
  const sort: ContactSort = rawSort && rawSort in CONTACT_SORTS ? (rawSort as ContactSort) : "name";
  const dir = parseSortDir(searchParams.get("dir"));
  const rawCursor = searchParams.get("cursor");
  const cursor: ListCursor | null = rawCursor ? decodeListCursor(rawCursor, sort, dir) : null;
  if (rawCursor && !cursor) {
    apiLogger.warn({ msg: "crm/contacts:bad-cursor", organizationId, sort, dir });
    return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
  }

  const keyset = CONTACT_SORTS[sort].keyset;
  const after = cursor?.m === "k" && keyset ? keysetAfter([...keyset], cursor.v, dir) : null;
  if (cursor?.m === "k" && !after) {
    apiLogger.warn({ msg: "crm/contacts:bad-cursor", organizationId, sort, dir });
    return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
  }
  const offset = cursor?.m === "o" ? cursor.o : 0;

  const [rows, total] = await Promise.all([
    db.crmContact.findMany({
      where: after ? { AND: [where, after as Prisma.CrmContactWhereInput] } : where,
      select: CONTACT_SELECT,
      orderBy: contactOrderBy(sort, dir),
      ...(offset ? { skip: offset } : {}),
      take: CRM_LIST_PAGE_SIZE + 1,
    }),
    cursor ? Promise.resolve(null) : db.crmContact.count({ where }),
  ]);

  const page = rows.slice(0, CRM_LIST_PAGE_SIZE);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > CRM_LIST_PAGE_SIZE && last ? contactCursorAfter(sort, dir, last, offset + page.length) : null;
  return NextResponse.json({ contacts: withLiveScore(page), total, nextCursor });
}

/**
 * GET /api/crm/contacts — business contacts (reps, exhibitor sales, procurement).
 *
 * This is NOT the event contact store. HCPs live in `Contact` and are mirrored to
 * the external marketing table; these people are not and must not be.
 *
 * Two shapes: ?paged=1 (the Contacts page, server-sorted, 100 at a time) and
 * the original capped list that the pickers and the deal dialog search.
 */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;
  // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
  return await runWithTenant(ctx.organizationId, async () => {

  try {
    const { searchParams } = new URL(req.url);
    const q = searchParams.get("q")?.trim();
    const companyId = searchParams.get("companyId")?.trim();
    const lifecycle = searchParams.get("lifecycle")?.trim();
    const status = searchParams.get("status")?.trim();
    const owner = searchParams.get("owner")?.trim();
    // Tag filter (any-of): comma-separated exact tags → hasSome. The UI feeds
    // exact stored strings from GET /contacts/tags, so no casing mismatch.
    const tags = (searchParams.get("tags") || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const LIFECYCLE = new Set(["LEAD", "ENGAGED", "CUSTOMER", "CHAMPION"]);
    const STATUS = new Set<string>(CONTACT_STATUS_VALUES);

    // Same honest-total rule as the deals board: the cap is a rendering
    // budget, the count is the truth.
    const contactWhere: Prisma.CrmContactWhereInput = {
        organizationId: ctx.organizationId,
        archivedAt: isArchivedView(searchParams.get("archived")) ? { not: null } : null,
        ...(companyId ? { companyId } : {}),
        ...(owner ? { ownerId: owner } : {}),
        ...(lifecycle && LIFECYCLE.has(lifecycle) ? { lifecycleStage: lifecycle as "LEAD" | "ENGAGED" | "CUSTOMER" | "CHAMPION" } : {}),
        ...(status && STATUS.has(status) ? { status: status as (typeof CONTACT_STATUS_VALUES)[number] } : {}),
        ...(tags.length ? { tags: { hasSome: tags } } : {}),
        // Every word must match a name or the email, so "Jane Doe" finds Jane
        // Doe (one `contains` over each column alone never could).
        ...(q
          ? {
              AND: q.split(/\s+/).slice(0, 5).map((word) => ({
                OR: [
                  { firstName: { contains: word, mode: "insensitive" as const } },
                  { lastName: { contains: word, mode: "insensitive" as const } },
                  { email: { contains: word, mode: "insensitive" as const } },
                ],
              })),
            }
          : {}),
    };

    if (searchParams.get("paged") === "1") return await pagedContacts(contactWhere, searchParams, ctx.organizationId);

    const [rows, total] = await Promise.all([
      db.crmContact.findMany({
        where: contactWhere,
        select: CONTACT_SELECT,
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
        take: CRM_CONTACTS_LIST_CAP,
      }),
      db.crmContact.count({ where: contactWhere }),
    ]);
    const contacts = withLiveScore(rows);

    return NextResponse.json({ contacts, ...listMeta(total, contacts.length) });
  } catch (err) {
    apiLogger.error({
      msg: "crm/contacts:list-failed",
      organizationId: ctx.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load contacts" }, { status: 500 });
  }
  });
}

/** POST /api/crm/contacts — find-or-create (never mints a second row for one person). */
export async function POST(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;
  // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
  return await runWithTenant(ctx.organizationId, async () => {

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
  });
}
