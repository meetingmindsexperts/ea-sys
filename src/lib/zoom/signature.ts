/**
 * Zoom Meeting SDK signature generation.
 * Generates JWTs for client-side Meeting SDK embedding.
 */

import jwt from "jsonwebtoken";
import { apiLogger } from "@/lib/logger";

const ZOOM_SDK_KEY = process.env.NEXT_PUBLIC_ZOOM_SDK_KEY || "";
const ZOOM_SDK_SECRET = process.env.ZOOM_SDK_SECRET || "";

/**
 * Generate a Zoom Meeting SDK signature for client-side embedding.
 * @param meetingNumber - The Zoom meeting number (numeric ID)
 * @param role - 0 = attendee, 1 = host
 * @param expiresInSeconds - Token TTL (default 2 hours)
 */
export function generateZoomSignature(
  meetingNumber: string,
  role: 0 | 1,
  expiresInSeconds = 7200,
): string | null {
  if (!ZOOM_SDK_KEY || !ZOOM_SDK_SECRET) {
    apiLogger.warn("zoom:signature — ZOOM_SDK_KEY or ZOOM_SDK_SECRET not configured");
    return null;
  }

  const iat = Math.floor(Date.now() / 1000) - 30; // 30s clock skew buffer
  const exp = iat + expiresInSeconds;

  const payload = {
    sdkKey: ZOOM_SDK_KEY,
    appKey: ZOOM_SDK_KEY,
    mn: meetingNumber,
    role,
    iat,
    exp,
    tokenExp: exp,
  };

  return jwt.sign(payload, ZOOM_SDK_SECRET, { algorithm: "HS256" });
}

/**
 * Check if Zoom Meeting SDK environment variables are configured.
 */
export function isZoomSdkConfigured(): boolean {
  return !!(ZOOM_SDK_KEY && ZOOM_SDK_SECRET);
}
