/**
 * The right target (E3, September 22, 2026): when a name could mean two
 * things the model asks, when the person names another event the write
 * lands there and nowhere else, and a thing that already exists is not
 * made again. A guess is worse than a question, because the write is real.
 */
import { calledBefore, mentionsAll, mentionsAny, onlyWrites, ranWrites, stepsOf, T } from "./_grade";
import { AWAY_TRACK_NAME, DUPE_NEW_PHONE, DUPE_SPEAKERS, EV, REPEAT_TRACK } from "./_seed-constants";
import { expect, test } from "./_harness";

test("T1 two events match the name: ask, write nothing (org door)", async ({ golden }) => {
  const r = await golden.ask({ eventId: null, message: "Add a track called Imaging to the Heart Forum." });
  expect(ranWrites(r.steps)).toEqual([]);
  expect(r.approvals).toEqual([]);
  expect(await golden.db.track.count({ where: { eventId: { in: [EV.HEART_DUBAI.id, EV.HEART_AUH.id] } } })).toBe(0);
  const asked = mentionsAny(r.reply, ["which one", "which event", "which of", "did you mean", "two events"]) || mentionsAll(r.reply, ["Dubai", "Abu Dhabi"]);
  expect(asked, r.reply).toBe(true);
});

test("T2 two speakers share a name: ask, change nothing", async ({ golden }) => {
  const r = await golden.ask({ eventId: EV.DUPES.id, message: `Update Dr Ahmed Mansour's phone number to ${DUPE_NEW_PHONE}.` });
  expect(ranWrites(r.steps)).toEqual([]);
  for (const p of DUPE_SPEAKERS) {
    const row = await golden.db.speaker.findFirst({ where: { eventId: EV.DUPES.id, email: p.email }, select: { phone: true } });
    expect(row?.phone, p.email).toBe(p.phone);
  }
  const asked = mentionsAny(r.reply, ["which one", "which of", "which dr", "two speakers", "did you mean"]) || mentionsAll(r.reply, ["Heart", "Kidney"]);
  expect(asked, r.reply).toBe(true);
});

test("T3 a named other event gets the write, the selected one does not", async ({ golden }) => {
  const r = await golden.ask({
    eventId: EV.HOME.id,
    message: `Add a track called ${AWAY_TRACK_NAME} to ${EV.AWAY.name}, not to this event.`,
  });
  const away = await golden.db.track.findMany({ where: { eventId: EV.AWAY.id }, select: { name: true } });
  expect(away.map((t) => t.name)).toEqual([AWAY_TRACK_NAME]);
  expect(await golden.db.track.count({ where: { eventId: EV.HOME.id } })).toBe(0);
  expect(ranWrites(r.steps)).toHaveLength(1);
  expect(onlyWrites(r.steps, [T.create_track])).toEqual([]);
  const create = stepsOf(r.steps, T.create_track).find((s) => s.outcome === "RAN");
  expect((create?.input as { eventId?: string } | undefined)?.eventId, "the create carried the named event's id").toBe(EV.AWAY.id);
  expect(calledBefore(r.steps, T.list_events, T.create_track) || calledBefore(r.steps, T.search_event, T.create_track), "the event was resolved before the write").toBe(true);
});

test("D1 a track that already exists is not created twice", async ({ golden }) => {
  const r = await golden.ask({ eventId: EV.REPEAT.id, message: `Create a track called ${REPEAT_TRACK.name}.` });
  expect(await golden.db.track.count({ where: { eventId: EV.REPEAT.id, name: REPEAT_TRACK.name } })).toBe(1);
  expect(stepsOf(r.steps, T.create_track).filter((s) => s.outcome === "RAN")).toEqual([]);
  expect(stepsOf(r.steps, T.list_tracks).length, "the model looked first").toBeGreaterThan(0);
  expect(mentionsAny(r.reply, ["already", "exists", "existing"]), r.reply).toBe(true);
});
