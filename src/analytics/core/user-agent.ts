/**
 * Coarse device, browser and OS classification.
 *
 * CLIENT-SAFE. No node: imports, and no dependency.
 *
 * Hand-rolled rather than pulling in ua-parser-js, for two reasons. The core
 * directory is meant to be extractable as a standalone package, and a
 * zero-dependency core is a materially easier thing to publish. And the
 * accuracy a full parser buys is accuracy we do not use: this answers "is the
 * register page being opened on phones" and "which browser families do we need
 * to test", not "which exact Chrome build".
 *
 * So it is deliberately coarse, and being wrong about an unusual agent costs
 * nothing. What it must NOT do is grow into a fingerprinting surface: the
 * output is three low-cardinality strings, and it should stay that way.
 */

import type { DeviceType } from "./types";

export interface UserAgentInfo {
  deviceType: DeviceType;
  browser: string;
  os: string;
}

const UNKNOWN: UserAgentInfo = { deviceType: "desktop", browser: "Unknown", os: "Unknown" };

/**
 * Tablets are checked BEFORE phones, because an iPad's user agent contains
 * neither "iphone" nor, on modern iPadOS, even "ipad": it claims to be a Mac
 * and is distinguished by the presence of touch, which we cannot see here.
 * Android tablets say "android" without "mobile". Getting this order wrong
 * silently reclassifies every tablet as a phone.
 */
function deviceOf(ua: string): DeviceType {
  if (/ipad|tablet|playbook|silk|kindle/.test(ua)) return "tablet";
  if (/android(?!.*mobile)/.test(ua)) return "tablet";
  if (/mobi|iphone|ipod|windows phone|blackberry|opera mini/.test(ua)) return "mobile";
  return "desktop";
}

/**
 * Order matters throughout. Nearly every browser claims to be several others
 * for historical reasons: Edge contains "chrome" and "safari", Chrome contains
 * "safari", so the most specific claim has to be tested first or everything
 * collapses into Safari.
 */
function browserOf(ua: string): string {
  if (/edg[ea]?\//.test(ua)) return "Edge";
  if (/opr\/|opera/.test(ua)) return "Opera";
  if (/samsungbrowser/.test(ua)) return "Samsung Internet";
  if (/firefox|fxios/.test(ua)) return "Firefox";
  if (/chrome|crios|chromium/.test(ua)) return "Chrome";
  if (/safari/.test(ua)) return "Safari";
  return "Unknown";
}

function osOf(ua: string): string {
  if (/windows nt|windows phone/.test(ua)) return "Windows";
  if (/android/.test(ua)) return "Android";
  // iPhone and iPad before macOS: iPadOS reports itself as "Macintosh".
  if (/iphone|ipad|ipod|ios/.test(ua)) return "iOS";
  if (/mac os x|macintosh/.test(ua)) return "macOS";
  if (/cros/.test(ua)) return "ChromeOS";
  if (/linux|ubuntu|debian|fedora/.test(ua)) return "Linux";
  return "Unknown";
}

export function parseUserAgent(userAgent: string | null | undefined): UserAgentInfo {
  if (!userAgent) return UNKNOWN;
  const ua = userAgent.trim().toLowerCase();
  if (ua === "" || ua === "-") return UNKNOWN;
  return { deviceType: deviceOf(ua), browser: browserOf(ua), os: osOf(ua) };
}
