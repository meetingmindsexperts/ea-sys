/**
 * Event.code is unique per organisation since Phase 1 of the Budget &
 * Procurement module (Sep 14, 2026): it becomes the QuickBooks Class label and
 * every budget's `eventCode`. Before that it was a free, name-derived string
 * used only as an invoice-number prefix. This file is the ONE place the four
 * writers (events POST, event PUT, MCP create_event, MCP update_event) ask the
 * two questions the index raises: "is this code taken?" and "may this event's
 * code still change?".
 *
 * Owner decision, Sep 14 2026: no automatic codes. A DERIVED code that
 * collides is dropped to null with a warning and the organiser sets one in
 * Settings; an EXPLICIT code that collides is a refusal.
 */
import { db } from "@/lib/db";

export const EVENT_CODE_RE = /^[A-Z0-9-]+$/;
export const EVENT_CODE_MAX = 20;

export async function isEventCodeTaken(
  organizationId: string,
  code: string,
  excludeEventId?: string,
): Promise<boolean> {
  const hit = await db.event.findFirst({
    where: { organizationId, code, ...(excludeEventId ? { id: { not: excludeEventId } } : {}) },
    select: { id: true },
  });
  return !!hit;
}

export type ResolvedEventCode =
  | { ok: true; code: string | null; derivedCollision: string | null }
  | { ok: false; code: "EVENT_CODE_TAKEN" };

/**
 * Explicit code: taken → refuse. Derived code: taken → null (the organiser
 * sets one), reported so the caller can log it. Neither → the code as given.
 */
export async function resolveUniqueEventCode(input: {
  organizationId: string;
  explicitCode: string | null;
  derivedCode: string | null;
  excludeEventId?: string;
}): Promise<ResolvedEventCode> {
  if (input.explicitCode) {
    const taken = await isEventCodeTaken(input.organizationId, input.explicitCode, input.excludeEventId);
    return taken ? { ok: false, code: "EVENT_CODE_TAKEN" } : { ok: true, code: input.explicitCode, derivedCollision: null };
  }
  if (input.derivedCode) {
    const taken = await isEventCodeTaken(input.organizationId, input.derivedCode, input.excludeEventId);
    return taken
      ? { ok: true, code: null, derivedCollision: input.derivedCode }
      : { ok: true, code: input.derivedCode, derivedCollision: null };
  }
  return { ok: true, code: null, derivedCollision: null };
}

/**
 * Immutable once referenced (spec §5): a budget copies the code at creation
 * and QuickBooks keys the event's Class on it. Counts what references it so
 * the refusal can say why.
 */
export async function eventCodeReferences(organizationId: string, eventId: string): Promise<{ budgets: number }> {
  // Org-bound (defence #1) AND meant to run inside the caller's tenant lane:
  // EventBudget is policied, so a bare count outside a lane would read zero on
  // the platform and let a referenced code change (review H2).
  const budgets = await db.eventBudget.count({ where: { eventId, organizationId } });
  return { budgets };
}

/** The race backstop: a concurrent create slipped past the pre-check and the index refused it. */
export function isEventCodeUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { target?: unknown } } | null;
  if (!e || e.code !== "P2002") return false;
  const target = e.meta?.target;
  const cols = Array.isArray(target) ? target.map(String) : typeof target === "string" ? [target] : [];
  return cols.some((c) => c === "code" || c.includes("Event_organizationId_code"));
}
