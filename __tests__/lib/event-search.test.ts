/**
 * The header's event switcher search (owner, Nov 12, 2026): every word typed
 * must appear somewhere in the event's name, code, slug, tag, specialty, city
 * or year, in any order, ignoring capitals and accents.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eventMatchesSearch, filterEventsBySearch } from "@/lib/event-search";

const GCC = { id: "1", name: "4th GCC Hematology Hub 2026", slug: "gcc-hh26", code: "GCCHH", city: "Dubai", specialty: "Hematology", startDate: "2026-11-20T05:00:00.000Z" };
const HEMNET = { id: "2", name: "Haemophilia Eastern Mediterranean Network Forum (HEMNET 2026)", slug: "hemnet-2026", city: "Abu Dhabi", startDate: "2026-12-04T05:00:00.000Z" };
const CAFE = { id: "3", name: "Café Scientifique: Néphrologie", slug: "cafe-nephro", tag: "Webinar", startDate: "2027-01-15T12:00:00.000Z" };
const ALL = [GCC, HEMNET, CAFE];

describe("eventMatchesSearch", () => {
  it("an empty or blank search matches every event", () => {
    expect(filterEventsBySearch(ALL, "")).toEqual(ALL);
    expect(filterEventsBySearch(ALL, "   ")).toEqual(ALL);
  });

  it.each([
    ["gcc", ["1"]],
    ["HEMNET", ["2"]],
    ["hub gcc", ["1"]],
    ["hema 2026", ["1"]],
    ["2026", ["1", "2"]],
    ["2027", ["3"]],
    ["abu dhabi", ["2"]],
    ["gcc-hh26", ["1"]],
    ["GCCHH", ["1"]],
    ["webinar", ["3"]],
    ["cafe nephrologie", ["3"]],
    ["Café", ["3"]],
    ["cardiology", []],
    ["gcc hemnet", []],
  ])("%j finds %j", (query, ids) => {
    expect(filterEventsBySearch(ALL, query).map((e) => e.id)).toEqual(ids);
  });

  it("survives missing optional fields and a bad date", () => {
    expect(eventMatchesSearch({ name: "Plain", startDate: "not a date" }, "plain")).toBe(true);
    expect(eventMatchesSearch({ name: "Plain", slug: null, code: null }, "nan")).toBe(false);
    // A date that cannot be read contributes no year: never the text "NaN".
    expect(eventMatchesSearch({ name: "Plain", startDate: "not a date" }, "nan")).toBe(false);
  });

  it("the year is the one the row shows (Dubai), whatever the browser's timezone", () => {
    // 31 Dec 2026 20:30 UTC is 1 Jan 2027 00:30 in Dubai: the row reads "Jan 1, 2027".
    const newYear = { name: "New Year Forum", startDate: "2026-12-31T20:30:00.000Z" };
    expect(eventMatchesSearch(newYear, "2027")).toBe(true);
    expect(eventMatchesSearch(newYear, "2026")).toBe(false);
  });
});

describe("the header uses the searchable switcher", () => {
  const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

  it("renders EventSwitcher, which filters with the one rule", () => {
    expect(read("src/components/layout/header.tsx")).toContain("<EventSwitcher");
    const switcher = read("src/components/layout/event-switcher.tsx");
    expect(switcher).toContain("filterEventsBySearch(events, search)");
    expect(switcher).toContain("shouldFilter={false}");
    // The link sits after the Command closes: inside it, Enter picks an event instead of following the link.
    expect(switcher.indexOf("</Command>")).toBeLessThan(switcher.indexOf('href="/events"'));
  });
});

describe("Registrations: Email All goes to Communications", () => {
  it("links there when nothing is ticked, and still composes in place for ticked or narrowed rows", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(dashboard)/events/[eventId]/registrations/page.tsx"), "utf8");
    expect(page).toContain("<Link href={`/events/${eventId}/communications`}>");
    expect(page).toContain("return selectedCount === 0 && !narrowed && !listFiltered;");
    // Only for someone who can open Communications (templates.read), and never with a list filter on.
    expect(page).toContain("canOpenCommunications && emailsEveryone(selectedIds.size, completionNarrowed, listFiltered)");
    expect(page).toContain("!emailAllGoesToCommunications && (");
  });
});
