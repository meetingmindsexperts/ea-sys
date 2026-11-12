/**
 * CORPORATE PROJECTS (Nov 12, 2026). SERVER ONLY.
 *
 * A corporate project is work the sales team sells that is not an event in
 * EA-SYS: a client's own meeting, an advisory board, an experts tour. A deal
 * is for an event OR a project (deal-service.ts, deal-attribution.ts). Anyone
 * who may create deals may create a project (owner).
 *
 * THE EVENT LINK. `eventId` is set only to correct a duplicate or a mistake:
 * a project made for something that was already an event or a webinar. Its
 * deals then count under that event wherever deals are counted per event
 * (deal-attribution.ts). Nothing is moved, so clearing the link puts them
 * back. Because it moves money between an event's figures and none, the link
 * is audited inside the same transaction as the change (crm-audit.ts).
 *
 * Errors as values; already-typed inputs (the route turns a YYYY-MM-DD string
 * into a UTC-midnight Date); never imports next/server (services/README.md).
 * Runs inside the caller's tenant lane.
 */
import { Prisma, type CrmProject } from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { crmEvents } from "@/crm/integrations/events";
import { writeCrmAudit } from "@/crm/lib/crm-audit";
import { mayOwnCrmRecords } from "@/crm/services/crm-owner-eligibility";

export interface ProjectFields {
  name: string;
  companyId?: string | null;
  /** Calendar days, as UTC midnight. */
  startDate?: Date | null;
  endDate?: Date | null;
  location?: string | null;
  ownerId?: string | null;
  /** The event this project duplicates. Only ever a correction: see the header. */
  eventId?: string | null;
}

interface Caller {
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "agent" | "api";
}

export type CreateProjectInput = ProjectFields & Caller;
export type UpdateProjectInput = Partial<ProjectFields> & Caller & { projectId: string };

export type ProjectErrorCode =
  | "NAME_REQUIRED"
  | "NAME_TAKEN"
  | "DATES_OUT_OF_ORDER"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_ARCHIVED"
  | "COMPANY_NOT_FOUND"
  | "COMPANY_ARCHIVED"
  | "EVENT_NOT_FOUND"
  | "OWNER_NOT_FOUND"
  | "OWNER_ROLE_NOT_ALLOWED"
  | "NO_FIELDS"
  | "UNKNOWN";

type Fail = { ok: false; code: ProjectErrorCode; message: string; meta?: Record<string, unknown> };
export type ProjectResult = { ok: true; project: CrmProject } | Fail;

/** The dedup key: trimmed, lowercased, inner spaces collapsed (the same rule as an account's). */
export function projectNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function nameTaken(existingId?: string): Fail {
  return {
    ok: false,
    code: "NAME_TAKEN",
    message: "A corporate project with that name already exists",
    ...(existingId ? { meta: { existingProjectId: existingId } } : {}),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Every id on a project arrives from the client and is bound to the caller's
 * organisation before it is written. An id left undefined is not checked:
 * updateProject passes only the ids that changed, so a project stays editable
 * after its account was archived.
 */
async function validateRelations(
  organizationId: string,
  rel: { companyId?: string | null; ownerId?: string | null; eventId?: string | null },
): Promise<Fail | null> {
  const checks: Array<Promise<Fail | null>> = [];
  if (rel.companyId) {
    checks.push(
      db.crmCompany.findFirst({ where: { id: rel.companyId, organizationId }, select: { archivedAt: true } }).then((r) => {
        if (!r) return { ok: false, code: "COMPANY_NOT_FOUND", message: "Account not found" } as Fail;
        if (r.archivedAt) return { ok: false, code: "COMPANY_ARCHIVED", message: "That account is archived. Restore it from the CRM's Archive view first." } as Fail;
        return null;
      }),
    );
  }
  if (rel.eventId) {
    checks.push(
      crmEvents
        .belongsTo(organizationId, rel.eventId)
        .then((found) => (found ? null : ({ ok: false, code: "EVENT_NOT_FOUND", message: "Event not found" } as Fail))),
    );
  }
  if (rel.ownerId) {
    checks.push(
      db.user.findFirst({ where: { id: rel.ownerId, organizationId }, select: { id: true, role: true } }).then(async (r) => {
        if (!r) return { ok: false, code: "OWNER_NOT_FOUND", message: "Owner not found in this organization" } as Fail;
        if (await mayOwnCrmRecords(organizationId, r)) return null;
        return {
          ok: false,
          code: "OWNER_ROLE_NOT_ALLOWED",
          message: "A project can only be owned by CRM-capable roles (admin, organizer or sales)",
          meta: { role: r.role },
        } as Fail;
      }),
    );
  }
  const results = await Promise.all(checks);
  return results.find((r) => r !== null) ?? null;
}

function datesOutOfOrder(start: Date | null | undefined, end: Date | null | undefined): Fail | null {
  if (!start || !end || end.getTime() >= start.getTime()) return null;
  return { ok: false, code: "DATES_OUT_OF_ORDER", message: "The end date is before the start date" };
}

function cleanText(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

// ── Create ───────────────────────────────────────────────────────────────────

export async function createProject(input: CreateProjectInput): Promise<ProjectResult> {
  const name = input.name?.trim() ?? "";
  if (!name) return { ok: false, code: "NAME_REQUIRED", message: "Project name is required" };
  const dateFail = datesOutOfOrder(input.startDate, input.endDate);
  if (dateFail) return dateFail;

  const relFail = await validateRelations(input.organizationId, input);
  if (relFail) {
    apiLogger.warn({ msg: "crm-project:create-bad-relation", code: relFail.code, organizationId: input.organizationId });
    return relFail;
  }

  const nameKey = projectNameKey(name);
  try {
    // Archived projects keep their name: restoring one must not collide later.
    const existing = await db.crmProject.findFirst({ where: { organizationId: input.organizationId, nameKey }, select: { id: true } });
    if (existing) {
      apiLogger.warn({ msg: "crm-project:create-name-taken", organizationId: input.organizationId, existingProjectId: existing.id });
      return nameTaken(existing.id);
    }
    const project = await tenantTransaction(async (tx) => {
      const row = await tx.crmProject.create({
        data: {
          organizationId: input.organizationId,
          name,
          nameKey,
          companyId: input.companyId ?? null,
          startDate: input.startDate ?? null,
          endDate: input.endDate ?? null,
          location: cleanText(input.location),
          ownerId: input.ownerId ?? null,
          eventId: input.eventId ?? null,
        },
      });
      await writeCrmAudit(tx, {
        organizationId: input.organizationId,
        actorId: input.userId,
        action: "CRM_PROJECT_CREATED",
        entityType: "CrmProject",
        entityId: row.id,
        changes: { source: input.source, name, eventId: row.eventId },
      });
      return row;
    });
    apiLogger.info({ msg: "crm-project:created", projectId: project.id, organizationId: input.organizationId, source: input.source });
    return { ok: true, project };
  } catch (err) {
    // Two people creating the same name at once: the unique index decides.
    if (isUniqueViolation(err)) {
      apiLogger.warn({ msg: "crm-project:create-name-taken-race", organizationId: input.organizationId });
      return nameTaken();
    }
    apiLogger.error({ msg: "crm-project:create-failed", organizationId: input.organizationId, err: err instanceof Error ? err.message : String(err) });
    return { ok: false, code: "UNKNOWN", message: "Could not create the project" };
  }
}

// ── Update ───────────────────────────────────────────────────────────────────

export async function updateProject(input: UpdateProjectInput): Promise<ProjectResult> {
  const data: Prisma.CrmProjectUncheckedUpdateManyInput = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return { ok: false, code: "NAME_REQUIRED", message: "Project name cannot be empty" };
    data.name = name;
    data.nameKey = projectNameKey(name);
  }
  if (input.companyId !== undefined) data.companyId = input.companyId;
  if (input.startDate !== undefined) data.startDate = input.startDate;
  if (input.endDate !== undefined) data.endDate = input.endDate;
  if (input.location !== undefined) data.location = cleanText(input.location);
  if (input.ownerId !== undefined) data.ownerId = input.ownerId;
  if (input.eventId !== undefined) data.eventId = input.eventId;
  if (Object.keys(data).length === 0) return { ok: false, code: "NO_FIELDS", message: "No fields to update" };

  try {
    const before = await db.crmProject.findFirst({ where: { id: input.projectId, organizationId: input.organizationId } });
    if (!before) {
      apiLogger.warn({ msg: "crm-project:update-not-found", projectId: input.projectId, organizationId: input.organizationId });
      return { ok: false, code: "PROJECT_NOT_FOUND", message: "Corporate project not found" };
    }
    if (before.archivedAt) {
      apiLogger.warn({ msg: "crm-project:update-archived", projectId: input.projectId });
      return { ok: false, code: "PROJECT_ARCHIVED", message: "This project was archived. Restore it before editing it." };
    }
    const start = input.startDate === undefined ? before.startDate : input.startDate;
    const end = input.endDate === undefined ? before.endDate : input.endDate;
    const dateFail = datesOutOfOrder(start, end);
    if (dateFail) return dateFail;

    // Only the ids that CHANGED are checked: the edit form re-sends them all.
    const relFail = await validateRelations(input.organizationId, {
      companyId: input.companyId !== before.companyId ? input.companyId : undefined,
      ownerId: input.ownerId !== before.ownerId ? input.ownerId : undefined,
      eventId: input.eventId !== before.eventId ? input.eventId : undefined,
    });
    if (relFail) {
      apiLogger.warn({ msg: "crm-project:update-bad-relation", code: relFail.code, projectId: input.projectId });
      return relFail;
    }
    if (data.nameKey && data.nameKey !== before.nameKey) {
      const clash = await db.crmProject.findFirst({
        where: { organizationId: input.organizationId, nameKey: data.nameKey as string, id: { not: before.id } },
        select: { id: true },
      });
      if (clash) {
        apiLogger.warn({ msg: "crm-project:update-name-taken", projectId: input.projectId, existingProjectId: clash.id });
        return nameTaken(clash.id);
      }
    }

    const linkChanged = input.eventId !== undefined && (input.eventId ?? null) !== before.eventId;
    const written = await tenantTransaction(async (tx) => {
      // archivedAt: null re-checked in the write: the read above races an archive.
      const claim = await tx.crmProject.updateMany({
        where: { id: before.id, organizationId: input.organizationId, archivedAt: null },
        data,
      });
      if (claim.count === 0) return false;
      await writeCrmAudit(tx, {
        organizationId: input.organizationId,
        actorId: input.userId,
        action: linkChanged ? "CRM_PROJECT_EVENT_LINK_CHANGED" : "CRM_PROJECT_UPDATED",
        entityType: "CrmProject",
        entityId: before.id,
        changes: {
          source: input.source,
          fields: Object.keys(data).filter((k) => k !== "nameKey"),
          ...(linkChanged ? { eventId: { from: before.eventId, to: input.eventId ?? null } } : {}),
        },
      });
      return true;
    });
    if (!written) {
      apiLogger.warn({ msg: "crm-project:update-archived-race", projectId: input.projectId });
      return { ok: false, code: "PROJECT_ARCHIVED", message: "This project was archived. Restore it before editing it." };
    }
    const project = await db.crmProject.findFirstOrThrow({ where: { id: before.id, organizationId: input.organizationId } });
    apiLogger.info({
      msg: linkChanged ? "crm-project:event-link-changed" : "crm-project:updated",
      projectId: project.id,
      organizationId: input.organizationId,
      source: input.source,
      ...(linkChanged ? { fromEventId: before.eventId, toEventId: project.eventId } : {}),
    });
    return { ok: true, project };
  } catch (err) {
    if (isUniqueViolation(err)) {
      apiLogger.warn({ msg: "crm-project:update-name-taken-race", projectId: input.projectId });
      return nameTaken();
    }
    apiLogger.error({ msg: "crm-project:update-failed", projectId: input.projectId, err: err instanceof Error ? err.message : String(err) });
    return { ok: false, code: "UNKNOWN", message: "Could not update the project" };
  }
}

// ── Archive / restore ────────────────────────────────────────────────────────

/**
 * Archive hides a project from the picker and the Projects list. Its deals are
 * untouched: they stay on the board and in every report under its name, so
 * archiving a finished project never changes a total.
 */
export async function setProjectArchived(input: Caller & { projectId: string; archived: boolean }): Promise<ProjectResult> {
  try {
    const before = await db.crmProject.findFirst({
      where: { id: input.projectId, organizationId: input.organizationId },
      select: { id: true, archivedAt: true },
    });
    if (!before) {
      apiLogger.warn({ msg: "crm-project:archive-not-found", projectId: input.projectId, organizationId: input.organizationId });
      return { ok: false, code: "PROJECT_NOT_FOUND", message: "Corporate project not found" };
    }
    if (!!before.archivedAt !== input.archived) {
      await tenantTransaction(async (tx) => {
        await tx.crmProject.updateMany({
          where: { id: before.id, organizationId: input.organizationId },
          data: { archivedAt: input.archived ? new Date() : null },
        });
        await writeCrmAudit(tx, {
          organizationId: input.organizationId,
          actorId: input.userId,
          action: input.archived ? "CRM_PROJECT_ARCHIVED" : "CRM_PROJECT_RESTORED",
          entityType: "CrmProject",
          entityId: before.id,
          changes: { source: input.source },
        });
      });
      apiLogger.info({ msg: input.archived ? "crm-project:archived" : "crm-project:restored", projectId: before.id, source: input.source });
    }
    const project = await db.crmProject.findFirstOrThrow({ where: { id: before.id, organizationId: input.organizationId } });
    return { ok: true, project };
  } catch (err) {
    apiLogger.error({ msg: "crm-project:archive-failed", projectId: input.projectId, err: err instanceof Error ? err.message : String(err) });
    return { ok: false, code: "UNKNOWN", message: "Could not archive the project" };
  }
}
