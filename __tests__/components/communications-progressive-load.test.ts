import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The Communications page draws each card as its own list arrives (Nov 23,
 * 2026). It used to draw nothing until registrations, speakers, abstracts and
 * reviewers were all in, so the largest list held back the cards that were
 * ready.
 *
 * Two things can undo that quietly, and both are read from the source here:
 * a page-wide wait coming back, and an action left OUTSIDE its card's wait,
 * where it could open a send on a list that has not arrived (a count of 0
 * that means "not loaded yet").
 */
const SOURCE = readFileSync("src/app/(dashboard)/events/[eventId]/communications/page.tsx", "utf8");

/** The source between a card's opening wait and the next closing tag. */
function cardBody(what: string): string {
  const open = SOURCE.indexOf(`what="${what}">`);
  expect(open, `the ${what} card waits for its own list`).toBeGreaterThan(-1);
  const close = SOURCE.indexOf("</WhenListArrives>", open);
  expect(close).toBeGreaterThan(open);
  return SOURCE.slice(open, close);
}

describe("Communications page: each card waits for its own list", () => {
  it("has no page-wide wait", () => {
    expect(SOURCE).not.toMatch(/if \(isLoading\)/);
    expect(SOURCE).not.toMatch(/const isLoading\s*=/);
  });

  it.each([
    ["registrations", "registrationsLoading"],
    ["speakers", "speakersLoading"],
    ["abstracts", "abstractsLoading"],
    ["reviewers", "reviewersLoading"],
  ])("the %s card waits for %s and nothing else", (what, flag) => {
    expect(SOURCE).toContain(`<WhenListArrives loading={${flag}} what="${what}">`);
  });

  it("there are exactly four waits, one per list", () => {
    expect(SOURCE.match(/<WhenListArrives /g)).toHaveLength(4);
    expect(SOURCE.match(/<\/WhenListArrives>/g)).toHaveLength(4);
  });

  it.each([
    ["registrations", ['openEmailDialog("registrations")', 'openTileDialog("registrations", tile)', 'renderSavedTemplates("registrations")', "setSelectByIdsOpen(true)"]],
    ["speakers", ['openEmailDialog("speakers")', 'openTileDialog("speakers", tile)', 'renderSavedTemplates("speakers")']],
    ["abstracts", ['openEmailDialog("abstracts")', "setAbstractPickerOpen(true)"]],
    ["reviewers", ['openEmailDialog("reviewers")']],
  ])("every way to start a send to %s sits inside that card's wait", (what, actions) => {
    const body = cardBody(what);
    for (const action of actions) {
      expect(body, `${action} is inside the ${what} wait`).toContain(action);
      // And nowhere else in what the page renders: one door per action.
      expect(SOURCE.split(action).length - 1, `${action} appears once`).toBe(1);
    }
  });

  it("a headline number shows a placeholder, never a 0, while its list is on the way", () => {
    for (const stat of [
      "<StatNumber loading={registrationsLoading} value={registrations.length} />",
      "<StatNumber loading={registrationsLoading} value={paymentSummary.paid} />",
      "<StatNumber loading={registrationsLoading} value={unpaidRegistrations.length} />",
      "<StatNumber loading={speakersLoading} value={speakers.length} />",
    ]) {
      expect(SOURCE).toContain(stat);
    }
  });
});
