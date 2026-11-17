/**
 * The search box on the Abstracts page (Nov 17, 2026).
 *
 * The page holds every abstract of the event already (up to 500), so the
 * search is a filter over that list, not a request. It reads what the row
 * shows and what an organiser is likely to have in hand: the abstract number,
 * the title, the author's name and email, the co-authors, and the theme,
 * sub-theme and track.
 *
 * Every word typed must appear somewhere ("ahmed poster" finds Ahmed's
 * abstract in the Poster theme), case and accents ignored. A number finds the
 * abstract with that number however it is typed: "12", "012", "A-12", "a012".
 *
 * Pure and client-safe.
 */
import { formatAbstractSerial } from "@/lib/abstract-serial";

export interface SearchableAbstract {
  serialId: number | null;
  title: string;
  speaker: { firstName: string; lastName: string; email?: string | null };
  theme?: { name: string } | null;
  subTheme?: { name: string } | null;
  track?: { name: string } | null;
  coAuthors?: ReadonlyArray<{ firstName?: string | null; lastName?: string | null }> | null;
}

/** Lower case, accents removed, spaces collapsed: "José  Núñez" reads as "jose nunez". */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** "A-12", "a012", "#12" and "12" all mean abstract number 12; anything else is not a number. */
function serialFromTerm(term: string): number | null {
  const m = /^(?:a-?|#)?0*(\d{1,9})$/.exec(term);
  return m ? Number(m[1]) : null;
}

function haystack(abstract: SearchableAbstract): string {
  const coAuthors = (abstract.coAuthors ?? []).map((c) => `${c.firstName ?? ""} ${c.lastName ?? ""}`);
  return fold(
    [
      abstract.serialId == null ? "" : formatAbstractSerial(abstract.serialId),
      abstract.title,
      `${abstract.speaker.firstName} ${abstract.speaker.lastName}`,
      abstract.speaker.email ?? "",
      abstract.theme?.name ?? "",
      abstract.subTheme?.name ?? "",
      abstract.track?.name ?? "",
      ...coAuthors,
    ].join(" \n "),
  );
}

/** Does this abstract match what was typed? An empty search matches everything. */
export function abstractMatchesSearch(abstract: SearchableAbstract, query: string): boolean {
  const terms = fold(query).split(" ").filter(Boolean);
  if (terms.length === 0) return true;
  const text = haystack(abstract);
  return terms.every((term) => {
    const serial = serialFromTerm(term);
    if (serial !== null && abstract.serialId === serial) return true;
    return text.includes(term);
  });
}
