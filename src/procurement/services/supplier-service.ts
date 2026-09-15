/**
 * Suppliers (spec §5, §6, §4.3): a requester PROPOSES one on the spend-request
 * form or from the supplier list; the settle holder APPROVES it (tax number,
 * terms, currency) from the proposed-supplier queue or REJECTS it; only an
 * approved supplier can appear on a commitment. The settle holder also edits
 * and deactivates. Suppliers are never deleted.
 *
 * `taxRegistrationNo` and `bankDetails` are classified (spec §2.9): every
 * read passes through `redactSupplier` unless the caller may see them, and no
 * audit row ever carries their VALUES, only the field names that changed.
 *
 * Errors as values (src/services/README.md). Runs inside the caller's tenant
 * lane; it never opens one itself.
 */
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { planSupplierImport, type SupplierImportRow } from "../lib/catalogue-import";
import { convertRequestsAwaitingSupplier } from "./commitment-service";

export const SUPPLIER_SELECT = {
  id: true, code: true, legalName: true, displayName: true, taxRegistrationNo: true, country: true, currency: true,
  contacts: true, paymentTerms: true, bankDetails: true, externalSystemType: true, externalVendorId: true,
  approvalStatus: true, riskStatus: true, isActive: true, notes: true, proposedByUserId: true, decidedByUserId: true,
  decidedAt: true, decisionNote: true, version: true, createdAt: true, updatedAt: true,
} as const;

export type SupplierRow = Prisma.SupplierGetPayload<{ select: typeof SUPPLIER_SELECT }>;
export type SupplierView = SupplierRow & { financialsRedacted: boolean };

export type SupplierErrorCode = "INVALID_CODE" | "CODE_TAKEN" | "SUPPLIER_NOT_FOUND" | "ALREADY_DECIDED" | "STALE_WRITE" | "UNKNOWN";
export type SupplierResult<T> = { ok: true; supplier: T } | { ok: false; code: SupplierErrorCode; message: string; meta?: Record<string, unknown> };

type Source = "ui" | "mcp";
/** The two classified fields. Listed once so the redaction and the audit filter cannot disagree. */
export const SUPPLIER_CLASSIFIED_FIELDS = ["taxRegistrationNo", "bankDetails"] as const;

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,19}$/;

/** Strips the classified fields for a caller who may not read them; the flag tells the UI why they are blank. */
export function redactSupplier(row: SupplierRow, canSeeFinancials: boolean): SupplierView {
  if (canSeeFinancials) return { ...row, financialsRedacted: false };
  return { ...row, taxRegistrationNo: null, bankDetails: null, financialsRedacted: true };
}

function fail(code: SupplierErrorCode, message: string, ctx: Record<string, unknown> = {}, meta?: Record<string, unknown>): SupplierResult<never> {
  apiLogger.warn({ msg: "procurement/suppliers:rejected", code, ...ctx });
  return { ok: false, code, message, ...(meta ? { meta } : {}) };
}

async function audit(data: { userId: string; organizationId: string; action: string; entityId: string; changes: Record<string, unknown> }) {
  // Belt and braces: a classified VALUE never reaches the trail, whatever a caller passes.
  const changes = Object.fromEntries(Object.entries(data.changes).filter(([k]) => !(SUPPLIER_CLASSIFIED_FIELDS as readonly string[]).includes(k))) as Prisma.InputJsonObject;
  await db.auditLog
    .create({ data: { ...data, changes, entityType: "Supplier" } })
    .catch((err) => apiLogger.error({ msg: "procurement/suppliers:audit-failed", err, action: data.action }));
}

/** Derives a code from the display name: upper-case letters and digits, at most 12 characters. */
export function deriveSupplierCode(name: string): string {
  const code = name.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 12);
  return code || "SUPPLIER";
}

export async function listSuppliers(organizationId: string, opts: { status?: "PROPOSED" | "APPROVED" | "REJECTED"; includeInactive?: boolean } = {}): Promise<SupplierRow[]> {
  return db.supplier.findMany({
    where: { organizationId, ...(opts.status ? { approvalStatus: opts.status } : {}), ...(opts.includeInactive ? {} : { isActive: true }) },
    orderBy: [{ approvalStatus: "asc" }, { displayName: "asc" }],
    select: SUPPLIER_SELECT,
  });
}

export async function getSupplier(organizationId: string, supplierId: string): Promise<SupplierResult<SupplierRow>> {
  const row = await db.supplier.findFirst({ where: { id: supplierId, organizationId }, select: SUPPLIER_SELECT });
  if (!row) return fail("SUPPLIER_NOT_FOUND", "The supplier was not found.", { supplierId });
  return { ok: true, supplier: row };
}

export interface ProposeSupplierInput {
  organizationId: string;
  actorUserId: string;
  source: Source;
  /** True when the actor holds the settle grant: the supplier is created approved, no queue. */
  approveOnCreate: boolean;
  code?: string;
  legalName: string;
  displayName?: string;
  taxRegistrationNo?: string | null;
  country?: string | null;
  currency: string;
  contacts?: { name: string; email?: string; phone?: string; role?: string }[];
  paymentTerms?: string | null;
  notes?: string | null;
}

export async function proposeSupplier(input: ProposeSupplierInput): Promise<SupplierResult<SupplierRow>> {
  const ctx = { organizationId: input.organizationId, userId: input.actorUserId };
  const displayName = (input.displayName ?? input.legalName).trim();
  const explicit = input.code?.trim().toUpperCase();
  if (explicit !== undefined && !CODE_RE.test(explicit)) return fail("INVALID_CODE", "A supplier code is letters, digits, dashes or underscores, up to 20 characters.", ctx);
  const base = explicit ?? deriveSupplierCode(displayName);
  const approvalStatus = input.approveOnCreate ? ("APPROVED" as const) : ("PROPOSED" as const);
  // A derived code that is taken gets a numeric suffix (three tries); an explicit one is refused.
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = attempt === 0 ? base : `${base.slice(0, 17)}-${attempt + 1}`;
    try {
      const supplier = await db.supplier.create({
        data: {
          organizationId: input.organizationId,
          code,
          legalName: input.legalName.trim(),
          displayName,
          taxRegistrationNo: input.taxRegistrationNo?.trim() || null,
          country: input.country?.trim() || null,
          currency: input.currency.toUpperCase(),
          contacts: (input.contacts ?? []) as Prisma.InputJsonValue,
          paymentTerms: input.paymentTerms?.trim() || null,
          notes: input.notes?.trim() || null,
          approvalStatus,
          proposedByUserId: input.actorUserId,
          ...(input.approveOnCreate ? { decidedByUserId: input.actorUserId, decidedAt: new Date() } : {}),
        },
        select: SUPPLIER_SELECT,
      });
      await audit({
        userId: input.actorUserId,
        organizationId: input.organizationId,
        action: input.approveOnCreate ? "CREATE" : "PROPOSE",
        entityId: supplier.id,
        changes: { source: input.source, code, displayName, currency: supplier.currency, hasTaxRegistrationNo: !!supplier.taxRegistrationNo },
      });
      return { ok: true, supplier };
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") {
        if (explicit !== undefined) return fail("CODE_TAKEN", `Supplier code ${code} already exists.`, ctx);
        continue;
      }
      apiLogger.error({ msg: "procurement/suppliers:create-failed", err, ...ctx });
      return fail("UNKNOWN", "Could not create the supplier.", ctx);
    }
  }
  return fail("CODE_TAKEN", `Could not find a free code for ${displayName}; give one explicitly.`, ctx);
}

export interface DecideSupplierInput {
  organizationId: string;
  actorUserId: string;
  source: Source;
  supplierId: string;
  decision: "APPROVED" | "REJECTED";
  note?: string | null;
}

/** A conditional claim on PROPOSED: two settle holders deciding at once commit once; the loser is told. */
export async function decideSupplier(input: DecideSupplierInput): Promise<SupplierResult<SupplierRow> & { conversion?: { issued: number; failed: number; sendFailed: number } }> {
  const ctx = { supplierId: input.supplierId, userId: input.actorUserId };
  const res = await db.supplier.updateMany({
    where: { id: input.supplierId, organizationId: input.organizationId, approvalStatus: "PROPOSED" },
    data: { approvalStatus: input.decision, decidedByUserId: input.actorUserId, decidedAt: new Date(), decisionNote: input.note?.trim() || null, version: { increment: 1 } },
  });
  if (res.count === 0) {
    const exists = await db.supplier.findFirst({ where: { id: input.supplierId, organizationId: input.organizationId }, select: { approvalStatus: true } });
    if (!exists) return fail("SUPPLIER_NOT_FOUND", "The supplier was not found.", ctx);
    return fail("ALREADY_DECIDED", `This supplier is already ${exists.approvalStatus.toLowerCase()}.`, ctx, { approvalStatus: exists.approvalStatus });
  }
  const supplier = await db.supplier.findFirst({ where: { id: input.supplierId, organizationId: input.organizationId }, select: SUPPLIER_SELECT });
  if (!supplier) return fail("SUPPLIER_NOT_FOUND", "The supplier was not found.", ctx);
  await audit({
    userId: input.actorUserId,
    organizationId: input.organizationId,
    action: input.decision === "APPROVED" ? "APPROVE" : "REJECT",
    entityId: supplier.id,
    changes: { source: input.source, code: supplier.code, note: input.note?.trim() || null },
  });
  // Spec §6: an approved request waiting on this supplier converts on approval.
  // Each conversion runs in its own transaction after the decision committed, so
  // a failure there never undoes the decision; it is logged and the request
  // page offers "Raise the purchase order".
  if (input.decision !== "APPROVED") return { ok: true, supplier };
  const c = await convertRequestsAwaitingSupplier({ organizationId: input.organizationId, supplierId: supplier.id, actorUserId: input.actorUserId, source: input.source });
  return { ok: true, supplier, conversion: { issued: c.issued.length, failed: c.failed.length, sendFailed: c.sendFailed ?? 0 } };
}

export interface UpdateSupplierInput {
  organizationId: string;
  actorUserId: string;
  source: Source;
  supplierId: string;
  expectedVersion: number;
  legalName?: string;
  displayName?: string;
  taxRegistrationNo?: string | null;
  country?: string | null;
  currency?: string;
  contacts?: { name: string; email?: string; phone?: string; role?: string }[];
  paymentTerms?: string | null;
  bankDetails?: Record<string, string | undefined> | null;
  riskStatus?: "NONE" | "WATCH" | "BLOCKED";
  isActive?: boolean;
  notes?: string | null;
}

export async function updateSupplier(input: UpdateSupplierInput): Promise<SupplierResult<SupplierRow>> {
  const ctx = { supplierId: input.supplierId, userId: input.actorUserId };
  const before = await db.supplier.findFirst({ where: { id: input.supplierId, organizationId: input.organizationId }, select: SUPPLIER_SELECT });
  if (!before) return fail("SUPPLIER_NOT_FOUND", "The supplier was not found.", ctx);
  const data: Prisma.SupplierUpdateManyMutationInput = {
    ...(input.legalName !== undefined ? { legalName: input.legalName.trim() } : {}),
    ...(input.displayName !== undefined ? { displayName: input.displayName.trim() } : {}),
    ...(input.taxRegistrationNo !== undefined ? { taxRegistrationNo: input.taxRegistrationNo?.trim() || null } : {}),
    ...(input.country !== undefined ? { country: input.country?.trim() || null } : {}),
    ...(input.currency !== undefined ? { currency: input.currency.toUpperCase() } : {}),
    ...(input.contacts !== undefined ? { contacts: input.contacts as Prisma.InputJsonValue } : {}),
    ...(input.paymentTerms !== undefined ? { paymentTerms: input.paymentTerms?.trim() || null } : {}),
    ...(input.bankDetails !== undefined ? { bankDetails: input.bankDetails === null ? Prisma.JsonNull : (input.bankDetails as Prisma.InputJsonValue) } : {}),
    ...(input.riskStatus !== undefined ? { riskStatus: input.riskStatus } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
  };
  const fields = Object.keys(data);
  if (fields.length === 0) return { ok: true, supplier: before };
  try {
    const res = await db.supplier.updateMany({
      where: { id: input.supplierId, organizationId: input.organizationId, version: input.expectedVersion },
      data: { ...data, version: { increment: 1 } },
    });
    if (res.count === 0) return fail("STALE_WRITE", "Someone else changed this supplier; reload and try again.", ctx, { currentVersion: before.version });
    const supplier = await db.supplier.findFirst({ where: { id: input.supplierId, organizationId: input.organizationId }, select: SUPPLIER_SELECT });
    if (!supplier) return fail("SUPPLIER_NOT_FOUND", "The supplier was not found.", ctx);
    const onlyActivity = fields.length === 1 && input.isActive !== undefined;
    await audit({
      userId: input.actorUserId,
      organizationId: input.organizationId,
      action: onlyActivity ? (input.isActive ? "RESTORE" : "DEACTIVATE") : "UPDATE",
      entityId: supplier.id,
      changes: {
        source: input.source,
        code: supplier.code,
        // Field NAMES only for the classified pair; values for the rest.
        fields,
        ...(input.displayName !== undefined ? { displayName: { before: before.displayName, after: supplier.displayName } } : {}),
        ...(input.currency !== undefined ? { currency: { before: before.currency, after: supplier.currency } } : {}),
        ...(input.riskStatus !== undefined ? { riskStatus: { before: before.riskStatus, after: supplier.riskStatus } } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    return { ok: true, supplier };
  } catch (err) {
    apiLogger.error({ msg: "procurement/suppliers:update-failed", err, ...ctx });
    return fail("UNKNOWN", "Could not save the supplier.", ctx);
  }
}

export interface ImportSuppliersInput {
  organizationId: string;
  actorUserId: string;
  source: Source;
  approveOnCreate: boolean;
  rows: SupplierImportRow[];
}
export interface ImportSuppliersResult {
  created: number;
  skipped: { rowNum: number; reason: string }[];
  errors: string[];
}

/**
 * Execute a supplier import: rows already on the master (by code or by
 * legal name) are skipped and reported, never updated; the rest are created
 * through `proposeSupplier`, so they land as Proposed for the settle holder
 * or approved outright when the importer holds the settle grant. Bank
 * details are not part of an import (classified, spec §2.9).
 */
export async function importSuppliers(input: ImportSuppliersInput): Promise<ImportSuppliersResult> {
  const existing = await listSuppliers(input.organizationId, { includeInactive: true });
  const plan = planSupplierImport(input.rows, existing);
  const errors: string[] = [];
  let created = 0;
  for (const r of plan.creates) {
    const { rowNum, ...row } = r;
    const res = await proposeSupplier({ organizationId: input.organizationId, actorUserId: input.actorUserId, source: input.source, approveOnCreate: input.approveOnCreate, ...row });
    if (!res.ok) {
      errors.push(`Row ${rowNum}: ${res.message}`);
      continue;
    }
    created += 1;
  }
  apiLogger.info({ msg: "procurement/suppliers:imported", organizationId: input.organizationId, userId: input.actorUserId, rows: input.rows.length, created, skipped: plan.skipped.length, errors: errors.length, approveOnCreate: input.approveOnCreate });
  return { created, skipped: plan.skipped, errors };
}
