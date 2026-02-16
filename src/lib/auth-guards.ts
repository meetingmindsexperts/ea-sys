import { NextResponse } from "next/server";

/**
 * Returns a 403 Forbidden response if the user has the REVIEWER or SUBMITTER role.
 * These restricted roles are only allowed to read/update abstracts — all other
 * write operations (POST, PUT, DELETE) on non-abstract resources must
 * call this guard before proceeding.
 *
 * Usage:
 *   const denied = denyReviewer(session);
 *   if (denied) return denied;
 */
export function denyReviewer(session: { user?: { role?: string } } | null) {
  const role = session?.user?.role;
  if (role === "REVIEWER" || role === "SUBMITTER") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}
