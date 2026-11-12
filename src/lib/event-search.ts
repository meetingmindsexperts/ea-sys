/**
 * The search in the header's event switcher (owner, Nov 12, 2026: "add search
 * in Event Switcher in the header"). The list had grown to about fifty events
 * and was a scroll.
 *
 * An event matches when EVERY word typed appears somewhere in its name, code,
 * address slug, tag, specialty, city or year, in any order, ignoring capitals
 * and accents: "gcc 2026", "hema hub" and "HEMNET" all find their event.
 * Pure and client-safe. The CRM's and the agent page's own event pickers
 * match on the name alone and do not use this.
 */
import { formatDate } from "@/lib/utils";

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

/**
 * The year the switcher's row SHOWS, which is the Dubai date (`formatDate`),
 * not the browser's: an event starting at 00:30 on 1 January in Dubai reads
 * "Jan 1, 2027" and must be found by "2027" from London too. A date that
 * cannot be read gives no year.
 */
function yearOf(startDate: SearchableEvent["startDate"]): string {
  if (!startDate) return "";
  return /(\d{4})$/.exec(formatDate(startDate))?.[1] ?? "";
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
