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
  const open = SOURCE.indexOf(`what="${what}" placeholder=`);
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
    ["registrations", "registrationsState"],
    ["speakers", "speakersState"],
    ["abstracts", "abstractsState"],
    ["reviewers", "reviewersState"],
  ])("the %s card shows its body only for %s", (what, flag) => {
    expect(SOURCE).toContain(`<WhenListArrives state={${flag}} what="${what}" placeholder="`);
    // Try again asks for THAT list.
    expect(SOURCE).toMatch(new RegExp(`what="${what}" placeholder="[^"]+" onRetry=\\{\\(\\) => void ${what}Query\\.refetch\\(\\)\\}>`));
  });

  it("each card's state is read from its own list, by the one rule (list-state.ts)", () => {
    expect(SOURCE).toContain("const registrationsState = listStateOf(registrationsQuery);");
    expect(SOURCE).toContain("const speakersState = listStateOf(speakersQuery);");
    expect(SOURCE).toContain("const abstractsState = listStateOf(abstractsQuery);");
  });

  it("the reviewers card's state also knows whether this person may read reviewers", () => {
    // The list is asked for only once the answer is "allowed". Until the
    // session and the event are in, the answer is "loading" and the query is
    // off: read from the query alone that was "0 recipients" on every fresh
    // page load, and for someone who may not read reviewers it was 0 for good.
    expect(SOURCE).toContain("const reviewersState = listStateOf(reviewersQuery, reviewersAnswer);");
  });

  it("a card's body is shown for a list in hand and for nothing else", () => {
    // The saved-template tiles inside a card are never disabled and the send
    // they open goes to everyone the server finds: a card whose list failed
    // must not show them over a 0.
    expect(SOURCE).toContain('if (state === "ready") return <>{children}</>;');
    expect(SOURCE).toContain("Could not load {what}, so nothing can be sent from here yet.");
    expect(SOURCE).toContain("You do not have access to {what} on this event.");
  });

  it("the send dialog is opened from four places, each accounted for below", () => {
    // openEmailDialog, openTileDialog, openTemplateDialog, applyPastedSelection.
    // A fifth door needs its own line in the list under this test.
    expect(SOURCE.match(/setEmailDialogOpen\(true\)/g)).toHaveLength(4);
    // The pasted-ids door is a dialog outside the cards; its only opener is
    // inside the registrations wait (pinned below).
    expect(SOURCE.match(/openTemplateDialog\(/g)).toHaveLength(2); // the definition and renderSavedTemplates
  });

  it("each audience card is named, so a browser test can find it whatever order the lists arrive in", () => {
    for (const audience of ["registrations", "speakers", "abstracts", "reviewers"]) {
      expect(SOURCE).toContain(`<Card data-audience="${audience}">`);
    }
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

  it("a headline number shows a placeholder while its list is on the way, and a dash when it could not be read: never a 0", () => {
    for (const stat of [
      "<StatNumber state={registrationsState} value={registrations.length} />",
      "<StatNumber state={registrationsState} value={paymentSummary.paid} />",
      "<StatNumber state={registrationsState} value={unpaidRegistrations.length} />",
      "<StatNumber state={speakersState} value={speakers.length} />",
    ]) {
      expect(SOURCE).toContain(stat);
    }
  });
});
