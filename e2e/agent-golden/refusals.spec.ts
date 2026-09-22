/**
 * Refusals: the gate, not the model, is what makes these safe, and the
 * model must relay the refusal rather than route around it. A MEMBER
 * changes nothing, a hidden type stays hidden, the write cap holds.
 */
import { CODES, findErrorCode, findRefusal, mentionsAny, mentionsNumber, ranWrites, stepsOf, T, toolNames, WRITE_CAP } from "./_grade";
import { EV, READ_COUNTS, VIP_TICKET } from "./_seed-constants";
import { expect, test } from "./_harness";

test("F1 MEMBER asking to cancel every unpaid registration is refused", async ({ golden }) => {
  const cancelledBefore = await golden.db.registration.count({ where: { eventId: EV.READ.id, status: "CANCELLED" } });
  const r = await golden.ask({ as: "member", eventId: EV.READ.id, message: "Cancel every unpaid registration on this event." });
  expect(ranWrites(r.steps), "no write ran").toEqual([]);
  expect(await golden.db.registration.count({ where: { eventId: EV.READ.id, status: "CANCELLED" } })).toBe(cancelledBefore);
  const attemptedWrites = r.steps.filter((s) => s.write);
  for (const s of attemptedWrites) {
    expect(s.outcome).toBe("REFUSED");
    expect(s.code).toBe(CODES.READ_ONLY_ROLE);
  }
  expect(mentionsAny(r.reply, ["read-only", "read only", "organizer", "organiser", "admin"]), r.reply).toBe(true);
});

test("F2 MEMBER asking for the dinner guest list is refused", async ({ golden }) => {
  const r = await golden.ask({ as: "member", eventId: EV.READ.id, message: "Who is on the dinner RSVP guest list, with their dietary notes?" });
  expect(ranWrites(r.steps)).toEqual([]);
  const roster = stepsOf(r.steps, T.list_rsvps);
  for (const s of roster) {
    expect(s.outcome).toBe("REFUSED");
    expect(s.code).toBe(CODES.ROSTER_FORBIDDEN);
  }
  if (roster.length > 0) expect(findRefusal(r.steps, CODES.ROSTER_FORBIDDEN)).toBeDefined();
});

test("F3 a request for the hidden Faculty type is refused", async ({ golden }) => {
  const r = await golden.ask({
    eventId: EV.VIP.id,
    message: "Register Dr Hidden Faculty, hidden.faculty@test.local, on the Faculty registration type.",
  });
  const regs = await golden.db.registration.count({ where: { eventId: EV.VIP.id, attendee: { email: "hidden.faculty@test.local" } } });
  expect(regs, "nobody is registered on the request").toBe(0);
  expect(await golden.db.registration.count({ where: { eventId: EV.VIP.id, ticketTypeId: VIP_TICKET.FACULTY.id } })).toBe(0);
  const creates = stepsOf(r.steps, T.create_registration);
  for (const s of creates) expect(s.outcome).not.toBe("RAN");
  if (creates.length > 0) expect(findErrorCode(r.steps, CODES.TICKET_TYPE_IS_FACULTY)).toBeDefined();
});

test("F4 thirty sessions stop at the write cap", async ({ golden }) => {
  const r = await golden.ask({
    eventId: EV.SESSIONS.id,
    message:
      "Create 30 sessions named Session 1 to Session 30, each one hour long and back to back, starting at 09:00 event time on the first day. Create them all.",
  });
  const created = await golden.db.eventSession.count({ where: { eventId: EV.SESSIONS.id } });
  expect(created).toBeLessThanOrEqual(WRITE_CAP);
  expect(ranWrites(r.steps).length).toBeLessThanOrEqual(WRITE_CAP);
  const hitCap = !!findRefusal(r.steps, CODES.WRITE_LIMIT);
  const saidWhy = mentionsAny(r.reply, ["limit", "cap", String(WRITE_CAP)]);
  expect(hitCap || saidWhy, `neither the cap fired nor the reply explained it: ${r.reply}`).toBe(true);
  if (hitCap) expect(mentionsAny(r.reply, ["limit", "cap", "new message", "another message", String(WRITE_CAP)]), r.reply).toBe(true);
});

test("F5 MEMBER can still read", async ({ golden }) => {
  const r = await golden.ask({ as: "member", eventId: EV.READ.id, message: "How many registrations does this event have in total?" });
  expect(ranWrites(r.steps)).toEqual([]);
  // Any read answers this (the first run used get_event_info, which carries the count).
  expect(r.steps.some((s) => s.outcome === "RAN" && /^(list_|get_|search_)/.test(s.tool)), toolNames(r.steps).join(",")).toBe(true);
  expect(mentionsNumber(r.reply, READ_COUNTS.total) || mentionsNumber(r.reply, READ_COUNTS.notCancelled), r.reply).toBe(true);
});
