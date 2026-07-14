/**
 * Build + runtime identity — "what exactly is serving this request?"
 *
 * The first question in any incident is "what changed", and until now the
 * running system could not answer it. `/api/health` reported
 * `npm_package_version` ("0.4.x"), which is the same string across dozens of
 * deploys. deploy.sh knew the git SHA (it pins IMAGE_TAG to it) and threw it
 * away.
 *
 * So: CI passes GIT_SHA as a Docker build-arg, the Dockerfile bakes it into
 * ENV, and this module reads it. Surfaced in /api/health, on /admin/infra, and
 * in the footer of every admin alert email.
 *
 * Server-only by convention (reads process.env at call time, no NEXT_PUBLIC_).
 * Safe to import anywhere on the server; returns honest "unknown" values in dev
 * and in any container built without the build-arg, rather than lying.
 */

import os from "os";

export interface BuildInfo {
  /** Full 40-char git SHA of the deployed commit, or "unknown" outside Docker. */
  gitSha: string;
  /** First 7 chars — what you actually paste into `git show`. */
  gitShaShort: string;
  /** UTC ISO timestamp of the image build, or null if not baked in. */
  builtAt: string | null;
  /** Blue/green slot this container is running as, or null if not set. */
  slot: string | null;
  /** Container hostname — which of the two slots actually answered. */
  hostname: string;
  /** package.json version. Kept for backward compat with /api/health. */
  version: string;
}

const UNKNOWN = "unknown";

export function getBuildInfo(): BuildInfo {
  const gitSha = (process.env.GIT_SHA ?? "").trim() || UNKNOWN;
  const builtAt = (process.env.BUILT_AT ?? "").trim() || null;
  const slot = (process.env.EA_SYS_SLOT ?? "").trim() || null;

  return {
    gitSha,
    gitShaShort: gitSha === UNKNOWN ? UNKNOWN : gitSha.slice(0, 7),
    builtAt,
    slot,
    hostname: os.hostname(),
    version: process.env.npm_package_version ?? "0.0.0",
  };
}

/**
 * One-line identity string for log lines and email footers:
 *   "blue @ 7b4ff6b (ea-sys-blue)"
 */
export function buildInfoLine(): string {
  const b = getBuildInfo();
  const where = b.slot ? `${b.slot} @ ` : "";
  return `${where}${b.gitShaShort} (${b.hostname})`;
}

/** Absolute base URL of the dashboard, for deep links in alert emails. */
export function appBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXTAUTH_URL ??
    "https://events.meetingmindsgroup.com"
  ).replace(/\/+$/, "");
}
