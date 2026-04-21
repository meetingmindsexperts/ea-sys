import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

/**
 * Firebase Cloud Messaging push notification dispatch.
 *
 * Uses the FCM v1 HTTP API directly (no SDK dependency) to keep the bundle lean.
 * Requires FIREBASE_PROJECT_ID and GOOGLE_SERVICE_ACCOUNT_KEY env vars.
 *
 * If FCM is not configured, all calls are silently skipped (graceful degradation).
 */

interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

/** Check if FCM is configured */
function isFcmConfigured(): boolean {
  return !!(
    process.env.FIREBASE_PROJECT_ID &&
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  );
}

/** Get a Google OAuth2 access token for FCM v1 API using service account JWT */
async function getFcmAccessToken(): Promise<string | null> {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) return null;

  // Return cached token if still valid (with 5-minute buffer)
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cachedAccessToken.token;
  }

  try {
    const { createSign } = await import("crypto");
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);

    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT" })
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: serviceAccount.client_email,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      })
    ).toString("base64url");

    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    const signature = signer.sign(serviceAccount.private_key, "base64url");

    const jwt = `${header}.${payload}.${signature}`;

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });

    if (!res.ok) {
      apiLogger.error({ msg: "FCM token exchange failed", status: res.status });
      return null;
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    cachedAccessToken = {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return data.access_token;
  } catch (err) {
    apiLogger.error({ err, msg: "Failed to get FCM access token" });
    return null;
  }
}

/** Send a push notification to a single device token */
async function sendToDevice(
  accessToken: string,
  deviceToken: string,
  payload: PushPayload
): Promise<boolean> {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) return false;

  try {
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: deviceToken,
            notification: {
              title: payload.title,
              body: payload.body,
            },
            data: payload.data,
          },
        }),
      }
    );

    if (!res.ok) {
      const body = await res.text();
      // Token is stale/invalid — clean it up
      if (res.status === 404 || body.includes("UNREGISTERED")) {
        await db.deviceToken
          .deleteMany({ where: { pushToken: deviceToken } })
          .catch((err) =>
            apiLogger.warn({ err, msg: "push: failed to delete stale device token" }),
          );
      }
      return false;
    }

    return true;
  } catch (err) {
    apiLogger.error({ err, msg: "FCM send failed", deviceToken: deviceToken.slice(0, 12) });
    return false;
  }
}

/**
 * Send push notifications to all devices registered for the given user IDs.
 * Fire-and-forget: errors are logged but never thrown.
 */
export async function sendPushToUsers(
  userIds: string[],
  payload: PushPayload
): Promise<void> {
  if (!isFcmConfigured() || userIds.length === 0) return;

  try {
    const accessToken = await getFcmAccessToken();
    if (!accessToken) return;

    const devices = await db.deviceToken.findMany({
      where: { userId: { in: userIds } },
      select: { pushToken: true },
    });

    if (devices.length === 0) return;

    // Send to all devices concurrently (fire-and-forget)
    await Promise.allSettled(
      devices.map((d) => sendToDevice(accessToken, d.pushToken, payload))
    );
  } catch (err) {
    apiLogger.error({ err, msg: "Push notification dispatch failed" });
  }
}
