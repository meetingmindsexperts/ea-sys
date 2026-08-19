/**
 * Zoom Meeting SDK signature generation.
 * Generates JWTs for client-side Meeting SDK embedding.
 * Uses org-level SDK credentials stored in Organization.settings.zoom.
 */

import jwt from "jsonwebtoken";
import { apiLogger } from "@/lib/logger";
import { getZoomCredentials } from "./client";
import { decryptSecret } from "@/lib/eventsair-client";

/**
 * Generate a Zoom Meeting SDK signature.
 * @param sdkKey - The SDK key (public)
 * @param sdkSecret - The SDK secret (decrypted, server-only)
 * @param meetingNumber - The Zoom meeting number (numeric ID)
 * @param role - 0 = attendee, 1 = host
 * @param expiresInSeconds - Token TTL (default 2 hours)
 */
export function generateZoomSignature(
  sdkKey: string,
  sdkSecret: string,
  meetingNumber: string,
  role: 0 | 1,
  expiresInSeconds = 7200,
): string {
  const iat = Math.floor(Date.now() / 1000) - 30; // 30s clock skew buffer
  const exp = iat + expiresInSeconds;

  const payload = {
    sdkKey,
    appKey: sdkKey,
    mn: meetingNumber,
    role,
    iat,
    exp,
    tokenExp: exp,
  };

  return jwt.sign(payload, sdkSecret, { algorithm: "HS256" });
}

/**
 * Generate a Zoom SDK signature using org-level credentials.
 * Returns { sdkKey, signature } or null if SDK not configured for the org.
 */
export async function generateZoomSignatureForOrg(
  organizationId: string,
  meetingNumber: string,
  role: 0 | 1,
): Promise<{ sdkKey: string; signature: string } | null> {
  const credentials = await getZoomCredentials(organizationId);

  // Pick dev or prod SDK credentials based on sdkMode
  const mode = credentials?.sdkMode || "dev";
  const sdkKey = mode === "prod" ? credentials?.sdkKeyProd : credentials?.sdkKeyDev;
  const sdkSecretEncrypted = mode === "prod" ? credentials?.sdkSecretProdEncrypted : credentials?.sdkSecretDevEncrypted;

  // A signature signed with DEVELOPMENT credentials is rejected by Zoom on a
  // production domain, and it fails entirely inside the browser: this function
  // succeeds, the route returns 200 with mode "sdk", and nothing anywhere says
  // the join is doomed. On 2026-08-19 that cost a live webinar test and had to
  // be diagnosed by querying Organization.settings in the production database,
  // because the one fact that mattered appeared in no log.
  //
  // Error, not warn: this is not a degraded path, it is every webinar join on
  // this deployment failing silently, and it stays true until someone changes
  // the setting. It should page.
  if (mode === "dev" && process.env.NODE_ENV === "production") {
    apiLogger.error(
      { organizationId, mode, meetingNumber },
      "zoom:sdk-dev-credentials-on-production — every SDK join will be rejected by Zoom; set SDK mode to prod in Settings > Integrations > Zoom",
    );
  }

  if (!sdkKey || !sdkSecretEncrypted) {
    apiLogger.warn({ organizationId, mode }, "zoom:signature — SDK credentials not configured for org");
    return null;
  }

  try {
    const sdkSecret = decryptSecret(sdkSecretEncrypted);
    const signature = generateZoomSignature(
      sdkKey,
      sdkSecret,
      meetingNumber,
      role,
    );
    // WHICH credentials signed this join. One line, so "why will it not join?"
    // is answerable from /logs instead of from a database query. The sdkKey is
    // not a secret (it is sent to the browser to join with) but only a prefix
    // is logged: enough to tell the dev and prod keys apart at a glance,
    // without pasting a credential into a broadly-readable log surface.
    apiLogger.info(
      {
        organizationId,
        mode,
        meetingNumber,
        role,
        sdkKeyPrefix: sdkKey.slice(0, 6),
      },
      "zoom:signature-generated",
    );
    return { sdkKey, signature };
  } catch (err) {
    apiLogger.error({ err, organizationId, mode }, "zoom:signature-generation-failed");
    return null;
  }
}
