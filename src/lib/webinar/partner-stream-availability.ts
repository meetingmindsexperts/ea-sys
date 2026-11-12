/**
 * Whether "A partner streams from their own platform" may be chosen when a
 * webinar is created (Nov 12, 2026; review of 8bcf9cf8, HIGH).
 *
 * NOT YET. The choice is fixed at creation, and a partner-produced webinar is
 * useless until its stream key can be issued, which is the console's Partner
 * stream card (step 5 of docs/EXTERNAL_STREAM_AND_PRERECORDED_PLAN.md). Offered
 * before that, an organiser could create a real webinar that cannot stream:
 * the room refuses to open, attendees are told there is nothing to join, the
 * five emails go out anyway, and the only way back is deleting the event.
 *
 * The form hides the choice and the events route refuses it while this is
 * false. Everything behind it (the provisioner, the one-source rule, the
 * attendee's join) is built and tested, and is reached by tests through the
 * service. Step 5 turns this on, and should then also require the server to be
 * set up (STREAM_PUBLISH_SECRET and the stream server's control address), or
 * the same dead end comes back on a server that cannot issue a key.
 *
 * Client-safe: imported by the new-event form.
 */
export const PARTNER_STREAM_CHOICE_OFFERED = false;

export const PARTNER_STREAM_NOT_OFFERED_MESSAGE =
  "A webinar streamed by a partner cannot be created yet: issuing the partner's stream key is not available in the Webinar Console.";
