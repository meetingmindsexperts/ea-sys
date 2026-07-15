import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmRead, requireCrmWrite, redactForCaller, crmErrorResponse } from "@/crm/lib/crm-route";
import { updateCrmContact, linkToEventContact } from "@/crm/services/crm-contact-service";

const updateSchema = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  email: z.string().email().max(255).optional(),
  companyId: z.string().min(1).nullable().optional(),
  jobTitle: z.string().max(255).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  country: z.string().max(100).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  lifecycleStage: z.enum(["LEAD", "ENGAGED", "CUSTOMER", "CHAMPION"]).nullable().optional(),
  /**
   * Point this business contact at their EVENT contact row — for the rep who also
   * attends. A pointer, not a copy: the two populations stay separate (only the
   * event Contact reaches the HCP marketing mirror). `null` unlinks.
   */
  contactId: z.string().min(1).nullable().optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ crmContactId: string }> }) {
  const [{ error, ctx }, { crmContactId }] = await Promise.all([requireCrmRead(req), params]);
  if (error) return error;

  try {
    const contact = await db.crmContact.findFirst({
      where: { id: crmContactId, organizationId: ctx.organizationId },
      include: {
        company: { select: { id: true, name: true } },
        contact: { select: { id: true, firstName: true, lastName: true, email: true } },
        deals: {
          include: {
            deal: {
              select: {
                id: true, name: true, dealValue: true, currency: true, status: true, stageId: true,
                event: { select: { id: true, name: true } },
              },
            },
          },
        },
        crmNotes: {
          orderBy: { createdAt: "desc" },
          take: 100,
          include: { author: { select: { id: true, firstName: true, lastName: true } } },
        },
      },
    });

    if (!contact) {
      apiLogger.warn({ msg: "crm/contacts:detail-not-found", crmContactId, organizationId: ctx.organizationId });
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }

    return NextResponse.json({ contact: redactForCaller(contact, ctx) });
  } catch (err) {
    apiLogger.error({
      msg: "crm/contacts:detail-failed",
      crmContactId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load the contact" }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ crmContactId: string }> }) {
  const [{ error, ctx }, { crmContactId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;

  const body = await req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/contacts/[id]:PATCH", organizationId: ctx.organizationId, crmContactId });
  }

  const { contactId, ...fields } = parsed.data;
  const common = {
    crmContactId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    source: (ctx.fromApiKey ? "api" : "rest") as "api" | "rest",
  };

  // The event-contact link is its own operation (it validates against a different
  // table and audits differently), so route it rather than writing contactId as a
  // plain field.
  if (contactId !== undefined) {
    const linked = await linkToEventContact({ ...common, contactId });
    if (!linked.ok) return crmErrorResponse(linked);
    if (Object.keys(fields).length === 0) {
      return NextResponse.json({ contact: linked.crmContact });
    }
  }

  const result = await updateCrmContact({ ...common, ...fields });
  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ contact: result.crmContact });
}
