/**
 * CRM company (Account) service.
 *
 * A CrmCompany is a first-class Account — the thing `Contact.organization` is
 * only a free-text guess at today. It is the centre of gravity of the sponsor
 * pipeline (§9 decision 1): deals hang off companies, not off people.
 *
 * DEDUP IS THE WHOLE PROBLEM HERE, and it has two halves that are often confused:
 *
 *   1. EXACT duplicates ("Abbott" vs "abbott " vs "ABBOTT"). Solved structurally:
 *      `nameKey` (trimmed + lowercased) carries the unique index, so the DB
 *      itself refuses the second row. We do NOT rely on every writer remembering
 *      to lowercase — that is exactly the assumption that produced the contacts
 *      H2 bug (case-sensitive unique index + one writer that didn't normalize =
 *      two contacts for one person, and a downstream sync that mirrored only one).
 *
 *   2. NEAR duplicates ("Cleveland Clinic" vs "Cleveland Clinic Foundation").
 *      NOT solvable structurally — they are genuinely different strings and may
 *      genuinely be different entities. We create the row and flag `needsReview`
 *      so a human merges later. Advisory; it NEVER blocks the write. Proven in
 *      billing-account-service; copied deliberately rather than reinvented.
 *
 * Conventions: src/services/README.md (errors-as-values, typed inputs, no
 * next/server import, service owns its side effects).
 */
import { Prisma, type CrmCompany } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { recordCrmActivity, diffFields } from "@/crm/lib/crm-activity";

/** Fields worth showing in the change log when an account is edited. */
const COMPANY_DIFF_KEYS = ["name", "industry", "website", "country", "city", "notes", "needsReview"] as const;

// ── Input / Result types ─────────────────────────────────────────────────────

interface CompanyFields {
  name: string;
  industry?: string | null;
  website?: string | null;
  country?: string | null;
  city?: string | null;
  notes?: string | null;
}

export interface FindOrCreateCompanyInput extends CompanyFields {
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "api" | "backfill";
  requestIp?: string;
}

export interface UpdateCompanyInput extends Partial<CompanyFields> {
  companyId: string;
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "api";
  requestIp?: string;
  /** Clear the fuzzy-duplicate flag once a human has confirmed it's distinct. */
  needsReview?: boolean;
}

export type CompanyErrorCode =
  | "NAME_TAKEN"
  | "NAME_REQUIRED"
  | "COMPANY_NOT_FOUND"
  | "COMPANY_ARCHIVED"
  | "NO_FIELDS"
  | "UNKNOWN";

export type FindOrCreateCompanyResult =
  | { ok: true; company: CrmCompany; created: boolean; needsReview: boolean }
  | { ok: false; code: CompanyErrorCode; message: string; meta?: Record<string, unknown> };

export type UpdateCompanyResult =
  | { ok: true; company: CrmCompany }
  | { ok: false; code: CompanyErrorCode; message: string; meta?: Record<string, unknown> };

// ── Name normalization ───────────────────────────────────────────────────────

/**
 * The dedup key: trimmed, lowercased, internal whitespace collapsed.
 *
 * Exported because the backfill script and the tests must derive the SAME key
 * the runtime does — a script computing its key differently from the runtime is
 * how reconciliation jobs end up disagreeing with the system they reconcile
 * (the `holdsRoom()` lesson from the accommodation review: share the predicate,
 * don't re-implement it).
 */
export function companyNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Loose alphanumeric key for NEAR-duplicate detection. "Cleveland Clinic" and
 * "Cleveland Clinic Foundation" reduce to keys where one contains the other.
 */
function fuzzyKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ── Operations ───────────────────────────────────────────────────────────────

/**
 * Find an existing company by exact (normalized) name, else create one.
 *
 * Returns `created: false` when an existing row was reused — callers use this to
 * decide whether to say "linked to Abbott" vs "created Abbott".
 */
export async function findOrCreateCompany(
  input: FindOrCreateCompanyInput,
): Promise<FindOrCreateCompanyResult> {
  const name = input.name?.trim() ?? "";
  if (!name) {
    return { ok: false, code: "NAME_REQUIRED", message: "Company name is required" };
  }

  const nameKey = companyNameKey(name);

  try {
    // 1. Exact match (normalized) → reuse. Never mint a second row for the same
    //    account, and never clobber the existing row's details from a thin
    //    payload — enrich-only, per the AGENTS.md rule.
    const existing = await db.crmCompany.findUnique({
      where: { organizationId_nameKey: { organizationId: input.organizationId, nameKey } },
    });
    if (existing) {
      apiLogger.info({
        msg: "crm-company:reused",
        companyId: existing.id,
        organizationId: input.organizationId,
        source: input.source,
      });
      return { ok: true, company: existing, created: false, needsReview: existing.needsReview };
    }

    // 2. Near-duplicate → still create, but flag for a human. Advisory only.
    const siblings = await db.crmCompany.findMany({
      where: { organizationId: input.organizationId },
      select: { id: true, name: true },
    });
    const fk = fuzzyKey(name);
    const nearMatch = siblings.find((s) => {
      const sk = fuzzyKey(s.name);
      if (!sk || !fk) return false;
      return sk.includes(fk) || fk.includes(sk);
    });

    const company = await db.crmCompany.create({
      data: {
        organizationId: input.organizationId,
        name,
        nameKey,
        industry: input.industry?.trim() || null,
        website: input.website?.trim() || null,
        country: input.country?.trim() || null,
        city: input.city?.trim() || null,
        notes: input.notes?.trim() || null,
        needsReview: Boolean(nearMatch),
      },
    });

    if (nearMatch) {
      apiLogger.warn({
        msg: "crm-company:possible-duplicate",
        companyId: company.id,
        name,
        similarToId: nearMatch.id,
        similarToName: nearMatch.name,
        organizationId: input.organizationId,
      });
    }

    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "COMPANY",
      entityId: company.id,
      action: "CREATE",
      actorId: input.userId,
      changes: {
        source: input.source,
        name,
        needsReview: Boolean(nearMatch),
        ...(nearMatch ? { similarTo: nearMatch.name } : {}),
      },
    });

    apiLogger.info({
      msg: "crm-company:created",
      companyId: company.id,
      organizationId: input.organizationId,
      source: input.source,
    });

    return { ok: true, company, created: true, needsReview: company.needsReview };
  } catch (err) {
    // The unique index is the real dedup guarantee; this is the race branch.
    // Two concurrent creates of "Abbott" — one wins, the loser re-reads and
    // reuses rather than surfacing a 500 for what is semantically a success.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await db.crmCompany.findUnique({
        where: { organizationId_nameKey: { organizationId: input.organizationId, nameKey } },
      });
      if (winner) {
        apiLogger.info({
          msg: "crm-company:create-race-reused",
          companyId: winner.id,
          organizationId: input.organizationId,
        });
        return { ok: true, company: winner, created: false, needsReview: winner.needsReview };
      }
    }
    apiLogger.error({
      msg: "crm-company:create-failed",
      organizationId: input.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not create the company" };
  }
}

export async function updateCompany(input: UpdateCompanyInput): Promise<UpdateCompanyResult> {
  const data: Prisma.CrmCompanyUpdateInput = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) {
      return { ok: false, code: "NAME_REQUIRED", message: "Company name cannot be empty" };
    }
    data.name = name;
    data.nameKey = companyNameKey(name); // keep the dedup key in lockstep with the display name
  }
  if (input.industry !== undefined) data.industry = input.industry?.trim() || null;
  if (input.website !== undefined) data.website = input.website?.trim() || null;
  if (input.country !== undefined) data.country = input.country?.trim() || null;
  if (input.city !== undefined) data.city = input.city?.trim() || null;
  if (input.notes !== undefined) data.notes = input.notes?.trim() || null;
  if (input.needsReview !== undefined) data.needsReview = input.needsReview;

  if (Object.keys(data).length === 0) {
    return { ok: false, code: "NO_FIELDS", message: "No fields to update" };
  }

  try {
    // Snapshot before the write for a real before→after log. Bind the row to the
    // caller's org — a company id from a request body is untrusted input, and an
    // unbound update is this codebase's most repeated IDOR (accommodation + contacts).
    const before = await db.crmCompany.findFirst({
      where: { id: input.companyId, organizationId: input.organizationId },
      select: { name: true, industry: true, website: true, country: true, city: true, notes: true, needsReview: true, archivedAt: true },
    });
    if (!before) {
      apiLogger.warn({
        msg: "crm-company:update-not-found",
        companyId: input.companyId,
        organizationId: input.organizationId,
      });
      return { ok: false, code: "COMPANY_NOT_FOUND", message: "Company not found" };
    }
    // An archived account is FROZEN (R2-M1) — restore before editing.
    if (before.archivedAt) {
      apiLogger.warn({ msg: "crm-company:update-archived", companyId: input.companyId });
      return { ok: false, code: "COMPANY_ARCHIVED", message: "This company was archived — restore it before editing it" };
    }

    const res = await db.crmCompany.updateMany({
      // archivedAt re-checked IN the write — the snapshot guard has a race window.
      where: { id: input.companyId, organizationId: input.organizationId, archivedAt: null },
      data,
    });
    if (res.count === 0) {
      apiLogger.warn({ msg: "crm-company:update-archived-race", companyId: input.companyId });
      return { ok: false, code: "COMPANY_ARCHIVED", message: "This company was archived — restore it before editing it" };
    }

    const company = await db.crmCompany.findUniqueOrThrow({ where: { id: input.companyId } });

    // Diff BEFORE + the submitted patch — NOT the post-write re-read (CRM review
    // M4): a concurrent writer landing between our write and a re-read would have
    // ITS change recorded under THIS actor's name in the History log. The patch
    // is what this actor actually did; diff exactly that.
    const fieldChanges = diffFields(before, { ...before, ...data } as typeof before, COMPANY_DIFF_KEYS);
    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "COMPANY",
      entityId: company.id,
      action: "UPDATE",
      actorId: input.userId,
      changes: { source: input.source, ...(fieldChanges ? { changes: fieldChanges } : {}) },
    });

    apiLogger.info({ msg: "crm-company:updated", companyId: company.id, source: input.source });
    return { ok: true, company };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // A rename collision is an ordinary user action, not a server fault —
      // as UNKNOWN it surfaced as an unlogged HTTP 500 (CRM review H4).
      apiLogger.warn({ msg: "crm-company:update-name-taken", companyId: input.companyId, organizationId: input.organizationId });
      return {
        ok: false,
        code: "NAME_TAKEN",
        message: "Another company already uses that name",
        meta: { conflict: "name" },
      };
    }
    apiLogger.error({
      msg: "crm-company:update-failed",
      companyId: input.companyId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not update the company" };
  }
}

// ── Archive / restore (soft delete) ──────────────────────────────────────────

/**
 * Archive or restore an account (soft delete). Idempotent — a no-op state change
 * records nothing. RBAC is enforced at the route boundary.
 *
 * NOTE: archiving a company does NOT touch its deals (they keep resolving the row,
 * which still exists). This is intentional — a reversible hide, not a cascade. The
 * `Restrict` FK that blocks a hard delete is therefore irrelevant here.
 */
export async function setCompanyArchived(input: {
  companyId: string;
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "api";
  archived: boolean;
}): Promise<{ ok: true; company: CrmCompany } | { ok: false; code: CompanyErrorCode; message: string }> {
  try {
    const current = await db.crmCompany.findFirst({
      where: { id: input.companyId, organizationId: input.organizationId },
    });
    if (!current) {
      apiLogger.warn({ msg: "crm-company:archive-not-found", companyId: input.companyId, organizationId: input.organizationId });
      return { ok: false, code: "COMPANY_NOT_FOUND", message: "Company not found" };
    }

    // Conditional claim (R2-M2) — see setDealArchived: the loser of two
    // concurrent archives (or an already-in-state call) is the idempotent no-op.
    const claim = await db.crmCompany.updateMany({
      where: {
        id: current.id,
        organizationId: input.organizationId,
        archivedAt: input.archived ? null : { not: null },
      },
      data: { archivedAt: input.archived ? new Date() : null },
    });
    if (claim.count === 0) {
      const now = await db.crmCompany.findFirst({ where: { id: current.id } });
      return { ok: true, company: now ?? current };
    }

    const company = await db.crmCompany.findUniqueOrThrow({ where: { id: current.id } });

    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "COMPANY",
      entityId: company.id,
      action: input.archived ? "ARCHIVE" : "RESTORE",
      actorId: input.userId,
      changes: { source: input.source, name: company.name },
    });

    apiLogger.info({
      msg: input.archived ? "crm-company:archived" : "crm-company:restored",
      companyId: company.id,
      source: input.source,
    });
    return { ok: true, company };
  } catch (err) {
    apiLogger.error({
      msg: "crm-company:archive-failed",
      companyId: input.companyId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not archive the company" };
  }
}
