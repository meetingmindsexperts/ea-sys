/**
 * A partner's stream into one of our webinars: issue its key, replace it,
 * switch it on or off (Nov 12, 2026; external streams step 2,
 * docs/EXTERNAL_STREAM_AND_PRERECORDED_PLAN.md §4.2 and §4.3).
 *
 * One ExternalStream row per session. While it exists it IS the session's
 * stream (src/lib/webinar/session-stream.ts), so:
 *
 *  - A session has our Zoom webinar OR a partner's stream, never both: issuing
 *    is refused while the session holds a Zoom meeting.
 *  - No key leaves the company signed with the sign-in secret. Publish
 *    passwords fall back to NEXTAUTH_SECRET when STREAM_PUBLISH_SECRET is unset,
 *    and rotating that secret would then silently cancel every key a partner
 *    holds. Issuing is refused until the dedicated secret is set.
 *
 *  - No key is issued until a running stream can be ended (MediaMTX's control
 *    API, mediamtx-control.ts). MediaMTX asks for the password only when a
 *    publish STARTS, so without that, replacing, switching off and the end of
 *    the period would stop only the next connection.
 *
 * Replacing the key adds one to secretVersion: the password the partner holds
 * stops matching, while the address attendees watch on (the stream key itself)
 * does not change. Replacing, switching off and cutting the feed each also
 * disconnect whoever is publishing on the key at that moment. The database
 * write comes FIRST, so an encoder that reconnects at once is refused; when the
 * disconnect itself fails the result says so (`disconnect`, with `ok: false`
 * INSIDE an `ok: true` answer: the key did change), the caller tells the
 * producer, and the minute sweep tries again: it disconnects a stream on a key
 * that is switched off, and one that began before the key was last replaced
 * (external-stream-sweep.ts).
 *
 * WHO SEES THE KEY. Nothing here returns the key or its password except
 * revealExternalStreamCredentials, which writes who looked to the audit log.
 * Issuing, replacing and switching return the stream's state only (review of
 * 15f219c0: they all returned the credentials, so a route for someone who may
 * run the webinar but not see host details had to remember to strip them).
 * The route calls reveal only for a holder of `zoomHost.view`.
 *
 * Errors are values for every expected refusal; a database error throws, to
 * the route's own catch. Never imports next/server. The caller has already
 * authorised the event (webinar.manage).
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { externalStreamCredentials } from "@/lib/webinar/external-stream";
import { isPartnerPublishSecretSet, newStreamKey } from "@/lib/webinar/livestream";
import { disconnectPublishers, isMediamtxControlConfigured, type DisconnectResult } from "@/lib/webinar/mediamtx-control";
import { externalStreamValidUntil } from "@/lib/webinar/session-stream";

/** Staff in the dashboard only. A partner's key is never issued or shown to the agent or an API key. */
export type ExternalStreamSource = "rest";

interface Caller {
  organizationId: string;
  eventId: string;
  sessionId: string;
  userId: string;
  source: ExternalStreamSource;
}

export type ExternalStreamErrorCode =
  | "SESSION_NOT_FOUND"
  | "ZOOM_WEBINAR_EXISTS"
  | "ALREADY_ISSUED"
  | "NOT_ISSUED"
  | "PUBLISH_SECRET_NOT_SET"
  | "CONTROL_API_NOT_SET"
  | "INVALID_PERIOD";

/** What staff see of a partner's stream. Never the key or its password: see revealExternalStreamCredentials. */
export interface ExternalStreamView {
  id: string;
  sessionId: string;
  enabled: boolean;
  secretVersion: number;
  validFrom: Date;
  /** The end of the period as it stands now: its own end date, else 24 hours after the session's scheduled end. */
  validUntil: Date;
  /** Whether validUntil is the key's own (true) or follows the session (false). */
  validUntilIsOwn: boolean;
  issuedTo: string | null;
  lastPublishAt: Date | null;
}

/** The two values the partner types into their platform. A HOST secret. */
export interface ExternalStreamCredentials {
  serverUrl: string;
  streamKey: string;
}

export type ExternalStreamCredentialsResult =
  | { ok: true; credentials: ExternalStreamCredentials }
  | { ok: false; code: ExternalStreamErrorCode; message: string };

const PUBLISH_SECRET_MESSAGE =
  "A partner's stream key needs STREAM_PUBLISH_SECRET set on the server: without it the key would stop working whenever the sign-in secret is rotated. Setting it also changes the password of every Zoom custom stream, so afterwards press Re-send stream settings to Zoom on each upcoming one.";

export type ExternalStreamResult =
  | {
      ok: true;
      externalStream: ExternalStreamView;
      /** Present when the operation also tried to end the running stream: whether that worked. */
      disconnect?: DisconnectResult;
    }
  | { ok: false; code: ExternalStreamErrorCode; message: string };

const ISSUED_TO_MAX = 200;

const ROW_SELECT = {
  id: true,
  sessionId: true,
  streamKey: true,
  secretVersion: true,
  enabled: true,
  validFrom: true,
  validUntil: true,
  issuedTo: true,
  lastPublishAt: true,
  session: { select: { endTime: true } },
} as const;

type Row = {
  id: string;
  sessionId: string;
  streamKey: string;
  secretVersion: number;
  enabled: boolean;
  validFrom: Date;
  validUntil: Date | null;
  issuedTo: string | null;
  lastPublishAt: Date | null;
  session: { endTime: Date };
};

function toView(row: Row): ExternalStreamView {
  return {
    id: row.id,
    sessionId: row.sessionId,
    enabled: row.enabled,
    secretVersion: row.secretVersion,
    validFrom: row.validFrom,
    validUntil: externalStreamValidUntil({ validUntil: row.validUntil, sessionEndTime: row.session.endTime }),
    validUntilIsOwn: row.validUntil !== null,
    issuedTo: row.issuedTo,
    lastPublishAt: row.lastPublishAt,
  };
}

function refuse(
  caller: Caller,
  op: string,
  code: ExternalStreamErrorCode,
  message: string,
): { ok: false; code: ExternalStreamErrorCode; message: string } {
  apiLogger.warn({ eventId: caller.eventId, sessionId: caller.sessionId, userId: caller.userId, code }, `external-stream:${op}-refused`);
  return { ok: false, code, message };
}

/** The audit trail of a key: who issued, replaced or switched it. Never the key or its password. */
async function audit(caller: Caller, action: string, entityId: string, changes: Record<string, unknown>): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        organizationId: caller.organizationId,
        eventId: caller.eventId,
        userId: caller.userId,
        action,
        entityType: "ExternalStream",
        entityId,
        changes: { ...changes, sessionId: caller.sessionId, source: caller.source },
      },
    });
  } catch (err) {
    apiLogger.error({ err, eventId: caller.eventId, action }, "external-stream:audit-failed");
  }
}

function cleanIssuedTo(raw: string | null | undefined): string | null {
  const text = raw?.trim().slice(0, ISSUED_TO_MAX);
  return text ? text : null;
}

/**
 * End whoever is publishing on the key now. Called AFTER the database says no
 * (a new version, or switched off), so a reconnect is refused. Never throws: a
 * failure is returned for the caller to show, and logged here.
 */
async function endRunningStream(caller: Caller, op: string, streamKey: string): Promise<DisconnectResult> {
  const result = await disconnectPublishers(streamKey);
  const base = { eventId: caller.eventId, sessionId: caller.sessionId, userId: caller.userId, op };
  if (!result.ok) {
    apiLogger.warn({ ...base, code: result.code }, "external-stream:disconnect-failed");
    return result;
  }
  if (result.disconnected > 0) apiLogger.info({ ...base, disconnected: result.disconnected }, "external-stream:running-stream-ended");
  return result;
}

function disconnectAudit(result: DisconnectResult): Record<string, unknown> {
  return result.ok ? { disconnected: result.disconnected } : { disconnectFailed: result.code };
}

/** The session's partner stream as staff see it (never its key), or null when none was issued. */
export async function getExternalStream(at: { eventId: string; sessionId: string }): Promise<ExternalStreamView | null> {
  const row = await db.externalStream.findFirst({ where: { sessionId: at.sessionId, eventId: at.eventId }, select: ROW_SELECT });
  return row ? toView(row) : null;
}

/**
 * Show the key: the server address and the stream key with its password, as
 * the partner types them. The ONLY function that returns them, and each look
 * is written to the audit log (who, when), never the values themselves.
 */
export async function revealExternalStreamCredentials(input: Caller): Promise<ExternalStreamCredentialsResult> {
  if (!isPartnerPublishSecretSet()) return refuse(input, "reveal", "PUBLISH_SECRET_NOT_SET", PUBLISH_SECRET_MESSAGE);
  const row = await db.externalStream.findFirst({
    where: { sessionId: input.sessionId, eventId: input.eventId },
    select: { id: true, streamKey: true, secretVersion: true },
  });
  if (!row) return refuse(input, "reveal", "NOT_ISSUED", "This session has no partner stream.");
  apiLogger.info({ eventId: input.eventId, sessionId: input.sessionId, userId: input.userId }, "external-stream:key-shown");
  await audit(input, "EXTERNAL_STREAM_KEY_SHOWN", row.id, { version: row.secretVersion });
  return { ok: true, credentials: externalStreamCredentials(row) };
}

/**
 * Issue a session's partner stream: a new key, working from now until
 * `validUntil`, or until 24 hours after the session's scheduled end when none
 * is given (and then it follows the session if the webinar is moved).
 */
export async function issueExternalStream(
  input: Caller & { issuedTo?: string | null; validUntil?: Date | null; now?: Date },
): Promise<ExternalStreamResult> {
  if (!isPartnerPublishSecretSet()) return refuse(input, "issue", "PUBLISH_SECRET_NOT_SET", PUBLISH_SECRET_MESSAGE);
  if (!isMediamtxControlConfigured()) {
    return refuse(
      input,
      "issue",
      "CONTROL_API_NOT_SET",
      "A partner's stream key cannot be issued yet: the stream server's control address (MEDIAMTX_API_URL and MEDIAMTX_API_SECRET) is not set up, so a running stream could not be cut.",
    );
  }
  const now = input.now ?? new Date();
  if (input.validUntil && input.validUntil.getTime() <= now.getTime()) {
    return refuse(input, "issue", "INVALID_PERIOD", "The key's end date must be in the future.");
  }

  const session = await db.eventSession.findFirst({
    where: { id: input.sessionId, eventId: input.eventId },
    select: { id: true, zoomMeeting: { select: { id: true } }, externalStream: { select: { id: true } } },
  });
  if (!session) return refuse(input, "issue", "SESSION_NOT_FOUND", "Session not found.");
  if (session.externalStream) {
    return refuse(input, "issue", "ALREADY_ISSUED", "This session already has a partner stream. Replace its key instead.");
  }
  if (session.zoomMeeting) {
    return refuse(
      input,
      "issue",
      "ZOOM_WEBINAR_EXISTS",
      "This session has a Zoom webinar. A session streams from our Zoom or from a partner, not both: remove the Zoom webinar first.",
    );
  }

  let row: Row;
  try {
    row = await db.externalStream.create({
      data: {
        sessionId: input.sessionId,
        eventId: input.eventId,
        organizationId: input.organizationId,
        streamKey: newStreamKey(),
        validFrom: now,
        validUntil: input.validUntil ?? null,
        issuedTo: cleanIssuedTo(input.issuedTo),
        createdByUserId: input.userId,
      },
      select: ROW_SELECT,
    });
  } catch (err) {
    // Two people issuing at once: the session's unique row already exists.
    if ((err as { code?: string }).code !== "P2002") throw err;
    return refuse(input, "issue", "ALREADY_ISSUED", "This session already has a partner stream. Replace its key instead.");
  }
  apiLogger.info({ eventId: input.eventId, sessionId: input.sessionId, userId: input.userId }, "external-stream:issued");
  await audit(input, "EXTERNAL_STREAM_ISSUED", row.id, {
    issuedTo: row.issuedTo,
    validUntil: row.validUntil?.toISOString() ?? "follows the session",
  });
  return { ok: true, externalStream: toView(row) };
}

/**
 * Replace the key's password: the value the partner holds is refused at their
 * next connection. The stream key itself, and so the address attendees watch
 * on, stays. The increment is atomic; when two people replace at once the
 * later value is the one that works, and both are in the audit log.
 */
export async function replaceExternalStreamKey(input: Caller): Promise<ExternalStreamResult> {
  const current = await db.externalStream.findFirst({
    where: { sessionId: input.sessionId, eventId: input.eventId },
    select: { id: true, secretVersion: true },
  });
  if (!current) return refuse(input, "replace", "NOT_ISSUED", "This session has no partner stream.");

  // keyReplacedAt is the sweep's evidence: a connection that began before it is on an old password.
  await db.externalStream.updateMany({
    where: { id: current.id, eventId: input.eventId },
    data: { secretVersion: { increment: 1 }, keyReplacedAt: new Date() },
  });
  const row = await db.externalStream.findFirst({ where: { id: current.id, eventId: input.eventId }, select: ROW_SELECT });
  if (!row) return refuse(input, "replace", "NOT_ISSUED", "This session has no partner stream.");

  apiLogger.info(
    { eventId: input.eventId, sessionId: input.sessionId, userId: input.userId, version: row.secretVersion },
    "external-stream:key-replaced",
  );
  // The old password is already refused; now end the stream still running on it.
  const disconnect = await endRunningStream(input, "replace", row.streamKey);
  await audit(input, "EXTERNAL_STREAM_KEY_REPLACED", row.id, {
    fromVersion: current.secretVersion,
    toVersion: row.secretVersion,
    ...disconnectAudit(disconnect),
  });
  return { ok: true, externalStream: toView(row), disconnect };
}

/**
 * Switch the key on or off. Off refuses every new publish and disconnects the
 * one running: this is also "cut the feed" (cutExternalStream below).
 */
export async function setExternalStreamEnabled(input: Caller & { enabled: boolean }): Promise<ExternalStreamResult> {
  const updated = await db.externalStream.updateMany({
    where: { sessionId: input.sessionId, eventId: input.eventId },
    data: { enabled: input.enabled },
  });
  const row = updated.count
    ? await db.externalStream.findFirst({ where: { sessionId: input.sessionId, eventId: input.eventId }, select: ROW_SELECT })
    : null;
  if (!row) return refuse(input, "switch", "NOT_ISSUED", "This session has no partner stream.");

  apiLogger.info(
    { eventId: input.eventId, sessionId: input.sessionId, userId: input.userId, enabled: input.enabled },
    "external-stream:switched",
  );
  if (input.enabled) {
    await audit(input, "EXTERNAL_STREAM_SWITCHED_ON", row.id, {});
    return { ok: true, externalStream: toView(row) };
  }
  const disconnect = await endRunningStream(input, "switch-off", row.streamKey);
  await audit(input, "EXTERNAL_STREAM_SWITCHED_OFF", row.id, disconnectAudit(disconnect));
  return { ok: true, externalStream: toView(row), disconnect };
}

/**
 * Cut the feed: the partner's stream stops and cannot come back until the key
 * is switched on again. The same operation as switching off, under the name
 * the producer's button carries, so there is one rule for ending a stream.
 */
export function cutExternalStream(input: Caller): Promise<ExternalStreamResult> {
  return setExternalStreamEnabled({ ...input, enabled: false });
}

/**
 * Change who the key was handed to, or its end date. `validUntil: null` makes
 * it follow the session again; leaving a field out leaves it as it is.
 */
export async function updateExternalStreamDetails(
  input: Caller & { issuedTo?: string | null; validUntil?: Date | null; now?: Date },
): Promise<ExternalStreamResult> {
  const now = input.now ?? new Date();
  if (input.validUntil && input.validUntil.getTime() <= now.getTime()) {
    return refuse(input, "update", "INVALID_PERIOD", "The key's end date must be in the future.");
  }
  const data = {
    ...(input.issuedTo !== undefined ? { issuedTo: cleanIssuedTo(input.issuedTo) } : {}),
    ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
  };
  const updated = await db.externalStream.updateMany({ where: { sessionId: input.sessionId, eventId: input.eventId }, data });
  const row = updated.count
    ? await db.externalStream.findFirst({ where: { sessionId: input.sessionId, eventId: input.eventId }, select: ROW_SELECT })
    : null;
  if (!row) return refuse(input, "update", "NOT_ISSUED", "This session has no partner stream.");

  apiLogger.info({ eventId: input.eventId, sessionId: input.sessionId, userId: input.userId }, "external-stream:details-updated");
  await audit(input, "EXTERNAL_STREAM_UPDATED", row.id, {
    ...(input.issuedTo !== undefined ? { issuedTo: row.issuedTo } : {}),
    ...(input.validUntil !== undefined ? { validUntil: row.validUntil?.toISOString() ?? "follows the session" } : {}),
  });
  return { ok: true, externalStream: toView(row) };
}
