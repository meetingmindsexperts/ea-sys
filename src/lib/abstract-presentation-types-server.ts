/**
 * Loading an organisation's presentation types on the server (Nov 24, 2026).
 * The rule itself is `abstract-presentation-types.ts`; this file only reads the
 * organisation's settings, the way `person-field-rules.ts` reads its fields.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  defaultPresentationTypes,
  readPresentationTypes,
  type PresentationTypeDef,
} from "@/lib/abstract-presentation-types";

async function readOrganizationTypes(organizationId: string): Promise<PresentationTypeDef[]> {
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  return readPresentationTypes(org?.settings);
}

/**
 * For a READER (a label on a page, an email, an export): on a failed read the
 * five built-ins by their usual names, logged. A label must never fail a send
 * or a download; the worst case is an organisation's own name shown as its key.
 */
export async function loadPresentationTypes(organizationId: string | null | undefined): Promise<PresentationTypeDef[]> {
  if (!organizationId) return defaultPresentationTypes();
  try {
    return await readOrganizationTypes(organizationId);
  } catch (err) {
    apiLogger.error({ err, organizationId, msg: "presentation-types:read-failed" });
    return defaultPresentationTypes();
  }
}

/**
 * For a WRITER that decides whether a type may be stored (a form's save, an
 * import, the assistant): no fallback. A failed read throws, so the request
 * fails and is tried again, rather than refusing an organisation's own type as
 * unknown or accepting one it retired.
 */
export async function loadPresentationTypesStrict(organizationId: string): Promise<PresentationTypeDef[]> {
  return readOrganizationTypes(organizationId);
}

/**
 * The list of the organisation an event belongs to, for a READER that knows
 * only the event (an automatic email). Same fallback as `loadPresentationTypes`.
 */
export async function loadPresentationTypesForEvent(eventId: string): Promise<PresentationTypeDef[]> {
  try {
    const event = await db.event.findUnique({ where: { id: eventId }, select: { organizationId: true } });
    return await loadPresentationTypes(event?.organizationId);
  } catch (err) {
    apiLogger.error({ err, eventId, msg: "presentation-types:event-read-failed" });
    return defaultPresentationTypes();
  }
}
