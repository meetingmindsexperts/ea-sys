import type { Session } from "next-auth";

/** The signed-in person's name as the venue shows it (stored only when they choose to share it). */
export function venueDisplayName(session: Session): string {
  const u = session.user as { firstName?: string | null; lastName?: string | null; name?: string | null };
  return [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.name || "";
}
