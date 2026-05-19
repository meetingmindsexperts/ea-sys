/**
 * Billing account service — domain logic for the reusable, org-scoped
 * third-party payer used by "charge to another account".
 *
 * A BillingAccount is the doctor's hospital, or a pharma/grant covering
 * specific HCPs. It is DISTINCT from:
 *   - Event.settings.sponsors[] (bulk pre-paid INCLUSIVE deals), and
 *   - the Registration.billing* block (same payer, different address).
 *
 * Linking a registration to a BillingAccount is ORTHOGONAL to
 * paymentStatus — money is still owed; only the invoice bill-to party
 * changes. That linkage lives in the registration paths
 * (registration-service / REST PUT / MCP update_registration), not here.
 *
 * Shared by the REST CRUD route and the MCP agent tools so they can't
 * drift. Hard deletes are intentionally NOT offered — a payer with
 * linked registrations must not vanish (the FK is Restrict); callers
 * deactivate instead. See src/services/README.md for conventions.
 */

import type { Prisma, BillingAccount, BillingAccountType } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

// ── Input / Result types ─────────────────────────────────────────────────────

export type BillingAccountTypeInput = "INSTITUTION" | "COMPANY" | "OTHER";

interface BillingAccountFields {
  name: string;
  type?: BillingAccountTypeInput;
  email?: string | null;
  phone?: string | null;
  contactName?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  country?: string | null;
  taxNumber?: string | null;
  notes?: string | null;
  /** Set true when minted from the public registration flow so finance
   *  reviews/dedupes it before it joins the canonical picker list. */
  needsReview?: boolean;
}

export interface CreateBillingAccountInput extends BillingAccountFields {
  organizationId: string;
  userId: string;
  source: "rest" | "mcp" | "api";
  requestIp?: string;
}

export interface UpdateBillingAccountInput extends Partial<BillingAccountFields> {
  billingAccountId: string;
  organizationId: string;
  userId: string;
  source: "rest" | "mcp" | "api";
  requestIp?: string;
  /** Reactivate / soft-delete toggle. */
  isActive?: boolean;
}

export type BillingAccountErrorCode =
  | "NAME_REQUIRED"
  | "DUPLICATE_NAME"
  | "NOT_FOUND"
  | "UNKNOWN";

export type CreateBillingAccountResult =
  | { ok: true; billingAccount: BillingAccount }
  | { ok: false; code: BillingAccountErrorCode; message: string; meta?: Record<string, unknown> };

export type UpdateBillingAccountResult = CreateBillingAccountResult;

// ── Helpers ──────────────────────────────────────────────────────────────────

function norm(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function auditChanges(
  source: string,
  requestIp: string | undefined,
  extra: Record<string, unknown>,
) {
  return { source, ...(requestIp ? { ip: requestIp } : {}), ...extra };
}

// ── Create ───────────────────────────────────────────────────────────────────

export async function createBillingAccount(
  input: CreateBillingAccountInput,
): Promise<CreateBillingAccountResult> {
  const { organizationId, userId, source, requestIp } = input;
  const name = (input.name ?? "").trim();
  if (!name) {
    return { ok: false, code: "NAME_REQUIRED", message: "Billing account name is required" };
  }

  try {
    const billingAccount = await db.billingAccount.create({
      data: {
        organizationId,
        name,
        type: (input.type ?? "INSTITUTION") as BillingAccountType,
        email: norm(input.email),
        phone: norm(input.phone),
        contactName: norm(input.contactName),
        address: norm(input.address),
        city: norm(input.city),
        state: norm(input.state),
        zipCode: norm(input.zipCode),
        country: norm(input.country),
        taxNumber: norm(input.taxNumber),
        notes: norm(input.notes),
        needsReview: input.needsReview ?? false,
      },
    });

    db.auditLog
      .create({
        data: {
          userId,
          action: "CREATE",
          entityType: "BillingAccount",
          entityId: billingAccount.id,
          changes: auditChanges(source, requestIp, { name, organizationId }),
        },
      })
      .catch((err) => apiLogger.error({ err }, "billing-account-service:audit-log-failed"));

    return { ok: true, billingAccount };
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "P2002"
    ) {
      // @@unique([organizationId, name]) — surface the existing one so the
      // caller can link to it instead of creating a duplicate payer.
      const existing = await db.billingAccount.findFirst({
        where: { organizationId, name },
        select: { id: true, name: true, isActive: true },
      });
      return {
        ok: false,
        code: "DUPLICATE_NAME",
        message: `A billing account named "${name}" already exists in this organization.`,
        meta: existing ? { existingId: existing.id, isActive: existing.isActive } : undefined,
      };
    }
    apiLogger.error({ err }, "billing-account-service:create-failed");
    return { ok: false, code: "UNKNOWN", message: "Failed to create billing account" };
  }
}

// ── Update / soft-delete ─────────────────────────────────────────────────────

export async function updateBillingAccount(
  input: UpdateBillingAccountInput,
): Promise<UpdateBillingAccountResult> {
  const { billingAccountId, organizationId, userId, source, requestIp } = input;

  // Org-scoped existence check — never trust the id alone (IDOR).
  const existing = await db.billingAccount.findFirst({
    where: { id: billingAccountId, organizationId },
    select: { id: true },
  });
  if (!existing) {
    return { ok: false, code: "NOT_FOUND", message: "Billing account not found" };
  }

  const data: Prisma.BillingAccountUpdateInput = {};
  if (input.name !== undefined) {
    const n = (input.name ?? "").trim();
    if (!n) return { ok: false, code: "NAME_REQUIRED", message: "Billing account name is required" };
    data.name = n;
  }
  if (input.type !== undefined) data.type = input.type as BillingAccountType;
  if (input.email !== undefined) data.email = norm(input.email);
  if (input.phone !== undefined) data.phone = norm(input.phone);
  if (input.contactName !== undefined) data.contactName = norm(input.contactName);
  if (input.address !== undefined) data.address = norm(input.address);
  if (input.city !== undefined) data.city = norm(input.city);
  if (input.state !== undefined) data.state = norm(input.state);
  if (input.zipCode !== undefined) data.zipCode = norm(input.zipCode);
  if (input.country !== undefined) data.country = norm(input.country);
  if (input.taxNumber !== undefined) data.taxNumber = norm(input.taxNumber);
  if (input.notes !== undefined) data.notes = norm(input.notes);
  if (input.needsReview !== undefined) data.needsReview = input.needsReview;
  if (input.isActive !== undefined) data.isActive = input.isActive;

  try {
    const billingAccount = await db.billingAccount.update({
      where: { id: billingAccountId },
      data,
    });

    db.auditLog
      .create({
        data: {
          userId,
          action: "UPDATE",
          entityType: "BillingAccount",
          entityId: billingAccount.id,
          changes: auditChanges(source, requestIp, {
            organizationId,
            fields: Object.keys(data),
          }),
        },
      })
      .catch((err) => apiLogger.error({ err }, "billing-account-service:audit-log-failed"));

    return { ok: true, billingAccount };
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "P2002"
    ) {
      return {
        ok: false,
        code: "DUPLICATE_NAME",
        message: "Another billing account in this organization already uses that name.",
      };
    }
    apiLogger.error({ err }, "billing-account-service:update-failed");
    return { ok: false, code: "UNKNOWN", message: "Failed to update billing account" };
  }
}
