import { can, type EventFacts, type Principal } from "@/lib/permissions/can";
import { NO_SUBMISSIONS, type SubmissionVisibility } from "@/lib/speaker-submission-visibility";

/**
 * The tools that answer on `events.read` but carry abstracts inside: an
 * event search returns titles, statuses and authors, the stats a count per
 * status. Like the speakers list (owner, Oct 27, 2026), those need
 * `abstracts.read` on the event, so the abstracts part is removed for a caller
 * without it. Both doors apply it: the in-app agent and a role-bound MCP key.
 */
const ABSTRACT_PARTS: Readonly<Record<string, (value: Record<string, unknown>) => Record<string, unknown>>> = {
  search_event: (v) => {
    const results = v.results as Record<string, unknown[]> | undefined;
    if (!results?.abstracts) return v;
    const { abstracts, ...rest } = results;
    const totalFound = typeof v.totalFound === "number" ? v.totalFound - abstracts.length : v.totalFound;
    return { ...v, results: rest, totalFound };
  },
  get_event_stats: (v) => {
    const { abstracts: _hidden, ...rest } = v;
    void _hidden;
    return rest;
  },
};

/** The MCP resources that answer on another key but carry an abstract count (the event info). */
const RESOURCE_ABSTRACT_PARTS: Readonly<Record<string, (value: Record<string, unknown>) => Record<string, unknown>>> = {
  "event-info": (v) => {
    const count = v._count as Record<string, unknown> | undefined;
    if (!count || !("abstracts" in count)) return v;
    const { abstracts: _hidden, ...rest } = count;
    void _hidden;
    return { ...v, _count: rest };
  },
};

export function toolCarriesSubmissions(toolName: string): boolean {
  return toolName in ABSTRACT_PARTS;
}

export function resourceCarriesSubmissions(name: string): boolean {
  return name in RESOURCE_ABSTRACT_PARTS;
}

type ResourceResult = { contents?: { text?: unknown }[] };

/** A resource read without the abstract count the caller may not read. */
export function redactSubmissionsInResource<T>(name: string, result: T, visible: SubmissionVisibility): T {
  const strip = RESOURCE_ABSTRACT_PARTS[name];
  const contents = (result as ResourceResult | null)?.contents;
  if (!strip || visible.abstracts || !Array.isArray(contents)) return result;
  return {
    ...(result as object),
    contents: contents.map((c) => {
      if (typeof c.text !== "string") return c;
      try {
        const value = JSON.parse(c.text) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) return c;
        return { ...c, text: JSON.stringify(strip(value as Record<string, unknown>), null, 2) };
      } catch {
        return c;
      }
    }),
  } as T;
}

/** What the caller may see of the submissions on this event; no event found sees nothing. */
export function submissionVisibilityOnFacts(principal: Principal, facts: EventFacts | null | undefined): SubmissionVisibility {
  if (!facts) return NO_SUBMISSIONS;
  return {
    abstracts: can(principal, "abstracts.read", { event: facts }),
    proposals: can(principal, "proposals.read", { event: facts }),
  };
}

/** A tool's JSON text without the abstracts the caller may not read. Plain text passes through. */
export function redactSubmissionsInToolText(toolName: string, text: string, visible: SubmissionVisibility): string {
  const strip = ABSTRACT_PARTS[toolName];
  if (!strip || visible.abstracts) return text;
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return text;
    return JSON.stringify(strip(value as Record<string, unknown>), null, 2);
  } catch {
    return text;
  }
}
