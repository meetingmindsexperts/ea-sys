import type { EventFacts } from "./can";

/**
 * The facts `can()` judges an event scope by, from an event row or the event
 * GET's staff shape: organisation, type, and the assigned desk staff
 * (`settings.onsiteUserIds`). Pure: shared by the screens (`useCan`) and the
 * server (the agent's tool gate).
 */
export function eventFactsOf(event: unknown): EventFacts | null {
  if (!event || typeof event !== "object") return null;
  const e = event as { organizationId?: unknown; eventType?: unknown; settings?: unknown };
  if (typeof e.organizationId !== "string") return null;
  const settings = (e.settings && typeof e.settings === "object" ? e.settings : {}) as { onsiteUserIds?: unknown };
  const staff = Array.isArray(settings.onsiteUserIds) ? settings.onsiteUserIds.filter((x): x is string => typeof x === "string") : [];
  return { organizationId: e.organizationId, eventType: typeof e.eventType === "string" ? e.eventType : "", staffUserIds: staff };
}
