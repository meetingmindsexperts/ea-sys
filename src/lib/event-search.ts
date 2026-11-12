/**
 * The search in the header's event switcher (owner, Nov 12, 2026: "add search
 * in Event Switcher in the header"). The list had grown to about fifty events
 * and was a scroll.
 *
 * An event matches when EVERY word typed appears somewhere in its name, code,
 * address slug, tag, specialty, city or year, in any order, ignoring capitals
 * and accents: "gcc 2026", "hema hub" and "HEMNET" all find their event.
 * Pure and client-safe.
 */
export interface SearchableEvent {
  name: string;
  slug?: string | null;
  code?: string | null;
  tag?: string | null;
  specialty?: string | null;
  city?: string | null;
  startDate?: string | Date | null;
}

function fold(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function yearOf(startDate: SearchableEvent["startDate"]): string {
  if (!startDate) return "";
  const year = new Date(startDate).getFullYear();
  return Number.isFinite(year) ? String(year) : "";
}

export function eventMatchesSearch(event: SearchableEvent, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fold(
    [event.name, event.code, event.slug, event.tag, event.specialty, event.city, yearOf(event.startDate)].filter(Boolean).join(" "),
  );
  return words.every((word) => haystack.includes(word));
}

export function filterEventsBySearch<T extends SearchableEvent>(events: readonly T[], query: string): T[] {
  return events.filter((event) => eventMatchesSearch(event, query));
}
