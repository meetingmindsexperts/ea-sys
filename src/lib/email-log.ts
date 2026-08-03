import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getTenantOrgId, runWithTenant } from "@/lib/tenant-context";
import type { EmailLogEntityType } from "@prisma/client";

/**
 * Optional context captured per sendEmail() call so we can link the log row
 * back to the registrant / speaker / contact the email belongs to. All fields
 * are optional — unknown callers get an OTHER-typed row that still records
 * the bare facts (to, subject, provider, status).
 */
export interface EmailLogContext {
  organizationId?: string | null;
  eventId?: string | null;
  entityType?: EmailLogEntityType;
  entityId?: string | null;
  templateSlug?: string | null;
  triggeredByUserId?: string | null;
  /**
   * Controls persisting the final rendered HTML body onto the EmailLog row
   * (`htmlBody`) as an audit copy of exactly what was sent.
   *
   * DEFAULT IS ON since July 16, 2026 (owner decision: "store the email body
   * so the Activity view shows exactly what was sent") — every send stores
   * its body; pass `false` to opt a caller out. Storage growth is bounded by
   * the email-log-prune worker job, which nulls `htmlBody` on rows older
   * than EMAIL_BODY_RETENTION_DAYS (the log row itself is kept). Originally
   * opt-in for certificate deliveries only (2026-07-10).
   */
  storeBody?: boolean;
}

export interface EmailLogRecord {
  to: string;
  cc?: string | null;
  bcc?: string | null;
  subject: string;
  provider: string;
  providerMessageId?: string | null;
  status: "SENT" | "FAILED";
  errorMessage?: string | null;
  /** Final rendered HTML — persisted unless context.storeBody === false. */
  htmlBody?: string | null;
  /**
   * Filenames of the attachments on this send (invoice/receipt PDFs, agreement
   * docs, certificates, …). Captured centrally in sendEmail so no caller has
   * to remember; names only — the bytes never touch the log.
   */
  attachmentNames?: string[];
  context?: EmailLogContext;
}

/**
 * Persist one row to EmailLog. Never throws — a DB failure here must not
 * break the outer send flow, so errors get logged via Pino and swallowed.
 *
 * Tenancy (Domain #18, Aug 3 2026) — this is the ONE writer for EmailLog, so
 * the org attribution + RLS lane are established HERE for every sender:
 *   1. Org resolution, in strictly-safer order: explicit `context.organizationId`
 *      wins; else derived 1-hop from a tagged event; else the AMBIENT tenant
 *      lane (`getTenantOrgId()` — a caller already inside a wrap is sending on
 *      that tenant's behalf, and stamping the ambient org is strictly better
 *      than an unreadable NULL row). Only genuinely org-less sends (auth
 *      emails to org-null accounts, from unwrapped auth routes) stay NULL.
 *      ⚠ The event lookup runs on the CURRENT lane — under platform RLS an
 *      Event policy makes it a silent null for unwrapped callers, which is
 *      why the ambient fallback + the unattributed-row warn below exist
 *      (review Aug 3: never depend on "Event never gets a policy").
 *   2. Self-wrap: the insert runs inside `runWithTenant(resolvedOrg)` so a
 *      stamped row always rides its own lane regardless of caller context
 *      (auth routes and other unwrapped callers included). NULL-org rows
 *      insert bare — the asymmetric WITH CHECK in prisma/rls/emaillog.sql
 *      admits them while USING keeps them invisible to every tenant lane
 *      (owner decision Aug 3, 2026: keep-them-hidden).
 * On master (RLS_SET_LOCAL unset) the wrap is a passthrough; the resolution is
 * NOT byte-neutral — rows from org-less-session senders that used to persist
 * NULL organizationId now persist the event's org (read surfaces unaffected:
 * every reader ORs the null branch or filters by eventId). Note the wrap also
 * REPLACES any enclosing tenantTransaction context (drops `inTenantTx`), so an
 * EmailLog row written mid-transaction lands on its own backend and survives a
 * caller rollback — the right durability for an audit row, recorded here so
 * nobody "fixes" it.
 */
export async function logEmail(record: EmailLogRecord): Promise<void> {
  try {
    let organizationId = record.context?.organizationId ?? null;
    if (!organizationId && record.context?.eventId) {
      // Failure-isolated: a blip on this lookup degrades to the fallbacks
      // below (row kept, just less attributed) instead of losing the row.
      try {
        const event = await db.event.findUnique({
          where: { id: record.context.eventId },
          select: { organizationId: true },
        });
        organizationId = event?.organizationId ?? null;
        if (!event) {
          // Stale/deleted eventId — a distinct failure path from a thrown
          // lookup, and it must log too (repo rule: every failure path logs).
          apiLogger.warn({
            msg: "email-log:event-not-found; falling back to ambient org",
            eventId: record.context.eventId,
          });
        }
      } catch (lookupErr) {
        apiLogger.warn({
          err: lookupErr,
          msg: "email-log:org-resolution-failed; falling back to ambient org",
          eventId: record.context.eventId,
        });
      }
    }
    // Ambient-lane fallback: `||` not `??` — some workers wrap with "" for a
    // legacy null-org row, and "" must not be stamped.
    organizationId = organizationId || getTenantOrgId() || null;
    // A tenant-owned row landing NULL-org is a LOST-ATTRIBUTION bug (the row
    // becomes invisible to the tenant under platform RLS), never the intended
    // org-less auth-email class — make it loud instead of letting the policy's
    // NULL carve-out swallow it (review Aug 3; prod showed 85 of 91 null rows
    // were this class, not auth emails).
    const tenantOwnedEntity =
      record.context?.entityType === "REGISTRATION" ||
      record.context?.entityType === "SPEAKER" ||
      record.context?.entityType === "CONTACT";
    if (!organizationId && (tenantOwnedEntity || record.context?.eventId)) {
      apiLogger.warn({
        msg: "email-log:unattributed-tenant-row",
        entityType: record.context?.entityType,
        entityId: record.context?.entityId,
        eventId: record.context?.eventId,
        to: record.to,
      });
    }
    const data = {
      organizationId,
      eventId: record.context?.eventId ?? null,
      entityType: record.context?.entityType ?? "OTHER",
      entityId: record.context?.entityId ?? null,
      to: record.to,
      cc: record.cc ?? null,
      bcc: record.bcc ?? null,
      subject: record.subject,
      templateSlug: record.context?.templateSlug ?? null,
      provider: record.provider,
      providerMessageId: record.providerMessageId ?? null,
      status: record.status,
      errorMessage: record.errorMessage ?? null,
      // Store-by-default (opt-out with storeBody: false). A caller with no
      // logContext at all still stores — "all sent emails" is the contract.
      htmlBody: record.context?.storeBody === false ? null : (record.htmlBody ?? null),
      attachmentNames: record.attachmentNames ?? [],
      triggeredByUserId: record.context?.triggeredByUserId ?? null,
    };
    if (organizationId) {
      await runWithTenant(organizationId, () => db.emailLog.create({ data }));
    } else {
      // NULL-org (genuinely org-less auth emails): `createMany`, NOT `create`
      // — Prisma's create() emits INSERT..RETURNING, and under the platform's
      // asymmetric policy RETURNING must pass the SELECT-side USING check,
      // which deliberately hides null-org rows ("keep them, hidden"). A plain
      // INSERT (createMany) is admitted by the WITH CHECK null carve-out.
      // Identical behavior on master; the returned row was never used.
      await db.emailLog.createMany({ data: [data] });
    }
  } catch (err) {
    apiLogger.warn({
      err,
      msg: "Failed to write EmailLog row; send itself was unaffected",
      to: record.to,
      subject: record.subject,
    });
  }
}

/**
 * Read helper — last 50 rows for a given entity, newest first. Caller is
 * responsible for RBAC scoping (org match on the entity record).
 *
 * Org-scope filter: historically required `organizationId === <caller's org>`,
 * which had a silent failure mode — many transactional callers
 * (sendRegistrationConfirmation, abstract-status notifications, cert
 * delivery, refund confirmation, payment confirmation, password reset)
 * write `logContext.organizationId = null`. Those rows were correctly
 * tagged with entityType + entityId, but the org filter excluded them,
 * so the Email History card on the registration / speaker / contact
 * detail sheet appeared empty even when the email DID go out.
 *
 * The fix: accept rows whose `organizationId` matches the caller's org
 * OR is null. The route layer already enforces ownership on the parent
 * entity (registration.event.organizationId === ctx.org for REGISTRATION,
 * etc.) so null-org rows for an owned entity belong to that org by
 * construction — they're only un-tagged because the caller forgot to
 * thread organizationId through their logContext literal.
 *
 * Backward-compatible: existing rows that DO have organizationId set
 * still match exactly; the OR just stops null-org rows from being
 * silently filtered. The 8-caller fix (commit B) sets organizationId
 * properly going forward, but A alone makes ALL historical rows
 * visible immediately.
 *
 * Domain #18 (Aug 3, 2026): the missing-org class is now closed at the
 * logEmail choke point (org resolved + stamped for every tenant send), so
 * the OR-null branch survives only for pre-sweep historical rows on master.
 * Under platform RLS it is a DEAD branch by design — USING appends the org
 * predicate, so null rows can never match; do not rely on it there.
 */
export async function getEmailLogsFor(
  entityType: EmailLogEntityType,
  entityId: string,
  organizationId?: string | null
) {
  return db.emailLog.findMany({
    where: {
      entityType,
      entityId,
      ...(organizationId
        ? { OR: [{ organizationId }, { organizationId: null }] }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      to: true,
      cc: true,
      subject: true,
      templateSlug: true,
      provider: true,
      providerMessageId: true,
      status: true,
      errorMessage: true,
      // Presence flag only — mapped to `hasBody` below and stripped so the
      // (potentially large) audit HTML never rides along in list payloads.
      htmlBody: true,
      attachmentNames: true,
      createdAt: true,
      triggeredBy: { select: { firstName: true, lastName: true, email: true } },
    },
  }).then((rows) =>
    rows.map(({ htmlBody, ...rest }) => ({
      ...rest,
      /** True when the final rendered HTML was stored (all senders since
       *  July 16, 2026; older rows only for opt-in senders, and pruned rows
       *  past retention). Fetch it via GET /api/email-logs/[id]/body. */
      hasBody: htmlBody != null,
    })),
  );
}
