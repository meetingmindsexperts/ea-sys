import { NextResponse } from "next/server";

/**
 * Returns a 403 Forbidden response if the user has a restricted role
 * (REVIEWER, SUBMITTER, or REGISTRANT).
 * These roles are only allowed limited operations — all other
 * write operations (POST, PUT, DELETE) on non-abstract resources must
 * call this guard before proceeding.
 *
 * Usage:
 *   const denied = denyReviewer(session);
 *   if (denied) return denied;
 */
export function denyReviewer(session: { user?: { role?: string } } | null) {
  const role = session?.user?.role;
  if (role === "REVIEWER" || role === "SUBMITTER" || role === "REGISTRANT") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}
