/**
 * The one writer of `settings.webinar.handouts` (Oct 6, 2026). Each change
 * runs under a row lock on the event and rewrites only the `handouts` key, so
 * two producers adding files at once cannot drop each other's, and other
 * webinar settings are never touched. Server only.
 */
import { tenantTransaction } from "@/lib/db";
import { readWebinarSettings } from "@/lib/webinar";
import { readHandouts, type WebinarHandout } from "./handouts";

/**
 * Apply `change` to the event's current handout list. `change` returns the new
 * list, or a string to refuse (nothing is written). Returns the stored list.
 */
export async function updateHandouts(
  eventId: string,
  change: (current: WebinarHandout[]) => WebinarHandout[] | string,
): Promise<{ ok: true; handouts: WebinarHandout[] } | { ok: false; reason: string }> {
  return tenantTransaction(async (tx) => {
    const rows = await tx.$queryRaw<{ settings: unknown }[]>`
      SELECT settings FROM "Event" WHERE id = ${eventId} FOR UPDATE`;
    if (rows.length === 0) return { ok: false as const, reason: "event-not-found" };
    const next = change(readHandouts(readWebinarSettings(rows[0].settings)));
    if (typeof next === "string") return { ok: false as const, reason: next };
    await tx.$executeRaw`
      UPDATE "Event"
      SET settings = jsonb_set(
        jsonb_set(COALESCE(settings, '{}'::jsonb), '{webinar}', COALESCE(settings->'webinar', '{}'::jsonb)),
        '{webinar,handouts}',
        ${JSON.stringify(next)}::jsonb
      )
      WHERE id = ${eventId}`;
    return { ok: true as const, handouts: next };
  });
}
