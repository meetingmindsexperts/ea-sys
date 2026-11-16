/**
 * Whether THIS server can run a partner's stream (Nov 16, 2026; external
 * streams step 5). Server-only: it reads the environment.
 *
 * A partner's key is issued only when both are set (external-stream-service.ts):
 *   STREAM_PUBLISH_SECRET   signs the partner's password, never the sign-in secret
 *   MEDIAMTX_API_URL + MEDIAMTX_API_SECRET
 *                           the stream server's control address, so a running
 *                           stream can be cut
 *
 * The "streamed by a partner" choice is offered at creation only when this says
 * ready. A partner webinar is fixed at creation and cannot stream without its
 * key, so offering it on a server that cannot issue one creates a webinar with
 * no way to go live (review of 8bcf9cf8, HIGH). The events route refuses on the
 * same answer; the new-event form reads it through
 * GET /api/events/partner-stream-availability, because the form is a client
 * component and must never read process.env itself.
 */
import { isPartnerPublishSecretSet } from "@/lib/webinar/livestream";
import { isMediamtxControlConfigured } from "@/lib/webinar/mediamtx-control";

export type PartnerStreamMissing = "STREAM_PUBLISH_SECRET" | "MEDIAMTX_CONTROL";

export interface PartnerStreamReadiness {
  ready: boolean;
  missing: PartnerStreamMissing[];
}

export function partnerStreamReadiness(): PartnerStreamReadiness {
  const missing: PartnerStreamMissing[] = [];
  if (!isPartnerPublishSecretSet()) missing.push("STREAM_PUBLISH_SECRET");
  if (!isMediamtxControlConfigured()) missing.push("MEDIAMTX_CONTROL");
  return { ready: missing.length === 0, missing };
}
