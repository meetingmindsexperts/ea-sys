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

  if (!credentials?.sdkKey || !credentials?.sdkSecretEncrypted) {
    apiLogger.warn({ organizationId }, "zoom:signature — SDK credentials not configured for org");
    return null;
  }

  try {
    const sdkSecret = decryptSecret(credentials.sdkSecretEncrypted);
    const signature = generateZoomSignature(
      credentials.sdkKey,
      sdkSecret,
      meetingNumber,
      role,
    );
    return { sdkKey: credentials.sdkKey, signature };
  } catch (err) {
    apiLogger.error({ err, organizationId }, "zoom:signature-generation-failed");
    return null;
  }
}
