/**
 * Reads: the model picks a lookup tool, writes nothing, and the reply
 * carries the facts the seed put there. Every task runs against the read
 * event unless noted.
 */
import { mentionsAll, mentionsAny, mentionsNumber, neverCalled, ranWrites, T } from "./_grade";
import { EV, READ_COUNTS, READ_SESSION, READ_SPEAKERS, SEED_PROMO, SEED_SPONSORS } from "./_seed-constants";
import { expect, test } from "./_harness";

const COUNT_TOOLS = [T.list_registrations, T.get_event_dashboard, T.get_event_stats, T.list_unpaid_registrations];

test("R1 confirmed and owing counts", async ({ golden }) => {
  const r = await golden.ask({
    eventId: EV.READ.id,
    message: "How many registrations are confirmed, and how many still owe payment? Give both numbers.",
  });
  expect(neverCalled(r.steps, COUNT_TOOLS).length, "a counting tool was called").toBeGreaterThan(0);
  expect(ranWrites(r.steps)).toEqual([]);
  expect(mentionsNumber(r.reply, READ_COUNTS.confirmed), `reply names ${READ_COUNTS.confirmed} confirmed: ${r.reply}`).toBe(true);
  expect(mentionsNumber(r.reply, READ_COUNTS.owing), `reply names ${READ_COUNTS.owing} owing: ${r.reply}`).toBe(true);
});

test("R2 speakers who have not signed the agreement", async ({ golden }) => {
  const r = await golden.ask({
    eventId: EV.READ.id,
    message: "Which speakers have not signed the speaker agreement yet? Name them.",
  });
  expect(neverCalled(r.steps, [T.list_speaker_agreements, T.list_speakers]).length).toBeGreaterThan(0);
  expect(ranWrites(r.steps)).toEqual([]);
  expect(mentionsAll(r.reply, [READ_SPEAKERS.FAROUK.lastName, READ_SPEAKERS.HADDAD.lastName]), r.reply).toBe(true);
});

test("R3 the agenda with times", async ({ golden }) => {
  const r = await golden.ask({ eventId: EV.READ.id, message: "What sessions are on the agenda, and when do they run?" });
  expect(neverCalled(r.steps, [T.list_sessions])).toEqual([T.list_sessions]);
  expect(ranWrites(r.steps)).toEqual([]);
  expect(mentionsAll(r.reply, [READ_SESSION.name]), r.reply).toBe(true);
});

test("R4 a dashboard summary", async ({ golden }) => {
  const r = await golden.ask({
    eventId: EV.READ.id,
    message: "Give me a short status summary of this event: registrations, speakers and sessions.",
  });
  expect(neverCalled(r.steps, [T.get_event_dashboard, T.get_event_stats, T.list_registrations, T.list_speakers]).length).toBeGreaterThan(0);
  expect(ranWrites(r.steps)).toEqual([]);
  expect(r.reply.trim().length).toBeGreaterThan(40);
});

test("R5 find a person by name inside the event", async ({ golden }) => {
  const r = await golden.ask({ eventId: EV.READ.id, message: "Find anything about someone called Haddad in this event." });
  expect(neverCalled(r.steps, [T.search_event, T.list_speakers, T.list_registrations]).length).toBeGreaterThan(0);
  expect(ranWrites(r.steps)).toEqual([]);
  expect(mentionsAll(r.reply, ["Haddad"]), r.reply).toBe(true);
});

test("R6 sponsors and their tiers", async ({ golden }) => {
  const r = await golden.ask({ eventId: EV.SPONSORS.id, message: "Which sponsors do we have on this event, and at what tier?" });
  expect(neverCalled(r.steps, [T.list_sponsors])).toEqual([T.list_sponsors]);
  expect(ranWrites(r.steps)).toEqual([]);
  expect(mentionsAll(r.reply, SEED_SPONSORS.map((s) => s.name)), r.reply).toBe(true);
});

test("R7 promo codes and whether they are active", async ({ golden }) => {
  const r = await golden.ask({ eventId: EV.PROMO.id, message: "List the promo codes on this event and say whether each is active." });
  expect(neverCalled(r.steps, [T.list_promo_codes])).toEqual([T.list_promo_codes]);
  expect(ranWrites(r.steps)).toEqual([]);
  expect(mentionsAll(r.reply, [SEED_PROMO.code]), r.reply).toBe(true);
});

test("R8 unpaid registrations exclude the cancelled one", async ({ golden }) => {
  const r = await golden.ask({ eventId: EV.READ.id, message: "Who still has to pay for this event? List their names." });
  expect(neverCalled(r.steps, [T.list_unpaid_registrations, T.list_registrations]).length).toBeGreaterThan(0);
  expect(ranWrites(r.steps)).toEqual([]);
  expect(mentionsAll(r.reply, ["Owes", "Pending"]), r.reply).toBe(true);
  // A cancelled registration owes nothing (the July 2026 rule).
  expect(mentionsAny(r.reply, ["Zain"]), `cancelled registrant listed as owing: ${r.reply}`).toBe(false);
});
