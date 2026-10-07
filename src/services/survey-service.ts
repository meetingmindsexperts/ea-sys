/**
 * Surveys (Oct 6, 2026; docs/MULTI_SURVEY_PLAN.md §14 step 2).
 *
 * An event runs several surveys. At most one is the CERTIFICATE survey
 * (`gatesCertificates`), and only it stamps `Registration.surveyCompletedAt`
 * and adds the `survey-completed` tag, which is what the certificate worker
 * (auto-issue.ts) sweeps to mint CME certificates. Every writer of that column
 * is on the credential path, so there is exactly ONE: `submitSurveyResponse()`
 * below, used by every door (the personal link today, the webinar page next).
 *
 * THE CME SURVEY IS RESERVED AND LOCKED (owner, Oct 6, 2026: "cme survey
 * should be unaffected by all means, even if you have to keep it reserved or
 * lock it"). Rules that live here and nowhere else:
 *   - at most one certificate survey per event, held in a reserved slot and
 *     written only by saveCertificateSurvey() (and the old Event-column path);
 *   - the certificate flag is never set, moved or cleared by any other write:
 *     createSurvey() always makes an ordinary survey and updateSurvey() has no
 *     flag in its input, so no other survey can ever mark completion;
 *   - the certificate survey cannot be deleted from the new screens at all;
 *     any other survey cannot be deleted while it has answers (the database
 *     refuses it too, ON DELETE NO ACTION);
 *   - for one release the certificate survey is mirrored onto the old Event
 *     columns (surveyConfig / surveyIntroHtml / surveyThankYouHtml), so a
 *     container still on the old code during a blue/green swap, or a rollback,
 *     reads the same survey. Removed with the cleanup migration.
 *
 * Errors as values, no HTTP (src/services/README.md).
 */

import { isDailyMode, responseDedupKey, type SurveyResponseModeValue } from "@/lib/survey/response-mode";
import { Prisma } from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  surveyConfigSchema,
  validateAnswers,
  SURVEY_COMPLETED_TAG,
  type SurveyConfig,
} from "@/lib/survey/schema";

export const DEFAULT_CERTIFICATE_SURVEY_NAME = "Post-event survey";

/**
 * L2 (docs/MULTI_SURVEY_PLAN.md §13): extra surveys take answers only once a
 * person can hold one response PER SURVEY. Step 3 (migration
 * 20261006160000) replaced the global SurveyResponse.registrationId unique
 * with @@unique([surveyId, dedupKey]) and set this to true in the same change,
 * so an answer to an extra survey can never block anyone's CME survey.
 */
export const EXTRA_SURVEYS_ANSWERABLE = true;

// ── Personal links ────────────────────────────────────────────────────

/**
 * The VerificationToken identifier of a personal survey link (step 3). It names
 * the survey as well as the person, so minting a link for one survey leaves the
 * person's link to another alive. `surveyId` null = the legacy two-part form
 * (an event with no Survey row), which the link resolves to the CME survey.
 */
export function surveyTokenIdentifier(surveyId: string | null, registrationId: string): string {
  return surveyId ? `survey:${surveyId}:${registrationId}` : `survey:${registrationId}`;
}

/**
 * Reads a survey link identifier. Two parts (`survey:{registrationId}`, every
 * link minted before step 3) opens the CME survey, as it always did; three
 * parts names the survey. Null for anything that is not a survey link.
 */
export function parseSurveyTokenIdentifier(identifier: string): { surveyId: string | null; registrationId: string } | null {
  if (!identifier.startsWith("survey:")) return null;
  const rest = identifier.slice("survey:".length);
  const parts = rest.split(":");
  if (parts.length === 1 && parts[0]) return { surveyId: null, registrationId: parts[0] };
  if (parts.length === 2 && parts[0] && parts[1]) return { surveyId: parts[0], registrationId: parts[1] };
  return null;
}

export type LinkSurvey = {
  surveyId: string | null;
  gatesCertificates: boolean;
  config: unknown;
  introHtml: string | null;
  thankYouHtml: string | null;
  /** Phase 4. The CME survey is always ONCE. */
  responseMode: SurveyResponseModeValue;
};

/**
 * The survey a personal link opens. A legacy link, or one naming the CME
 * survey, goes through resolveLinkSurvey (exactly the CME behaviour as
 * before). A link naming an extra survey opens it while it is open. `closed`
 * when the named survey is closed; `null` when it is not this event's.
 */
export async function resolveTokenSurvey(
  event: { id: string } & EventSurveyColumns,
  tokenSurveyId: string | null,
): Promise<{ kind: "ok"; survey: LinkSurvey } | { kind: "closed" } | { kind: "none" }> {
  if (!tokenSurveyId) {
    const cme = await resolveLinkSurvey(event);
    return cme ? { kind: "ok", survey: cme } : { kind: "none" };
  }
  const row = await db.survey.findFirst({ where: { id: tokenSurveyId, eventId: event.id }, select: SURVEY_SELECT });
  if (!row) return { kind: "none" };
  if (row.gatesCertificates) {
    const cme = await resolveLinkSurvey(event);
    return cme ? { kind: "ok", survey: cme } : { kind: "none" };
  }
  if (!row.isActive) return { kind: "closed" };
  return {
    kind: "ok",
    survey: {
      surveyId: row.id,
      gatesCertificates: false,
      config: row.config,
      introHtml: row.introHtml,
      thankYouHtml: row.thankYouHtml,
      responseMode: row.responseMode,
    },
  };
}

/**
 * The survey a Survey Invitation send links to (step 3). With no `surveyId`
 * it is the CME survey, exactly what the send did before (a queued send from
 * before this release carries none). Refused with a message when the chosen
 * survey is not this event's, is closed, or has no questions.
 */
export async function resolveInvitationSurvey(
  event: { id: string } & EventSurveyColumns,
  surveyId: string | undefined,
): Promise<{ ok: true; surveyId: string | null; name: string; gatesCertificates: boolean } | { ok: false; message: string }> {
  if (!surveyId) {
    if (!isLiveConfig(event.surveyConfig)) {
      return { ok: false, message: "No survey is configured for this event. Build the survey at Survey first." };
    }
    const cert = await getCertificateSurvey(event.id);
    return { ok: true, surveyId: cert?.id ?? null, name: cert?.name ?? DEFAULT_CERTIFICATE_SURVEY_NAME, gatesCertificates: true };
  }
  const row = await getSurvey(event.id, surveyId, event);
  if (!row) return { ok: false, message: "That survey does not belong to this event." };
  if (!row.isActive) return { ok: false, message: `The survey "${row.name}" is closed. Open it before sending its link.` };
  if (!isLiveConfig(row.config)) return { ok: false, message: `The survey "${row.name}" has no questions yet.` };
  return { ok: true, surveyId: row.id, name: row.name, gatesCertificates: row.gatesCertificates };
}

export type SurveyServiceSource = "rest" | "mcp" | "agent" | "public";

export interface SurveyScope {
  eventId: string;
  organizationId: string;
  userId: string | null;
  source: SurveyServiceSource;
}

/** What an organiser edits. Deliberately has NO certificate flag: only the
 *  reserved certificate slot is ever the certificate survey. */
export interface SurveyFields {
  name: string;
  config: SurveyConfig;
  introHtml: string | null;
  thankYouHtml: string | null;
  isActive: boolean;
  /** Phase 4: how often one person may answer (extra surveys only; ONCE by default). */
  responseMode?: SurveyResponseModeValue;
}

export type SurveyErrorCode =
  | "SURVEY_NOT_FOUND"
  | "CERTIFICATE_SURVEY_LOCKED"
  | "SURVEY_HAS_RESPONSES"
  | "SURVEY_MODE_LOCKED";

export type SurveyWriteResult =
  | { ok: true; surveyId: string }
  | { ok: false; code: SurveyErrorCode; message: string };

const SURVEY_SELECT = {
  id: true,
  eventId: true,
  name: true,
  config: true,
  introHtml: true,
  thankYouHtml: true,
  isActive: true,
  sortOrder: true,
  gatesCertificates: true,
  responseMode: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SurveySelect;

export type SurveyRow = Prisma.SurveyGetPayload<{ select: typeof SURVEY_SELECT }>;

/**
 * Parse a stored question list. Null when absent or no longer matching the
 * schema (an older shape); the mismatch is logged so it can be found and fixed.
 */
export function parseStoredSurveyConfig(raw: unknown, ctx: Record<string, unknown>): SurveyConfig | null {
  if (raw === null || raw === undefined) return null;
  const parsed = surveyConfigSchema.safeParse(raw);
  if (!parsed.success) {
    apiLogger.warn({ msg: "survey:invalid-stored-config", ...ctx, errors: parsed.error.flatten() });
    return null;
  }
  return parsed.data;
}

/**
 * Which responses belong to a survey. The certificate survey also owns its
 * event's responses with no survey yet (written by a container on the old code
 * during a swap, before a backfill links them).
 */
export function responseWhereForSurvey(survey: {
  id: string;
  eventId: string;
  gatesCertificates: boolean;
}): Prisma.SurveyResponseWhereInput {
  return survey.gatesCertificates
    ? { eventId: survey.eventId, OR: [{ surveyId: survey.id }, { surveyId: null }] }
    : { surveyId: survey.id };
}

// ── Reads ─────────────────────────────────────────────────────────────

/** The old Event survey columns, which hold the CME survey this release. */
export interface EventSurveyColumns {
  surveyConfig: unknown;
  surveyIntroHtml: string | null;
  surveyThankYouHtml: string | null;
}

/** A real question list (the schema requires at least one question). */
function isLiveConfig(raw: unknown): boolean {
  return Array.isArray(raw) && raw.length > 0;
}

/**
 * THE CME SURVEY'S CONTENT COMES FROM THE EVENT COLUMNS THIS RELEASE (review
 * of step 2). The old code keeps writing those columns for the ~10 minutes
 * between the migration (Vercel, at push) and the container swap, and the new
 * code mirrors every certificate-survey save onto them, so they are always
 * the current CME survey in both directions. Reading them makes the personal
 * link and every report behave exactly as before, whatever happened to the
 * Survey row in that window. The cleanup release (which drops the columns)
 * first re-runs the catch-up copy, then removes this overlay.
 */
export function overlayCertificateFromEvent<T extends SurveyRow>(row: T, ev: EventSurveyColumns): T {
  if (!row.gatesCertificates) return row;
  const live = isLiveConfig(ev.surveyConfig);
  if (!live) return { ...row, isActive: false };
  return {
    ...row,
    config: ev.surveyConfig as T["config"],
    introHtml: ev.surveyIntroHtml,
    thankYouHtml: ev.surveyThankYouHtml,
    isActive: true,
  };
}

export async function listSurveys(
  eventId: string,
  ev: EventSurveyColumns,
): Promise<Array<SurveyRow & { responseCount: number }>> {
  const surveys = await db.survey.findMany({
    where: { eventId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: SURVEY_SELECT,
  });
  const counts = await Promise.all(
    surveys.map((s) => db.surveyResponse.count({ where: responseWhereForSurvey(s) })),
  );
  return surveys.map((s, i) => ({ ...overlayCertificateFromEvent(s, ev), responseCount: counts[i] }));
}

/** One survey of the event, with the CME overlay applied. */
export async function getSurvey(eventId: string, surveyId: string, ev: EventSurveyColumns): Promise<SurveyRow | null> {
  const row = await db.survey.findFirst({ where: { id: surveyId, eventId }, select: SURVEY_SELECT });
  return row ? overlayCertificateFromEvent(row, ev) : null;
}

/** The event's certificate survey row. Oldest first, so even a duplicate
 *  (which the write path's event-row lock prevents) can never flip. */
export async function getCertificateSurvey(eventId: string): Promise<SurveyRow | null> {
  return db.survey.findFirst({
    where: { eventId, gatesCertificates: true },
    orderBy: { createdAt: "asc" },
    select: SURVEY_SELECT,
  });
}

/**
 * The survey the personal link opens until links name their survey (step 3):
 * the CME survey, exactly as before. Content and open/closed come from the
 * Event columns (see overlayCertificateFromEvent): cleared or closed means no
 * survey, as a cleared survey always did. The Survey row only supplies the id
 * the response is filed under.
 */
export async function resolveLinkSurvey(event: { id: string } & EventSurveyColumns): Promise<LinkSurvey | null> {
  if (!isLiveConfig(event.surveyConfig)) return null;
  const cert = await getCertificateSurvey(event.id);
  if (!cert) apiLogger.info({ msg: "survey:link-no-survey-row", eventId: event.id });
  return {
    surveyId: cert?.id ?? null,
    gatesCertificates: true,
    config: event.surveyConfig,
    introHtml: event.surveyIntroHtml,
    thankYouHtml: event.surveyThankYouHtml,
    // The CME survey is answered once, always.
    responseMode: "ONCE",
  };
}

/**
 * The survey a results page or export reports on. With no `surveyId` it is the
 * CME survey (what the pages showed before there were several); an event with
 * no Survey row at all reads the old Event columns. `null` means a `surveyId`
 * that is not this event's.
 */
export async function resolveReportSurvey(
  event: { id: string } & EventSurveyColumns,
  surveyId: string | undefined,
): Promise<{
  survey: { id: string; name: string; gatesCertificates: boolean; isActive: boolean; responseMode: SurveyResponseModeValue } | null;
  rawConfig: unknown;
  where: Prisma.SurveyResponseWhereInput;
} | null> {
  const row = surveyId ? await getSurvey(event.id, surveyId, event) : await getCertificateSurvey(event.id);
  if (surveyId && !row) return null;
  if (row) {
    const survey = overlayCertificateFromEvent(row, event);
    return {
      survey: {
        id: survey.id,
        name: survey.name,
        gatesCertificates: survey.gatesCertificates,
        isActive: survey.isActive,
        responseMode: survey.gatesCertificates ? "ONCE" : survey.responseMode,
      },
      // A closed CME survey still reports its answers against its questions.
      rawConfig: survey.gatesCertificates && !isLiveConfig(event.surveyConfig) ? row.config : survey.config,
      where: responseWhereForSurvey(survey),
    };
  }
  return { survey: null, rawConfig: event.surveyConfig, where: { eventId: event.id } };
}

/**
 * Serialise every write that could create the CME survey for an event: a row
 * lock on the event, held to the end of the transaction. Two first saves at
 * once (a double click, or the old event save racing the new builder) then
 * run one after the other, and the second finds the first's survey. (A
 * partial unique index would say this in the database, but Prisma cannot
 * represent one and CI's schema check would refuse it.)
 */
async function lockEventForCertificate(tx: Prisma.TransactionClient, eventId: string) {
  await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${eventId} FOR UPDATE`;
}

// ── Writes ────────────────────────────────────────────────────────────

/** Mirror the certificate survey onto the old Event columns (one release). */
async function mirrorCertificateSurveyToEvent(tx: Prisma.TransactionClient, eventId: string) {
  const cert = await tx.survey.findFirst({
    where: { eventId, gatesCertificates: true },
    select: { config: true, introHtml: true, thankYouHtml: true, isActive: true },
  });
  const live = cert && cert.isActive ? cert : null;
  await tx.event.update({
    where: { id: eventId },
    data: {
      surveyConfig: live ? (live.config as Prisma.InputJsonValue) : Prisma.JsonNull,
      surveyIntroHtml: live?.introHtml ?? null,
      surveyThankYouHtml: live?.thankYouHtml ?? null,
    },
  });
}

/** Creates an ORDINARY survey. It can never be the certificate survey. */
export async function createSurvey(scope: SurveyScope, fields: SurveyFields): Promise<SurveyWriteResult> {
  const id = await tenantTransaction(async (tx) => {
    const last = await tx.survey.findFirst({
      where: { eventId: scope.eventId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    const survey = await tx.survey.create({
      data: {
        eventId: scope.eventId,
        organizationId: scope.organizationId,
        name: fields.name,
        config: fields.config as Prisma.InputJsonValue,
        introHtml: fields.introHtml,
        thankYouHtml: fields.thankYouHtml,
        isActive: fields.isActive,
        gatesCertificates: false,
        responseMode: fields.responseMode ?? "ONCE",
        sortOrder: (last?.sortOrder ?? 0) + 1,
      },
      select: { id: true },
    });
    await tx.auditLog.create({
      data: {
        eventId: scope.eventId,
        organizationId: scope.organizationId,
        userId: scope.userId,
        action: "SURVEY_CREATED",
        entityType: "Survey",
        entityId: survey.id,
        changes: { name: fields.name, questions: fields.config.length, isActive: fields.isActive, source: scope.source },
      },
    });
    return survey.id;
  });
  apiLogger.info({ msg: "survey:created", eventId: scope.eventId, surveyId: id, userId: scope.userId });
  return { ok: true, surveyId: id };
}

/**
 * The reserved certificate (CME) survey: creates it when the event has none,
 * otherwise edits it. The only writer of the certificate flag (besides the old
 * Event-column path). Mirrors it onto the old Event columns for one release.
 */
export async function saveCertificateSurvey(
  scope: SurveyScope,
  fields: Omit<SurveyFields, "name"> & { name?: string },
): Promise<SurveyWriteResult> {
  const id = await tenantTransaction(async (tx) => {
    await lockEventForCertificate(tx, scope.eventId);
    const cert = await tx.survey.findFirst({
      where: { eventId: scope.eventId, gatesCertificates: true },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    const data = {
      config: fields.config as Prisma.InputJsonValue,
      introHtml: fields.introHtml,
      thankYouHtml: fields.thankYouHtml,
      isActive: fields.isActive,
      ...(fields.name !== undefined && { name: fields.name }),
    };
    const saved = cert
      ? await tx.survey.update({ where: { id: cert.id }, data, select: { id: true } })
      : await tx.survey.create({
          data: {
            ...data,
            eventId: scope.eventId,
            organizationId: scope.organizationId,
            name: fields.name ?? DEFAULT_CERTIFICATE_SURVEY_NAME,
            gatesCertificates: true,
            sortOrder: 0,
          },
          select: { id: true },
        });
    await mirrorCertificateSurveyToEvent(tx, scope.eventId);
    await tx.auditLog.create({
      data: {
        eventId: scope.eventId,
        organizationId: scope.organizationId,
        userId: scope.userId,
        action: cert ? "SURVEY_UPDATED" : "SURVEY_CREATED",
        entityType: "Survey",
        entityId: saved.id,
        changes: { certificate: true, questions: fields.config.length, isActive: fields.isActive, source: scope.source },
      },
    });
    return saved.id;
  });
  apiLogger.info({ msg: "survey:certificate-saved", eventId: scope.eventId, surveyId: id, userId: scope.userId });
  return { ok: true, surveyId: id };
}

/** Edits an EXTRA survey's name, questions, messages or open/closed state.
 *  The CME survey is refused here (its reserved writer is
 *  saveCertificateSurvey); the flag is not in the input at all. */
export async function updateSurvey(
  scope: SurveyScope,
  surveyId: string,
  patch: Partial<SurveyFields>,
): Promise<SurveyWriteResult> {
  const found = await tenantTransaction(async (tx) => {
    const survey = await tx.survey.findFirst({
      where: { id: surveyId, eventId: scope.eventId },
      select: { id: true, gatesCertificates: true, responseMode: true },
    });
    if (!survey) return "not-found" as const;
    if (survey.gatesCertificates) return "locked" as const;
    // The mode locks once anyone answered (Phase 4), like the certificate
    // flag: switching ONCE <-> daily would let a person answer again under
    // the other duplicate rule.
    if (patch.responseMode !== undefined && patch.responseMode !== survey.responseMode) {
      const answered = await tx.surveyResponse.count({ where: { surveyId } });
      if (answered > 0) return "mode-locked" as const;
    }
    await tx.survey.update({
      where: { id: surveyId },
      data: {
        ...(patch.responseMode !== undefined && { responseMode: patch.responseMode }),
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.config !== undefined && { config: patch.config as Prisma.InputJsonValue }),
        ...(patch.introHtml !== undefined && { introHtml: patch.introHtml }),
        ...(patch.thankYouHtml !== undefined && { thankYouHtml: patch.thankYouHtml }),
        ...(patch.isActive !== undefined && { isActive: patch.isActive }),
      },
    });
    await tx.auditLog.create({
      data: {
        eventId: scope.eventId,
        organizationId: scope.organizationId,
        userId: scope.userId,
        action: "SURVEY_UPDATED",
        entityType: "Survey",
        entityId: surveyId,
        changes: {
          fields: Object.keys(patch),
          ...(patch.config !== undefined && { questions: patch.config.length }),
          ...(patch.isActive !== undefined && { isActive: patch.isActive }),
          source: scope.source,
        },
      },
    });
    return "ok" as const;
  });
  if (found === "not-found") {
    apiLogger.warn({ msg: "survey:update-not-found", eventId: scope.eventId, surveyId });
    return { ok: false, code: "SURVEY_NOT_FOUND", message: "Survey not found" };
  }
  if (found === "mode-locked") {
    apiLogger.warn({ msg: "survey:update-mode-locked", eventId: scope.eventId, surveyId, userId: scope.userId });
    return {
      ok: false,
      code: "SURVEY_MODE_LOCKED",
      message: "People have already answered this survey, so how often they may answer can no longer change.",
    };
  }
  if (found === "locked") {
    apiLogger.warn({ msg: "survey:update-certificate-locked", eventId: scope.eventId, surveyId, userId: scope.userId });
    return {
      ok: false,
      code: "CERTIFICATE_SURVEY_LOCKED",
      message: "The certificate (CME) survey is edited from its own page only.",
    };
  }
  apiLogger.info({ msg: "survey:updated", eventId: scope.eventId, surveyId, fields: Object.keys(patch), userId: scope.userId });
  return { ok: true, surveyId };
}

export async function deleteSurvey(scope: SurveyScope, surveyId: string): Promise<SurveyWriteResult> {
  const result = await tenantTransaction(async (tx) => {
    const survey = await tx.survey.findFirst({
      where: { id: surveyId, eventId: scope.eventId },
      select: { id: true, eventId: true, gatesCertificates: true, name: true },
    });
    if (!survey) return { outcome: "not-found" as const };
    if (survey.gatesCertificates) return { outcome: "locked" as const };
    const answered = await tx.surveyResponse.count({ where: responseWhereForSurvey(survey) });
    if (answered > 0) return { outcome: "has-responses" as const, answered };
    await tx.survey.delete({ where: { id: surveyId } });
    // A webinar's end-of-webinar choice pointing at it is cleared too, in one
    // statement so a console save of other settings is never overwritten.
    const clearedEndSurvey = await tx.$executeRaw`
      UPDATE "Event" SET settings = settings #- '{webinar,endSurveyId}'
      WHERE id = ${scope.eventId} AND settings->'webinar'->>'endSurveyId' = ${surveyId}`;
    if (clearedEndSurvey > 0) {
      apiLogger.info({ msg: "survey:end-survey-choice-cleared", eventId: scope.eventId, surveyId });
    }
    await tx.auditLog.create({
      data: {
        eventId: scope.eventId,
        organizationId: scope.organizationId,
        userId: scope.userId,
        action: "SURVEY_DELETED",
        entityType: "Survey",
        entityId: surveyId,
        changes: { name: survey.name, gatesCertificates: survey.gatesCertificates, source: scope.source },
      },
    });
    return { outcome: "ok" as const };
  });
  if (result.outcome === "not-found") {
    apiLogger.warn({ msg: "survey:delete-not-found", eventId: scope.eventId, surveyId });
    return { ok: false, code: "SURVEY_NOT_FOUND", message: "Survey not found" };
  }
  if (result.outcome === "locked") {
    apiLogger.warn({ msg: "survey:delete-certificate-locked", eventId: scope.eventId, surveyId, userId: scope.userId });
    return {
      ok: false,
      code: "CERTIFICATE_SURVEY_LOCKED",
      message: "The certificate (CME) survey is locked and cannot be deleted. You can close it instead.",
    };
  }
  if (result.outcome === "has-responses") {
    apiLogger.warn({ msg: "survey:delete-has-responses", eventId: scope.eventId, surveyId, answered: result.answered });
    return {
      ok: false,
      code: "SURVEY_HAS_RESPONSES",
      message: `This survey has ${result.answered} answer${result.answered === 1 ? "" : "s"}, so it cannot be deleted. Close it instead: its link will say the survey is closed.`,
    };
  }
  apiLogger.info({ msg: "survey:deleted", eventId: scope.eventId, surveyId, userId: scope.userId });
  return { ok: true, surveyId };
}

/**
 * The old Event-column write path (the event PUT's surveyConfig / intro /
 * thank-you fields), kept for one release for clients still on it: lands the
 * change on the certificate survey. A clear (`config: null`) closes it; the
 * CME survey is never deleted.
 */
export async function applyLegacyEventSurveyWrite(
  scope: SurveyScope,
  write: { config?: SurveyConfig | null; introHtml?: string | null; thankYouHtml?: string | null },
): Promise<void> {
  await tenantTransaction(async (tx) => {
    await lockEventForCertificate(tx, scope.eventId);
    const cert = await tx.survey.findFirst({
      where: { eventId: scope.eventId, gatesCertificates: true },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    // A clear CLOSES the CME survey; nothing ever deletes it (L1).
    if (write.config === null) {
      if (cert) await tx.survey.update({ where: { id: cert.id }, data: { isActive: false } });
      return;
    }
    const textPatch = {
      ...(write.introHtml !== undefined && { introHtml: write.introHtml }),
      ...(write.thankYouHtml !== undefined && { thankYouHtml: write.thankYouHtml }),
    };
    if (write.config === undefined) {
      if (cert && Object.keys(textPatch).length > 0) await tx.survey.update({ where: { id: cert.id }, data: textPatch });
      return;
    }
    if (cert) {
      await tx.survey.update({
        where: { id: cert.id },
        data: { config: write.config as Prisma.InputJsonValue, isActive: true, ...textPatch },
      });
      return;
    }
    await tx.survey.create({
      data: {
        eventId: scope.eventId,
        organizationId: scope.organizationId,
        name: DEFAULT_CERTIFICATE_SURVEY_NAME,
        config: write.config as Prisma.InputJsonValue,
        introHtml: write.introHtml ?? null,
        thankYouHtml: write.thankYouHtml ?? null,
        gatesCertificates: true,
      },
    });
  });
  apiLogger.info({ msg: "survey:legacy-event-write-applied", eventId: scope.eventId, cleared: write.config === null });
}

// ── Submit: the ONE writer of Registration.surveyCompletedAt ──────────

export interface SubmitSurveyInput {
  survey: {
    id: string | null;
    eventId: string;
    gatesCertificates: boolean;
    config: unknown;
    /** Phase 4; ONCE when omitted. The certificate survey is always ONCE. */
    responseMode?: SurveyResponseModeValue;
  };
  /** The event's timezone: the day a daily answer counts for. */
  timezone?: string | null;
  registration: { id: string; surveyCompletedAt: Date | null; attendee: { id: string; tags: string[] | null } };
  organizationId: string;
  rawAnswers: Record<string, unknown>;
  ipHash: string | null;
  /** A single-use personal link to consume with the submit. */
  consumeTokenHash?: string;
}

export type SubmitSurveyResult =
  | { ok: true; alreadyCompleted: boolean; answeredCount: number }
  | { ok: false; code: "NO_SURVEY"; message: string }
  | { ok: false; code: "NOT_YET_ANSWERABLE"; message: string }
  | { ok: false; code: "ANSWERS_INVALID"; message: string; errors: unknown };

async function consumeToken(tokenHash: string | undefined, ctx: Record<string, unknown>) {
  if (!tokenHash) return;
  await db.verificationToken
    .delete({ where: { token: tokenHash } })
    .catch((err) => apiLogger.warn({ err, msg: "survey:token-cleanup-failed", ...ctx }));
}

export async function submitSurveyResponse(input: SubmitSurveyInput): Promise<SubmitSurveyResult> {
  const { survey, registration } = input;
  const ctx = { eventId: survey.eventId, surveyId: survey.id, registrationId: registration.id };

  if (!survey.gatesCertificates && !EXTRA_SURVEYS_ANSWERABLE) {
    apiLogger.warn({ msg: "survey:extra-survey-not-yet-answerable", ...ctx });
    return { ok: false, code: "NOT_YET_ANSWERABLE", message: "This survey is not open for answers yet." };
  }

  const config = parseStoredSurveyConfig(survey.config, ctx);
  if (!config) {
    apiLogger.warn({ msg: "survey:submit-no-config", ...ctx });
    return { ok: false, code: "NO_SURVEY", message: "No survey is configured for this event." };
  }
  const answers = validateAnswers(config, input.rawAnswers);
  if (!answers.ok) {
    apiLogger.warn({ msg: "survey:submit-answers-invalid", ...ctx, errors: answers.errors });
    return { ok: false, code: "ANSWERS_INVALID", message: "Some answers are invalid", errors: answers.errors };
  }

  // A daily survey keeps its personal link until it expires (Phase 4, owner);
  // the certificate survey is never daily, whatever the caller passed.
  const now = new Date();
  const mode: SurveyResponseModeValue = survey.gatesCertificates ? "ONCE" : (survey.responseMode ?? "ONCE");
  const consumeTokenHash = isDailyMode(mode) ? undefined : input.consumeTokenHash;
  const dedupKey = responseDedupKey(mode, registration.id, now, input.timezone);

  // Already answered (today, for a daily survey)? The unique index is the
  // race-safe net; this avoids a transaction on a reload.
  const already = await hasAnswered({
    survey: { id: survey.id, gatesCertificates: survey.gatesCertificates, responseMode: mode },
    registration,
    timezone: input.timezone,
    at: now,
  });
  if (already) {
    apiLogger.info({ msg: "survey:submit-already-completed", ...ctx, mode });
    await consumeToken(consumeTokenHash, ctx);
    return { ok: true, alreadyCompleted: true, answeredCount: 0 };
  }

  try {
    await tenantTransaction(async (tx) => {
      // The race gate is (surveyId, dedupKey). With no Survey row the CME
      // answer would carry surveyId NULL, which Postgres treats as distinct,
      // so a double click could store two. Make sure the reserved CME row
      // exists first, under the same event lock its other writers take.
      let surveyId = survey.id;
      if (survey.gatesCertificates && !surveyId) {
        await lockEventForCertificate(tx, survey.eventId);
        const cert = await tx.survey.findFirst({
          where: { eventId: survey.eventId, gatesCertificates: true },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        });
        surveyId =
          cert?.id ??
          (
            await tx.survey.create({
              data: {
                eventId: survey.eventId,
                organizationId: input.organizationId,
                name: DEFAULT_CERTIFICATE_SURVEY_NAME,
                config: survey.config as Prisma.InputJsonValue,
                gatesCertificates: true,
                sortOrder: 0,
              },
              select: { id: true },
            })
          ).id;
        apiLogger.info({ msg: "survey:submit-created-cme-row", ...ctx, surveyId });
      }
      await tx.surveyResponse.create({
        data: {
          eventId: survey.eventId,
          surveyId,
          dedupKey,
          registrationId: registration.id,
          organizationId: input.organizationId,
          answers: answers.answers as Prisma.InputJsonValue,
          ipHash: input.ipHash,
          submittedAt: now,
        },
      });
      // Only the certificate survey marks completion: this is what the
      // certificate worker sweeps. Never for any other survey.
      if (survey.gatesCertificates) {
        await tx.registration.update({ where: { id: registration.id }, data: { surveyCompletedAt: now } });
        await tx.attendee.update({
          where: { id: registration.attendee.id },
          data: { tags: Array.from(new Set([...(registration.attendee.tags ?? []), SURVEY_COMPLETED_TAG])) },
        });
      }
      if (consumeTokenHash) {
        await tx.verificationToken.delete({ where: { token: consumeTokenHash } });
      }
    });
  } catch (err) {
    // A double click: the unique index already holds this answer.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      apiLogger.info({ msg: "survey:submit-race-dedup", ...ctx });
      await consumeToken(input.consumeTokenHash, ctx);
      return { ok: true, alreadyCompleted: true, answeredCount: 0 };
    }
    throw err;
  }

  const answeredCount = Object.keys(answers.answers).length;
  apiLogger.info({ msg: "survey:submit-success", ...ctx, gatesCertificates: survey.gatesCertificates, answeredCount });
  return { ok: true, alreadyCompleted: false, answeredCount };
}

/**
 * Whether this registration has already answered the survey, the ONE rule for
 * the personal link, the end-of-webinar popup, the thank-you email and the
 * submit (Phase 4). The certificate survey keeps its historical signal
 * (surveyCompletedAt); an extra ONCE survey looks for any answer; a daily one
 * for an answer today, in the event's timezone.
 */
export async function hasAnswered(args: {
  survey: { id: string | null; gatesCertificates: boolean; responseMode?: SurveyResponseModeValue | null };
  registration: { id: string; surveyCompletedAt: Date | null };
  timezone?: string | null;
  at?: Date;
}): Promise<boolean> {
  const { survey, registration } = args;
  if (survey.gatesCertificates) return registration.surveyCompletedAt !== null;
  if (!survey.id) return false;
  if (isDailyMode(survey.responseMode)) {
    const dedupKey = responseDedupKey(survey.responseMode, registration.id, args.at ?? new Date(), args.timezone);
    return (await db.surveyResponse.count({ where: { surveyId: survey.id, dedupKey } })) > 0;
  }
  return (await db.surveyResponse.count({ where: { surveyId: survey.id, registrationId: registration.id } })) > 0;
}
