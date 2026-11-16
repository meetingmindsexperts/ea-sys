/**
 * The words for a partner-streamed webinar that cannot be created here
 * (Nov 12, 2026; review of 8bcf9cf8, HIGH). Client-safe.
 *
 * Whether the choice is offered is a property of the SERVER, not of the code:
 * partnerStreamReadiness() in partner-stream-readiness.ts (server-only). Until
 * Nov 16, 2026 it was a constant here, switched off while the console could not
 * issue a key (step 5 of docs/EXTERNAL_STREAM_AND_PRERECORDED_PLAN.md built it).
 */
export const PARTNER_STREAM_NOT_OFFERED_MESSAGE =
  "A webinar streamed by a partner cannot be created on this server yet: the stream server is not set up to issue a partner's stream key. Ask the system administrator.";
