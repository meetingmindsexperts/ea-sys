/**
 * The org door: no event selected. The model finds one, or creates one,
 * or asks; it never writes against a guessed event.
 */
import { mentionsAll, mentionsAny, neverCalled, onlyWrites, ranWrites, T } from "./_grade";
import { CREATED_EVENT_NAME, EV, GOLDEN_TZ } from "./_seed-constants";
import { expect, test } from "./_harness";

function dateIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

test("O1 create a draft conference", async ({ golden }) => {
  const r = await golden.ask({
    eventId: null,
    message: `Create a draft conference called ${CREATED_EVENT_NAME}, running 3 to 4 March 2027 in Dubai, timezone ${GOLDEN_TZ}.`,
  });
  const event = await golden.db.event.findFirst({
    where: { name: CREATED_EVENT_NAME },
    select: { status: true, startDate: true, endDate: true, timezone: true, city: true },
  });
  expect(event).not.toBeNull();
  expect(event?.status).toBe("DRAFT");
  expect(dateIn(event!.startDate, GOLDEN_TZ)).toBe("2027-03-03");
  expect(dateIn(event!.endDate, GOLDEN_TZ)).toBe("2027-03-04");
  expect(ranWrites(r.steps)).toHaveLength(1);
  expect(onlyWrites(r.steps, [T.create_event])).toEqual([]);
});

test("O2 how many events, which start next", async ({ golden }) => {
  const r = await golden.ask({ eventId: null, message: "How many events do we have, and which three start next? Keep it short." });
  expect(neverCalled(r.steps, [T.list_events])).toEqual([T.list_events]);
  expect(ranWrites(r.steps)).toEqual([]);
  expect(mentionsAny(r.reply, ["Golden"]), r.reply).toBe(true);
});

test("O3 which event has a speaker called Haddad", async ({ golden }) => {
  const r = await golden.ask({ eventId: null, message: "Which of our events has a speaker whose surname is Haddad?" });
  expect(neverCalled(r.steps, [T.search_event, T.list_events, T.list_speakers]).length).toBeGreaterThan(0);
  expect(ranWrites(r.steps)).toEqual([]);
  expect(mentionsAll(r.reply, [EV.READ.name]), r.reply).toBe(true);
});

test("O4 an ambiguous count with no event selected writes nothing", async ({ golden }) => {
  const r = await golden.ask({ eventId: null, message: "How many registrations are there?" });
  expect(ranWrites(r.steps)).toEqual([]);
  expect(r.approvals).toEqual([]);
  expect(mentionsAny(r.reply, ["event"]), r.reply).toBe(true);
});
