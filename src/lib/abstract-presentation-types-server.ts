/**
 * Loading an organisation's presentation types on the server (Nov 24, 2026).
 * The rule itself is `abstract-presentation-types.ts`; this file only reads the
 * organisation's settings, the way `person-field-rules.ts` reads its fields.
 *
 * Two kinds of caller:
 *  - a READER (a name on a page, an email, an export) gets the five built-ins
 *    on any failure, logged, and is served from a short per-process cache: a
 *    bulk decision emails up to 500 authors and each email names the type
 *    (review of 89d803698). A rename shows within READER_CACHE_MS.
 *  - a WRITER that decides what may be stored (`loadPresentationTypesStrict`)
 *    always reads the database and throws when it cannot, so a door fails and
 *    is tried again rather than judging a type against the wrong list.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  defaultPresentationTypes,
  readPresentationTypes,
  type PresentationTypeDef,
} from "@/lib/abstract-presentation-types";

export const READER_CACHE_MS = 30_000;
const MAX_CACHED = 500;

const byOrganization = new Map<string, { at: number; types: PresentationTypeDef[] }>();
const organizationOfEvent = new Map<string, { at: number; organizationId: string }>();

function fresh<T extends { at: number }>(entry: T | undefined): T | undefined {
  return entry && Date.now() - entry.at < READER_CACHE_MS ? entry : undefined;
}

function remember<K, V>(map: Map<K, V>, key: K, value: V) {
  if (map.size >= MAX_CACHED) map.clear();
  map.set(key, value);
}

/** For tests, and after a save of the list (step 3 of the plan). */
export function resetPresentationTypeCache(): void {
  byOrganization.clear();
  organizationOfEvent.clear();
}

/** The organisation's list, or null when no organisation has that id (or this lane cannot see it). */
async function readOrganizationTypes(organizationId: string): Promise<PresentationTypeDef[] | null> {
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  return org ? readPresentationTypes(org.settings) : null;
}

/** For a READER: the five built-ins on any failure, logged. */
export async function loadPresentationTypes(organizationId: string | null | undefined): Promise<PresentationTypeDef[]> {
  if (!organizationId) return defaultPresentationTypes();
  const cached = fresh(byOrganization.get(organizationId));
  if (cached) return cached.types;
  try {
    const types = await readOrganizationTypes(organizationId);
    if (!types) {
      apiLogger.warn({ msg: "presentation-types:organization-not-found", organizationId });
      return defaultPresentationTypes();
    }
    remember(byOrganization, organizationId, { at: Date.now(), types });
    return types;
  } catch (err) {
    apiLogger.error({ err, organizationId, msg: "presentation-types:read-failed" });
    return defaultPresentationTypes();
  }
}

/**
 * For a WRITER that decides whether a type may be stored (a form's save, an
 * import, the assistant): never cached, no fallback. A failed read, or no
 * organisation found, throws, so the request fails and is tried again, rather
 * than refusing an organisation's own type as unknown or accepting one it
 * retired.
 */
export async function loadPresentationTypesStrict(organizationId: string): Promise<PresentationTypeDef[]> {
  const types = await readOrganizationTypes(organizationId);
  if (!types) throw new Error(`presentation-types: no organisation ${organizationId} in this lane`);
  return types;
}

/**
 * The list of the organisation an event belongs to, for a READER that knows
 * only the event (an automatic email). Same fallback and cache as `loadPresentationTypes`.
 */
export async function loadPresentationTypesForEvent(eventId: string): Promise<PresentationTypeDef[]> {
  const cached = fresh(organizationOfEvent.get(eventId));
  if (cached) return loadPresentationTypes(cached.organizationId);
  try {
    const event = await db.event.findUnique({ where: { id: eventId }, select: { organizationId: true } });
    if (!event) {
      apiLogger.warn({ msg: "presentation-types:event-not-found", eventId });
      return defaultPresentationTypes();
    }
    remember(organizationOfEvent, eventId, { at: Date.now(), organizationId: event.organizationId });
    return await loadPresentationTypes(event.organizationId);
  } catch (err) {
    apiLogger.error({ err, eventId, msg: "presentation-types:event-read-failed" });
    return defaultPresentationTypes();
  }
}
