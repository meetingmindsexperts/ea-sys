import type { SessionServiceErrorCode } from "@/services/session-service";

/**
 * Session-service error code → HTTP status, shared by the sessions POST route
 * and the [sessionId] PUT route (it used to be copy-pasted in both — adding a
 * new code meant editing two files or silently falling back to 500).
 *
 * Lives at the boundary layer, not in the service: the service never knows
 * about HTTP (src/services/README.md). The Record is exhaustive over
 * SessionServiceErrorCode, so a new service code without a mapping fails the
 * build instead of shipping a 500.
 */
export const HTTP_STATUS_FOR_SESSION_ERROR: Record<SessionServiceErrorCode, number> = {
  EVENT_NOT_FOUND: 404,
  SESSION_NOT_FOUND: 404,
  INVALID_TIME_RANGE: 400,
  OUTSIDE_EVENT_DATES: 400,
  TRACK_NOT_FOUND: 404,
  ABSTRACT_NOT_FOUND: 404,
  ABSTRACT_ALREADY_ASSIGNED: 400,
  SPEAKERS_NOT_FOUND: 404,
  INVALID_CAPACITY: 400,
  DUPLICATE_SPEAKER_ID: 400,
  BREAK_ITEM_HAS_PROGRAM: 400,
  WEBINAR_ANCHOR_SESSION: 409,
  STALE_WRITE: 409,
  UNKNOWN: 500,
};
