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

// ── Find-or-create (event-level entry, org-level consolidation) ───────────────

export type FindOrCreateBillingAccountResult =
  | { ok: true; billingAccount: BillingAccount; reused: boolean; flaggedReview: boolean }
  | { ok: false; code: BillingAccountErrorCode; message: string; meta?: Record<string, unknown> };

/** Loose key for near-duplicate detection: alphanumerics only, lowercased. */
function fuzzyKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Event-level payer entry with org-level consolidation — mirrors the Contact
 * model (capture in context, dedupe into one org record). Behavior:
 *   1. Exact (case-insensitive, trimmed) name → REUSE the existing org payer
 *      (never a duplicate); the inline-entered details are ignored — the
 *      consolidated record is the source of truth (edit it in Settings → Billing).
 *   2. Otherwise CREATE — and if a near-duplicate name exists (fuzzy: one
 *      alphanumeric key contains the other, e.g. "Cleveland Clinic" vs
 *      "Cleveland Clinic Foundation"), flag `needsReview` so an admin can merge
 *      later. The flag is advisory; it never blocks the create.
 */
export async function findOrCreateBillingAccount(
  input: CreateBillingAccountInput,
): Promise<FindOrCreateBillingAccountResult> {
  const { organizationId } = input;
  const name = (input.name ?? "").trim();
  if (!name) {
    return { ok: false, code: "NAME_REQUIRED", message: "Billing account name is required" };
  }

  // 1. Exact (case-insensitive) name → reuse the consolidated org payer.
  const exact = await db.billingAccount.findFirst({
    where: { organizationId, name: { equals: name, mode: "insensitive" } },
  });
  if (exact) {
    return { ok: true, billingAccount: exact, reused: true, flaggedReview: exact.needsReview };
  }

  // 2. No exact match — flag a likely near-duplicate for later merge.
  const incomingKey = fuzzyKey(name);
  let flaggedReview = false;
  if (incomingKey.length > 0) {
    const orgPayers = await db.billingAccount.findMany({
      where: { organizationId },
      select: { name: true },
    });
    flaggedReview = orgPayers.some((p) => {
      const k = fuzzyKey(p.name);
      return k.length > 0 && (k.includes(incomingKey) || incomingKey.includes(k));
    });
  }

  // 3. Create, carrying the needsReview flag.
  const created = await createBillingAccount({ ...input, name, needsReview: flaggedReview });
  if (!created.ok) return created;
  return { ok: true, billingAccount: created.billingAccount, reused: false, flaggedReview };
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

// ── Merge ────────────────────────────────────────────────────────────────────

export interface MergeBillingAccountsInput {
  /** The payer that survives (keeps its details + name). */
  survivorId: string;
  /** The duplicate to fold into the survivor and delete. */
  duplicateId: string;
  organizationId: string;
  userId: string;
  source: "rest" | "mcp" | "api";
  requestIp?: string;
}

export type MergeBillingAccountsErrorCode =
  | "NOT_FOUND"
  | "SAME_ACCOUNT"
  | "UNKNOWN";

export type MergeBillingAccountsResult =
  | {
      ok: true;
      merge: {
        survivorId: string;
        duplicateId: string;
        registrationsRepointed: number;
        eventsRepointed: number;
      };
    }
  | { ok: false; code: MergeBillingAccountsErrorCode; message: string };

/**
 * Merge a duplicate payer into a survivor — the review action behind the
 * `needsReview` flag that `findOrCreateBillingAccount` sets on near-duplicate
 * names. Inside ONE transaction: every `Registration.billingAccountId` and
 * every `EventBillingAccount` attachment is re-pointed from the duplicate to
 * the survivor (attachments the survivor already has are dropped, not
 * duplicated — the junction is unique per (event, payer)), the duplicate row
 * is deleted, and the survivor's `needsReview` flag is cleared. The
 * duplicate's own field values are intentionally NOT copied — the operator
 * picked the survivor as the canonical record; its details win.
 */
export async function mergeBillingAccounts(
  input: MergeBillingAccountsInput,
): Promise<MergeBillingAccountsResult> {
  const { survivorId, duplicateId, organizationId, userId, source, requestIp } = input;

  if (survivorId === duplicateId) {
    return { ok: false, code: "SAME_ACCOUNT", message: "Pick two different payers to merge." };
  }

  try {
    const result = await db.$transaction(async (tx) => {
      // Both rows must belong to the caller's org — a foreign id is a 404,
      // never a cross-tenant merge.
      const [survivor, duplicate] = await Promise.all([
        tx.billingAccount.findFirst({
          where: { id: survivorId, organizationId },
          select: { id: true, name: true },
        }),
        tx.billingAccount.findFirst({
          where: { id: duplicateId, organizationId },
          select: { id: true, name: true },
        }),
      ]);
      if (!survivor || !duplicate) return null;

      // Re-point registrations billed to the duplicate.
      const regs = await tx.registration.updateMany({
        where: { billingAccountId: duplicateId },
        data: { billingAccountId: survivorId },
      });

      // Re-point event attachments. Where the survivor is ALREADY attached to
      // the same event, drop the duplicate's junction row instead (unique
      // [eventId, billingAccountId] would reject the update).
      const [dupJunctions, survivorJunctions] = await Promise.all([
        tx.eventBillingAccount.findMany({
          where: { billingAccountId: duplicateId },
          select: { id: true, eventId: true },
        }),
        tx.eventBillingAccount.findMany({
          where: { billingAccountId: survivorId },
          select: { eventId: true },
        }),
      ]);
      const survivorEventIds = new Set(survivorJunctions.map((j) => j.eventId));
      const overlapping = dupJunctions.filter((j) => survivorEventIds.has(j.eventId));
      const movable = dupJunctions.filter((j) => !survivorEventIds.has(j.eventId));
      if (overlapping.length > 0) {
        await tx.eventBillingAccount.deleteMany({
          where: { id: { in: overlapping.map((j) => j.id) } },
        });
      }
      if (movable.length > 0) {
        await tx.eventBillingAccount.updateMany({
          where: { id: { in: movable.map((j) => j.id) } },
          data: { billingAccountId: survivorId },
        });
      }

      // Delete the duplicate (registrations re-pointed above, so the Restrict
      // FK can't fire) and clear the survivor's review flag — the merge IS the
      // review.
      await tx.billingAccount.delete({ where: { id: duplicateId } });
      await tx.billingAccount.update({
        where: { id: survivorId },
        data: { needsReview: false },
      });

      return {
        survivorName: survivor.name,
        duplicateName: duplicate.name,
        registrationsRepointed: regs.count,
        eventsRepointed: movable.length,
        attachmentsDropped: overlapping.length,
      };
    });

    if (!result) {
      apiLogger.warn({ msg: "billing-account:merge-not-found", survivorId, duplicateId, organizationId });
      return { ok: false, code: "NOT_FOUND", message: "One of the payers was not found." };
    }

    db.auditLog
      .create({
        data: {
          userId,
          action: "MERGE",
          entityType: "BillingAccount",
          entityId: survivorId,
          changes: auditChanges(source, requestIp, {
            organizationId,
            duplicateId,
            duplicateName: result.duplicateName,
            survivorName: result.survivorName,
            registrationsRepointed: result.registrationsRepointed,
            eventsRepointed: result.eventsRepointed,
            attachmentsDropped: result.attachmentsDropped,
          }),
        },
      })
      .catch((err) => apiLogger.error({ err }, "billing-account-service:merge-audit-failed"));

    apiLogger.info({
      msg: "billing-account:merged",
      survivorId, duplicateId, organizationId,
      registrationsRepointed: result.registrationsRepointed,
      eventsRepointed: result.eventsRepointed,
      source,
    });

    return {
      ok: true,
      merge: {
        survivorId,
        duplicateId,
        registrationsRepointed: result.registrationsRepointed,
        eventsRepointed: result.eventsRepointed,
      },
    };
  } catch (err) {
    apiLogger.error({ err, survivorId, duplicateId }, "billing-account-service:merge-failed");
    return { ok: false, code: "UNKNOWN", message: "Failed to merge billing accounts" };
  }
}
