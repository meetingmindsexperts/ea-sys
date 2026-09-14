/**
 * Budget templates: one per event type, seeding the lines a typical event
 * carries. Creating a budget from a template COPIES its lines and nothing
 * links back, so editing a template never changes a live budget (spec §6a).
 *
 * `ensureBudgetTemplates` seeds one template per EventType with one blank
 * line per top-level expense category, once per organisation (the pipeline
 * pattern). Errors as values; runs inside the caller's tenant lane.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { CONTINGENCY_CATEGORY_CODE } from "../lib/budget-categories-seed";
import { ensureBudgetCategories } from "./budget-category-service";

export const TEMPLATE_LINE_SELECT = {
  id: true, categoryId: true, description: true, defaultQty: true, defaultUnitCost: true, defaultCurrency: true, taxCode: true, sortOrder: true,
  category: { select: { id: true, code: true, name: true } },
} as const;
export const TEMPLATE_SELECT = {
  id: true, name: true, eventType: true, description: true, isActive: true, createdAt: true, updatedAt: true,
  lines: { select: TEMPLATE_LINE_SELECT, orderBy: { sortOrder: "asc" as const } },
} as const;

const SEED: Array<{ name: string; eventType: "CONFERENCE" | "WEBINAR" | "HYBRID" }> = [
  { name: "Conference", eventType: "CONFERENCE" },
  { name: "Webinar", eventType: "WEBINAR" },
  { name: "Hybrid", eventType: "HYBRID" },
];

export async function ensureBudgetTemplates(organizationId: string) {
  const existing = await db.budgetTemplate.findMany({ where: { organizationId }, select: TEMPLATE_SELECT, orderBy: { name: "asc" } });
  if (existing.length > 0) return existing;
  const categories = (await ensureBudgetCategories(organizationId)).filter((c) => c.depth === 0 && c.isActive && c.code !== CONTINGENCY_CATEGORY_CODE);
  try {
    for (const t of SEED) {
      await db.budgetTemplate.create({
        data: {
          organizationId,
          name: t.name,
          eventType: t.eventType,
          description: `Default ${t.name.toLowerCase()} budget: one line per category, amounts to be filled in.`,
          lines: { create: categories.map((c, i) => ({ organizationId, categoryId: c.id, description: c.name, sortOrder: i })) },
        },
      });
    }
    apiLogger.info({ msg: "procurement/templates:seeded", organizationId, count: SEED.length });
  } catch (err) {
    apiLogger.warn({ msg: "procurement/templates:seed-raced", organizationId, err });
  }
  return db.budgetTemplate.findMany({ where: { organizationId }, select: TEMPLATE_SELECT, orderBy: { name: "asc" } });
}

export type TemplateErrorCode = "TEMPLATE_NOT_FOUND" | "LINE_NOT_FOUND" | "CATEGORY_NOT_FOUND" | "NAME_TAKEN" | "INVALID_AMOUNT" | "UNKNOWN";
type Result<T> = { ok: true; template: T } | { ok: false; code: TemplateErrorCode; message: string };
type Source = "ui" | "mcp";

function fail(code: TemplateErrorCode, message: string, ctx: Record<string, unknown>) {
  apiLogger.warn({ msg: "procurement/templates:rejected", code, ...ctx });
  return { ok: false as const, code, message };
}

async function auditTemplate(organizationId: string, actorUserId: string, action: string, entityId: string, changes: Record<string, unknown>) {
  await db.auditLog
    .create({ data: { userId: actorUserId, organizationId, action, entityType: "BudgetTemplate", entityId, changes: changes as never } })
    .catch((err) => apiLogger.error({ msg: "procurement/templates:audit-failed", err }));
}

export async function createBudgetTemplate(input: { organizationId: string; actorUserId: string; source: Source; name: string; eventType: "CONFERENCE" | "WEBINAR" | "HYBRID"; description?: string | null }) {
  const name = input.name.trim();
  try {
    const t = await db.budgetTemplate.create({
      data: { organizationId: input.organizationId, name, eventType: input.eventType, description: input.description ?? null },
      select: TEMPLATE_SELECT,
    });
    await auditTemplate(input.organizationId, input.actorUserId, "CREATE", t.id, { source: input.source, name, eventType: input.eventType });
    return { ok: true as const, template: t };
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return fail("NAME_TAKEN", `A template named ${name} already exists.`, { name });
    apiLogger.error({ msg: "procurement/templates:create-failed", err });
    return fail("UNKNOWN", "Could not create the template.", {});
  }
}

export async function updateBudgetTemplate(input: { organizationId: string; actorUserId: string; source: Source; templateId: string; name?: string; description?: string | null; isActive?: boolean; eventType?: "CONFERENCE" | "WEBINAR" | "HYBRID" }): Promise<Result<unknown>> {
  const ctx = { templateId: input.templateId };
  try {
    const res = await db.budgetTemplate.updateMany({
      where: { id: input.templateId, organizationId: input.organizationId },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.eventType !== undefined ? { eventType: input.eventType } : {}),
      },
    });
    if (res.count === 0) return fail("TEMPLATE_NOT_FOUND", "The template was not found.", ctx);
    await auditTemplate(input.organizationId, input.actorUserId, "UPDATE", input.templateId, { source: input.source, fields: Object.keys(input).filter((k) => !["organizationId", "actorUserId", "source", "templateId"].includes(k)) });
    const t = await db.budgetTemplate.findFirst({ where: { id: input.templateId, organizationId: input.organizationId }, select: TEMPLATE_SELECT });
    return { ok: true, template: t };
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return fail("NAME_TAKEN", "A template with that name already exists.", ctx);
    apiLogger.error({ msg: "procurement/templates:update-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not update the template.", ctx);
  }
}

export async function upsertTemplateLine(input: { organizationId: string; actorUserId: string; source: Source; templateId: string; lineId?: string | null; categoryId?: string; description?: string; defaultQty?: string | number | null; defaultUnitCost?: string | number | null; defaultCurrency?: string | null; taxCode?: string | null; sortOrder?: number }): Promise<Result<unknown>> {
  const ctx = { templateId: input.templateId, lineId: input.lineId ?? null };
  const template = await db.budgetTemplate.findFirst({ where: { id: input.templateId, organizationId: input.organizationId }, select: { id: true } });
  if (!template) return fail("TEMPLATE_NOT_FOUND", "The template was not found.", ctx);
  if (input.categoryId) {
    const cat = await db.budgetCategory.findFirst({ where: { id: input.categoryId, organizationId: input.organizationId, isActive: true }, select: { id: true } });
    if (!cat) return fail("CATEGORY_NOT_FOUND", "The category was not found or is archived.", ctx);
  }
  for (const [k, v] of [["defaultQty", input.defaultQty], ["defaultUnitCost", input.defaultUnitCost]] as const) {
    if (v !== undefined && v !== null && !(Number.isFinite(Number(v)) && Number(v) >= 0)) return fail("INVALID_AMOUNT", `${k} must be a non-negative number.`, ctx);
  }
  const data = {
    ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
    ...(input.description !== undefined ? { description: input.description.trim() } : {}),
    ...(input.defaultQty !== undefined ? { defaultQty: input.defaultQty === null ? null : String(input.defaultQty) } : {}),
    ...(input.defaultUnitCost !== undefined ? { defaultUnitCost: input.defaultUnitCost === null ? null : String(input.defaultUnitCost) } : {}),
    ...(input.defaultCurrency !== undefined ? { defaultCurrency: input.defaultCurrency } : {}),
    ...(input.taxCode !== undefined ? { taxCode: input.taxCode } : {}),
    ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
  };
  try {
    if (input.lineId) {
      const res = await db.budgetTemplateLine.updateMany({ where: { id: input.lineId, templateId: template.id, organizationId: input.organizationId }, data });
      if (res.count === 0) return fail("LINE_NOT_FOUND", "The template line was not found.", ctx);
    } else {
      if (!input.categoryId || !input.description?.trim()) return fail("INVALID_AMOUNT", "A template line needs a category and a description.", ctx);
      const last = await db.budgetTemplateLine.aggregate({ where: { templateId: template.id }, _max: { sortOrder: true } });
      await db.budgetTemplateLine.create({
        data: { organizationId: input.organizationId, templateId: template.id, categoryId: input.categoryId, description: input.description.trim(), sortOrder: input.sortOrder ?? (last._max.sortOrder ?? -1) + 1, ...data },
      });
    }
    await auditTemplate(input.organizationId, input.actorUserId, input.lineId ? "UPDATE_LINE" : "ADD_LINE", template.id, { source: input.source, lineId: input.lineId ?? null });
    const t = await db.budgetTemplate.findFirst({ where: { id: template.id }, select: TEMPLATE_SELECT });
    return { ok: true, template: t };
  } catch (err) {
    apiLogger.error({ msg: "procurement/templates:line-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not save the template line.", ctx);
  }
}

export async function deleteTemplateLine(input: { organizationId: string; actorUserId: string; source: Source; templateId: string; lineId: string }): Promise<Result<unknown>> {
  const ctx = { templateId: input.templateId, lineId: input.lineId };
  try {
    const res = await db.budgetTemplateLine.deleteMany({ where: { id: input.lineId, templateId: input.templateId, organizationId: input.organizationId } });
    if (res.count === 0) return fail("LINE_NOT_FOUND", "The template line was not found.", ctx);
    await auditTemplate(input.organizationId, input.actorUserId, "REMOVE_LINE", input.templateId, { source: input.source, lineId: input.lineId });
    const t = await db.budgetTemplate.findFirst({ where: { id: input.templateId, organizationId: input.organizationId }, select: TEMPLATE_SELECT });
    return { ok: true, template: t };
  } catch (err) {
    apiLogger.error({ msg: "procurement/templates:line-delete-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not remove the template line.", ctx);
  }
}
