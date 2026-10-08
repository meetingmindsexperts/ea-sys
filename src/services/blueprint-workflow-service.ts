/**
 * Event Blueprint workflow: the server owns every status change
 * (docs/EVENT_BLUEPRINT_PLAN.md §4.4, step 5). The page can ask; it can never
 * write a status, a reference or a history row itself (the storage PUT strips
 * them).
 *
 * The stages and who moves them (owner ruling, Oct 8, 2026):
 *
 *   Draft      -- submit (a writer) -->               Submitted
 *   Submitted  <-- build team (blueprints.manage) --> In review <--> Plan ready
 *   Plan ready -- APPROVE the plan (an approver) -->  Building   (creates the event, step 6)
 *   Building   <-- build team -->                     Preview
 *   Preview    -- APPROVE the preview (approver) -->  Live       (step 6)
 *
 * Building and Live are reached only by approval, never by a stage move.
 * Each change is a guarded update (`where status = from`) so two people
 * acting at once cannot both win, written in one transaction with its
 * BlueprintStatusLog row. Emails go after the commit and never undo it.
 */
import { Prisma, type BlueprintStatus } from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { sendEmail } from "@/lib/email";
import { appBaseUrl } from "@/lib/build-info";
import { isCustomRolesEnabled } from "@/lib/module-flags";
import { SYSTEM_ROLES } from "@/lib/permissions/system-roles";
import { buildBlueprintEmail, type BlueprintEmailInput } from "@/lib/blueprint/blueprint-emails";
import { BLUEPRINT_ID_RE } from "@/lib/blueprint/blueprint-payload";
import { getBlueprint } from "./blueprint-service";

export type WorkflowErrorCode = "INVALID_ID" | "NOT_FOUND" | "NOT_ALLOWED_FROM_STAGE" | "CONFLICT";

type Fail = { ok: false; code: WorkflowErrorCode; message: string };
export type WorkflowResult = { ok: true; blueprint: Record<string, unknown> } | Fail;

interface Caller {
  organizationId: string;
  userId: string;
}

/** The moves a build-team member may make; Building and Live come only from approval. */
const STAGE_MOVES: Partial<Record<BlueprintStatus, readonly BlueprintStatus[]>> = {
  SUBMITTED: ["IN_REVIEW"],
  IN_REVIEW: ["SUBMITTED", "PLAN_READY"],
  PLAN_READY: ["IN_REVIEW"],
  BUILDING: ["PREVIEW"],
  PREVIEW: ["BUILDING"],
};

export const STAGE_LABEL: Record<BlueprintStatus, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  IN_REVIEW: "In review",
  PLAN_READY: "Plan ready",
  BUILDING: "Building",
  PREVIEW: "Preview",
  LIVE: "Live",
};

const REF_ATTEMPTS = 5;

function fail(code: WorkflowErrorCode, message: string, ctx: Record<string, unknown>): Fail {
  apiLogger.warn({ msg: "blueprint-workflow:refused", code, ...ctx });
  return { ok: false, code, message };
}

/** `EB-261008-K3P`: the page's own reference format, minted here. */
export function makeRef(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase().padEnd(3, "X");
  return `EB-${String(now.getFullYear()).slice(2)}${p(now.getMonth() + 1)}${p(now.getDate())}-${rand}`;
}

// ── Submit ───────────────────────────────────────────────────────────────────

export interface SubmitInput {
  /** The page's readiness and open items at submission: a record, never trusted for approval. */
  readiness: number;
  open: string[];
  /** A re-submission: how many changes, and their one-line descriptions. */
  count: number;
  changes: string[];
}

/**
 * First submission: Draft to Submitted, a reference minted, the build team
 * emailed. Any later submission is an UPDATE: the status stays where it is,
 * the change list is logged and the build team emailed again.
 */
export async function submitBlueprint(caller: Caller, id: string, input: SubmitInput): Promise<WorkflowResult> {
  const ctx = { organizationId: caller.organizationId, userId: caller.userId, id };
  if (!BLUEPRINT_ID_RE.test(id)) return fail("INVALID_ID", "Not a blueprint id", ctx);

  const outcome = await runWithTenant(caller.organizationId, async () => {
    const row = await db.blueprint.findFirst({
      where: { id, organizationId: caller.organizationId, archivedAt: null },
      select: { status: true, ref: true, title: true },
    });
    if (!row) return { kind: "missing" as const };
    if (row.status === "DRAFT") return firstSubmit(caller, id, input);
    await tenantTransaction((tx) =>
      tx.blueprintStatusLog.create({
        data: {
          blueprintId: id,
          organizationId: caller.organizationId,
          actorId: caller.userId,
          kind: "UPDATE",
          detail: { count: input.count, changes: input.changes },
        },
      }),
    );
    return { kind: "update" as const, ref: row.ref ?? "", title: row.title };
  });

  if (outcome.kind === "missing") return fail("NOT_FOUND", "Blueprint not found", ctx);
  if (outcome.kind === "conflict") return fail("CONFLICT", "Someone else changed this blueprint; reload it", ctx);
  apiLogger.info({ msg: `blueprint-workflow:${outcome.kind}`, ...ctx, ref: outcome.ref });

  await notifyBuildTeam(caller, {
    kind: outcome.kind === "update" ? "update" : "submitted",
    title: outcome.title,
    ref: outcome.ref,
    readiness: input.readiness,
    openCount: input.open.length,
    changeCount: input.count,
  });
  return reload(caller.organizationId, id);
}

type FirstSubmitOutcome = { kind: "submitted"; ref: string; title: string } | { kind: "conflict" };

async function firstSubmit(caller: Caller, id: string, input: SubmitInput): Promise<FirstSubmitOutcome> {
  for (let attempt = 1; ; attempt++) {
    const ref = makeRef();
    try {
      return await tenantTransaction(async (tx) => {
        const moved = await tx.blueprint.updateMany({
          where: { id, organizationId: caller.organizationId, status: "DRAFT" },
          data: { status: "SUBMITTED", ref, submittedAt: new Date(), readiness: input.readiness },
        });
        if (moved.count === 0) return { kind: "conflict" as const };
        await tx.blueprintStatusLog.create({
          data: {
            blueprintId: id,
            organizationId: caller.organizationId,
            actorId: caller.userId,
            kind: "SUBMITTED",
            fromStatus: "DRAFT",
            toStatus: "SUBMITTED",
            readiness: input.readiness,
            detail: { open: input.open },
          },
        });
        const row = await tx.blueprint.findUniqueOrThrow({ where: { id }, select: { title: true } });
        return { kind: "submitted" as const, ref, title: row.title };
      });
    } catch (err) {
      // A reference already used in this organisation: mint another.
      const clash = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
      if (!clash || attempt >= REF_ATTEMPTS) throw err;
    }
  }
}

// ── Stage moves ──────────────────────────────────────────────────────────────

/** A build-team move between the non-approval stages; the writer is emailed. */
export async function moveBlueprintStage(caller: Caller, id: string, to: BlueprintStatus): Promise<WorkflowResult> {
  const ctx = { organizationId: caller.organizationId, userId: caller.userId, id, to };
  if (!BLUEPRINT_ID_RE.test(id)) return fail("INVALID_ID", "Not a blueprint id", ctx);

  const outcome = await runWithTenant(caller.organizationId, async () => {
    const row = await db.blueprint.findFirst({
      where: { id, organizationId: caller.organizationId, archivedAt: null },
      select: { status: true, ref: true, title: true, ownerId: true },
    });
    if (!row) return { kind: "missing" as const };
    if (!(STAGE_MOVES[row.status] ?? []).includes(to)) return { kind: "refused" as const, from: row.status };
    const moved = await tenantTransaction(async (tx) => {
      const res = await tx.blueprint.updateMany({
        where: { id, organizationId: caller.organizationId, status: row.status },
        data: { status: to },
      });
      if (res.count === 0) return false;
      await tx.blueprintStatusLog.create({
        data: { blueprintId: id, organizationId: caller.organizationId, actorId: caller.userId, kind: "STAGE", fromStatus: row.status, toStatus: to },
      });
      return true;
    });
    return moved ? { kind: "moved" as const, row } : { kind: "conflict" as const };
  });

  if (outcome.kind === "missing") return fail("NOT_FOUND", "Blueprint not found", ctx);
  if (outcome.kind === "conflict") return fail("CONFLICT", "Someone else changed this blueprint; reload it", ctx);
  if (outcome.kind === "refused") {
    return fail("NOT_ALLOWED_FROM_STAGE", `A blueprint cannot move from ${STAGE_LABEL[outcome.from]} to ${STAGE_LABEL[to]}`, { ...ctx, from: outcome.from });
  }
  apiLogger.info({ msg: "blueprint-workflow:stage-moved", ...ctx, from: outcome.row.status });

  await notifyWriter(caller, outcome.row.ownerId, {
    kind: "stage",
    title: outcome.row.title,
    ref: outcome.row.ref ?? "",
    stageLabel: STAGE_LABEL[to],
  });
  return reload(caller.organizationId, id);
}

// ── Notifications ────────────────────────────────────────────────────────────

type EmailFacts = Omit<BlueprintEmailInput, "recipientName" | "actorName" | "link">;

/** Base roles whose built-in grants include `blueprints.manage`. */
const MANAGE_ROLES = Object.values(SYSTEM_ROLES)
  .filter((r) => r.baseRole && r.grants.some((g) => g.permission === "blueprints.manage"))
  .map((r) => r.baseRole as string);

/** The build team: active staff whose role, or a custom role they hold, grants `blueprints.manage`. */
async function buildTeam(organizationId: string): Promise<{ id: string; email: string; firstName: string }[]> {
  return runWithTenant(organizationId, () =>
    db.user.findMany({
      where: {
        organizationId,
        deactivatedAt: null,
        OR: [
          { role: { in: MANAGE_ROLES as never[] } },
          ...(isCustomRolesEnabled()
            ? [{ permissionSets: { some: { permissionSet: { archivedAt: null, permissions: { some: { permission: "blueprints.manage" } } } } } }]
            : []),
        ],
      },
      select: { id: true, email: true, firstName: true },
    }),
  );
}

async function actorName(organizationId: string, userId: string): Promise<string> {
  const u = await runWithTenant(organizationId, () =>
    db.user.findFirst({ where: { id: userId }, select: { firstName: true, lastName: true } }),
  );
  return u ? `${u.firstName} ${u.lastName}`.trim() : "A colleague";
}

async function send(to: { id: string; email: string; firstName: string }, facts: EmailFacts, actor: string, ctx: Record<string, unknown>) {
  const mail = buildBlueprintEmail({ ...facts, recipientName: to.firstName, actorName: actor, link: `${appBaseUrl()}/blueprint` });
  try {
    const res = await sendEmail({ to: [{ email: to.email, name: to.firstName }], subject: mail.subject, htmlContent: mail.html, textContent: mail.text });
    if (!res.success) apiLogger.error({ msg: "blueprint-workflow:email-failed", ...ctx, kind: facts.kind, recipientId: to.id, error: res.error, code: res.code });
  } catch (err) {
    apiLogger.error({ msg: "blueprint-workflow:email-failed", ...ctx, kind: facts.kind, recipientId: to.id, err });
  }
}

async function notifyBuildTeam(caller: Caller, facts: EmailFacts): Promise<void> {
  const ctx = { organizationId: caller.organizationId, userId: caller.userId, ref: facts.ref };
  try {
    const [team, actor] = await Promise.all([buildTeam(caller.organizationId), actorName(caller.organizationId, caller.userId)]);
    const recipients = team.filter((u) => u.id !== caller.userId);
    if (recipients.length === 0) apiLogger.warn({ msg: "blueprint-workflow:no-build-team", ...ctx });
    await Promise.all(recipients.map((u) => send(u, facts, actor, ctx)));
  } catch (err) {
    apiLogger.error({ msg: "blueprint-workflow:notify-failed", ...ctx, err });
  }
}

async function notifyWriter(caller: Caller, ownerId: string | null, facts: EmailFacts): Promise<void> {
  const ctx = { organizationId: caller.organizationId, userId: caller.userId, ref: facts.ref };
  if (!ownerId || ownerId === caller.userId) return;
  try {
    const [owner, actor] = await Promise.all([
      runWithTenant(caller.organizationId, () =>
        db.user.findFirst({ where: { id: ownerId, deactivatedAt: null }, select: { id: true, email: true, firstName: true } }),
      ),
      actorName(caller.organizationId, caller.userId),
    ]);
    if (!owner) {
      apiLogger.warn({ msg: "blueprint-workflow:writer-gone", ...ctx, ownerId });
      return;
    }
    await send(owner, facts, actor, ctx);
  } catch (err) {
    apiLogger.error({ msg: "blueprint-workflow:notify-failed", ...ctx, err });
  }
}

async function reload(organizationId: string, id: string): Promise<WorkflowResult> {
  const res = await getBlueprint(organizationId, id);
  if (!res.ok) return { ok: false, code: "NOT_FOUND", message: res.message };
  return { ok: true, blueprint: res.blueprint };
}
