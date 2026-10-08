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
import { scoreBlueprint, readWhen } from "@/lib/blueprint/vendor-rules";
import { planEventFromBlueprint, type EventPlan } from "@/lib/blueprint/blueprint-to-event";
import { resolveTimezone } from "@/lib/event-time";
import { getBlueprint } from "./blueprint-service";
import { createEvent } from "./event-service";
import { createSession } from "./session-service";
import { saveSponsors } from "./sponsor-service";

export type WorkflowErrorCode =
  | "INVALID_ID"
  | "NOT_FOUND"
  | "NOT_ALLOWED_FROM_STAGE"
  | "CONFLICT"
  | "APPROVER_IS_AUTHOR"
  | "BLUEPRINT_INCOMPLETE"
  | "DATES_NEEDED"
  | "EVENT_CREATE_FAILED"
  | "STALE_VERSION"
  | "OUT_OF_SCOPE";

type Fail = { ok: false; code: WorkflowErrorCode; message: string; meta?: Record<string, unknown> };
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

/**
 * A claim with no event after this long is a crashed approval (a deploy or a
 * restart mid-request) and may be taken again (review M3). Creating an event
 * takes seconds, so ten minutes never steals a live one.
 */
export const STALE_CLAIM_MS = 10 * 60_000;

function fail(code: WorkflowErrorCode, message: string, ctx: Record<string, unknown>, meta?: Record<string, unknown>): Fail {
  apiLogger.warn({ msg: "blueprint-workflow:refused", code, ...ctx, ...meta });
  return { ok: false, code, message, ...(meta && { meta }) };
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

// ── Approval (step 6) ────────────────────────────────────────────────────────

export type ApproveWhich = "plan" | "preview";

/**
 * An approver signs off (owner ruling, Oct 8, 2026): the PLAN at Plan ready,
 * which runs the vendor's completeness rules on the server and creates the
 * EA-SYS event (DRAFT) with its sessions and sponsors, then Building; the
 * PREVIEW at Preview, then Live. Never the blueprint's writer or anyone who
 * edited it after it was submitted (`editorIds`).
 *
 * One event, ever. The approval is CLAIMED first with a guarded write
 * (`approvedAt` set where it was null), so two approvers at once cannot both
 * create an event; if anything fails before the event is recorded on the
 * blueprint the claim is released. Approving an already-approved plan returns
 * the blueprint as it is.
 */
export interface ApproveOptions {
  /** The version the approver was looking at (review M4): refused if it changed since. */
  version: number;
  /**
   * May this approver create an event of this type? The route builds it from
   * `can(principal, "events.create")` with the resulting type, the dashboard's
   * own check (review L10), so a webinar-only role cannot approve a conference.
   */
  mayCreateEvent: (eventType: string | null) => boolean;
}

export async function approveBlueprint(caller: Caller, id: string, which: ApproveWhich, opts: ApproveOptions): Promise<WorkflowResult> {
  const ctx = { organizationId: caller.organizationId, userId: caller.userId, id, which };
  if (!BLUEPRINT_ID_RE.test(id)) return fail("INVALID_ID", "Not a blueprint id", ctx);

  const row = await runWithTenant(caller.organizationId, () =>
    db.blueprint.findFirst({
      where: { id, organizationId: caller.organizationId, archivedAt: null },
      select: { status: true, ref: true, title: true, ownerId: true, editorIds: true, eventId: true, data: true, updatedAt: true },
    }),
  );
  if (!row) return fail("NOT_FOUND", "Blueprint not found", ctx);
  if (which === "plan" && row.eventId) return reload(caller.organizationId, id);
  if (row.updatedAt.getTime() !== opts.version) {
    return fail("STALE_VERSION", "This blueprint changed since you opened it. Reload and read it again before approving.", { ...ctx, sent: opts.version, current: row.updatedAt.getTime() });
  }
  if (row.ownerId === caller.userId || row.editorIds.includes(caller.userId)) {
    return fail("APPROVER_IS_AUTHOR", "You wrote or edited this blueprint, so someone else has to approve it.", ctx);
  }
  const needed = which === "plan" ? "PLAN_READY" : "PREVIEW";
  if (row.status !== needed) {
    return fail("NOT_ALLOWED_FROM_STAGE", `The ${which} can be approved only at ${STAGE_LABEL[needed]}; this blueprint is at ${STAGE_LABEL[row.status]}.`, ctx);
  }

  const result = which === "plan" ? await approvePlan(caller, id, row.data, opts, ctx) : await approvePreview(caller, id, ctx);
  if (!result.ok) return result;
  apiLogger.info({ msg: "blueprint-workflow:approved", ...ctx, eventId: result.eventId ?? null });
  await notifyWriter(caller, row.ownerId, {
    kind: "approved",
    title: row.title,
    ref: row.ref ?? "",
    stageLabel: STAGE_LABEL[which === "plan" ? "BUILDING" : "LIVE"],
  });
  return reload(caller.organizationId, id);
}

type Approved = { ok: true; eventId?: string } | Fail;

async function approvePreview(caller: Caller, id: string, ctx: Record<string, unknown>): Promise<Approved> {
  const moved = await runWithTenant(caller.organizationId, () =>
    tenantTransaction(async (tx) => {
      const res = await tx.blueprint.updateMany({
        where: { id, organizationId: caller.organizationId, status: "PREVIEW" },
        data: { status: "LIVE" },
      });
      if (res.count === 0) return false;
      await tx.blueprintStatusLog.create({
        data: { blueprintId: id, organizationId: caller.organizationId, actorId: caller.userId, kind: "APPROVED", fromStatus: "PREVIEW", toStatus: "LIVE", detail: { which: "preview" } },
      });
      return true;
    }),
  );
  return moved ? { ok: true } : fail("CONFLICT", "Someone else changed this blueprint; reload it", ctx);
}

async function approvePlan(caller: Caller, id: string, stored: unknown, opts: ApproveOptions, ctx: Record<string, unknown>): Promise<Approved> {
  const scored = scoreBlueprint(stored);
  if (scored.blocking.length > 0) {
    return fail(
      "BLUEPRINT_INCOMPLETE",
      `${scored.blocking.length} needed item${scored.blocking.length === 1 ? " is" : "s are"} still open, so it cannot be approved yet.`,
      ctx,
      { missing: scored.blocking.map((b) => b.label) },
    );
  }
  const planned = planEventFromBlueprint(scored.data, readWhen(String((scored.data.basics as { when?: unknown })?.when ?? "")), resolveTimezone(null));
  if (!planned.ok) return fail(planned.code, planned.message, ctx);
  if (!opts.mayCreateEvent(planned.plan.event.eventType)) {
    return fail("OUT_OF_SCOPE", "Your role cannot create an event of this kind, so it cannot approve this plan.", { ...ctx, eventType: planned.plan.event.eventType });
  }

  // Claim first: only one approver gets past this line.
  const claimed = await runWithTenant(caller.organizationId, () =>
    db.blueprint.updateMany({
      where: {
        id,
        organizationId: caller.organizationId,
        status: "PLAN_READY",
        eventId: null,
        OR: [{ approvedAt: null }, { approvedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) } }],
      },
      data: { approvedAt: new Date(), approvedById: caller.userId },
    }),
  );
  if (claimed.count === 0) return fail("CONFLICT", "Someone else is approving or has changed this blueprint; reload it", ctx);

  let created: Awaited<ReturnType<typeof createEvent>>;
  try {
    created = await createEvent({
      organizationId: caller.organizationId,
      userId: caller.userId,
      ...planned.plan.event,
      source: "blueprint",
    });
  } catch (err) {
    await releaseClaim(caller, id);
    throw err;
  }
  if (!created.ok) {
    await releaseClaim(caller, id);
    return fail("EVENT_CREATE_FAILED", `The event could not be created: ${created.message}`, ctx, { eventCode: created.code });
  }
  const eventId = created.event.id;

  // The event exists: record it on the blueprint AT ONCE, so nothing that
  // happens after this line can lead to a second one. From here the claim is
  // never released; a failed seed is only listed (review H2, Oct 8, 2026).
  await runWithTenant(caller.organizationId, () =>
    db.blueprint.updateMany({
      where: { id, organizationId: caller.organizationId, approvedById: caller.userId, eventId: null },
      data: { eventId },
    }),
  );
  apiLogger.info({ msg: "blueprint-workflow:event-recorded", ...ctx, eventId });

  const seeded = await seedEvent(caller, eventId, planned.plan, ctx);
  await runWithTenant(caller.organizationId, () =>
    tenantTransaction(async (tx) => {
      // Guarded: a build-team move made meanwhile is not overwritten (review L14).
      const moved = await tx.blueprint.updateMany({
        where: { id, organizationId: caller.organizationId, status: "PLAN_READY" },
        data: { status: "BUILDING", readiness: scored.pct },
      });
      if (moved.count === 0) apiLogger.warn({ msg: "blueprint-workflow:approved-but-stage-moved", ...ctx, eventId });
      await tx.blueprintStatusLog.create({
        data: {
          blueprintId: id,
          organizationId: caller.organizationId,
          actorId: caller.userId,
          kind: "APPROVED",
          fromStatus: "PLAN_READY",
          toStatus: moved.count ? "BUILDING" : null,
          readiness: scored.pct,
          detail: { which: "plan", eventId, sessions: seeded.sessions, sponsors: seeded.sponsors, skipped: [...planned.plan.skipped, ...seeded.failed] },
        },
      });
    }),
  );
  return { ok: true, eventId };
}

/** Undo a claim whose event was never recorded, so the approval can be tried again. */
async function releaseClaim(caller: Caller, id: string): Promise<void> {
  try {
    await runWithTenant(caller.organizationId, () =>
      db.blueprint.updateMany({
        where: { id, organizationId: caller.organizationId, eventId: null, approvedById: caller.userId },
        data: { approvedAt: null, approvedById: null },
      }),
    );
  } catch (err) {
    apiLogger.error({ msg: "blueprint-workflow:release-claim-failed", organizationId: caller.organizationId, id, err });
  }
}

/**
 * The sessions and sponsors from the brief. A row that fails is logged and
 * listed on the approval record, never undoes the event (plan §4.5): the team
 * fixes it by hand.
 */
async function seedEvent(caller: Caller, eventId: string, plan: EventPlan, ctx: Record<string, unknown>) {
  const failed: string[] = [];
  let sessions = 0;
  for (const s of plan.sessions) {
    try {
      const res = await createSession({
        eventId,
        organizationId: caller.organizationId,
        userId: caller.userId,
        source: "blueprint",
        suppressAdminNotification: true,
        name: s.name,
        startTime: s.startTime,
        endTime: s.endTime,
        location: s.location,
        description: s.description,
      });
      if (res.ok) sessions++;
      else {
        failed.push(`Session "${s.name}": ${res.message}`);
        apiLogger.warn({ msg: "blueprint-workflow:seed-session-failed", ...ctx, eventId, code: res.code });
      }
    } catch (err) {
      failed.push(`Session "${s.name}": could not be added`);
      apiLogger.error({ msg: "blueprint-workflow:seed-session-threw", ...ctx, eventId, err });
    }
  }
  let sponsors = 0;
  if (plan.sponsors.length) {
    try {
      const res = await saveSponsors({
        eventId,
        organizationId: caller.organizationId,
        actorUserId: caller.userId,
        source: "blueprint",
        sponsors: plan.sponsors,
        mode: "merge",
      });
      if (res.ok) sponsors = plan.sponsors.length;
      else {
        failed.push(`Sponsors: ${res.message}`);
        apiLogger.warn({ msg: "blueprint-workflow:seed-sponsors-failed", ...ctx, eventId, code: res.code });
      }
    } catch (err) {
      failed.push("Sponsors: could not be added");
      apiLogger.error({ msg: "blueprint-workflow:seed-sponsors-threw", ...ctx, eventId, err });
    }
  }
  return { sessions, sponsors, failed };
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
