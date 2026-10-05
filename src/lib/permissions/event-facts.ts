import type { EventFacts } from "./can";

/**
 * The facts `can()` judges an event scope by, from an event row or the event
 * GET's staff shape: organisation, type, and the assigned desk staff
 * (`staffUserIds` and `settings.onsiteUserIds`). Pure: shared by the screens (`useCan`) and the
 * server (the agent's tool gate).
 */
export function eventFactsOf(event: unknown): EventFacts | null {
  if (!event || typeof event !== "object") return null;
  const e = event as { organizationId?: unknown; eventType?: unknown; settings?: unknown; staffUserIds?: unknown };
  if (typeof e.organizationId !== "string") return null;
  const settings = (e.settings && typeof e.settings === "object" ? e.settings : {}) as { onsiteUserIds?: unknown };
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  // Assigned staff from the event GET's `staffUserIds` (the table) and the JSON
  // it replaces, during the Phase 4 transition.
  const staff = Array.from(new Set([...strings(e.staffUserIds), ...strings(settings.onsiteUserIds)]));
  return { organizationId: e.organizationId, eventType: typeof e.eventType === "string" ? e.eventType : "", staffUserIds: staff };
}
