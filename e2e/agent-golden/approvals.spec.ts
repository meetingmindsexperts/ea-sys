/**
 * Approvals: an approval-gated tool is called at once (the card is the
 * confirmation), the request's run records it as APPROVAL_REQUESTED exactly
 * once and changes nothing, Approve runs it in a second run, Cancel never
 * reaches the server.
 */
import { approvalRequestedFor, onlyWrites, ranApproved, ranWrites, stepsOf, T } from "./_grade";
import { EV, PANEL_SESSION, PANEL_SPEAKERS, SEED_PROMO, SEED_SPONSORS } from "./_seed-constants";
import { expect, test } from "./_harness";

/** The request's run asked once and ran nothing; the approval's run ran the tool approved. */
function expectPausedThenRan(r: Awaited<ReturnType<import("./_harness").Golden["ask"]>>, tool: string) {
  expect(r.approvals.map((a) => a.toolName), "one approval card, for the right tool").toEqual([tool]);
  expect(approvalRequestedFor(r.firstSteps, tool)).toHaveLength(1);
  expect(stepsOf(r.firstSteps, tool), "the tool is not called again in the same turn").toHaveLength(1);
  expect(ranWrites(r.firstSteps), "nothing runs before Approve").toEqual([]);
  expect(r.runs).toHaveLength(2);
  expect(ranApproved(r.runs[1].steps, tool)).toHaveLength(1);
  expect(onlyWrites(r.steps, [tool])).toEqual([]);
}

test("A1 bulk email to confirmed registrants, approved", async ({ golden }) => {
  const before = await golden.db.emailLog.count({ where: { eventId: EV.EMAIL_APPROVE.id } });
  const r = await golden.ask({
    eventId: EV.EMAIL_APPROVE.id,
    approval: "approve",
    message: "Email all confirmed registrants of this event. Subject: Golden hello. Message: This is a golden test.",
  });
  expectPausedThenRan(r, T.send_bulk_email);
  const sent = await golden.db.emailLog.count({
    where: { eventId: EV.EMAIL_APPROVE.id, subject: { contains: "Golden hello", mode: "insensitive" } },
  });
  expect(before).toBe(0);
  // Three confirmed registrants; a locally failed delivery still logs a row.
  expect(sent).toBe(3);
});

test("A2 bulk email, cancelled on the card", async ({ golden }) => {
  const r = await golden.ask({
    eventId: EV.EMAIL_CANCEL.id,
    approval: "cancel",
    message: "Send every registrant of this event an email with the subject Golden cancel test and the message Nothing to see.",
  });
  expect(r.approvals.map((a) => a.toolName)).toEqual([T.send_bulk_email]);
  expect(approvalRequestedFor(r.firstSteps, T.send_bulk_email)).toHaveLength(1);
  expect(r.runs, "a Cancel never reaches the server").toHaveLength(1);
  expect(ranWrites(r.steps)).toEqual([]);
  expect(await golden.db.emailLog.count({ where: { eventId: EV.EMAIL_CANCEL.id } })).toBe(0);
  expect(await golden.db.scheduledEmail.count({ where: { eventId: EV.EMAIL_CANCEL.id } })).toBe(0);
});

test("A3 add a gold sponsor without losing the existing ones", async ({ golden }) => {
  const r = await golden.ask({
    eventId: EV.SPONSORS.id,
    approval: "approve",
    message: "Add Gamma Labs as a gold sponsor; their website is https://gamma-labs.example.",
  });
  expectPausedThenRan(r, T.upsert_sponsors);
  const sponsors = await golden.db.sponsor.findMany({
    where: { eventId: EV.SPONSORS.id },
    select: { name: true, tier: true },
  });
  const names = sponsors.map((s) => s.name).sort();
  expect(names).toEqual([...SEED_SPONSORS.map((s) => s.name), "Gamma Labs"].sort());
  expect(sponsors.find((s) => s.name === "Gamma Labs")?.tier).toBe("gold");
});

test("A4 set the CME hours", async ({ golden }) => {
  const r = await golden.ask({ eventId: EV.CME.id, approval: "approve", message: "Set the CME hours for this event to 6." });
  expectPausedThenRan(r, T.update_cme_settings);
  const event = await golden.db.event.findUnique({ where: { id: EV.CME.id }, select: { cmeHours: true } });
  expect(Number(event?.cmeHours)).toBe(6);
});

test("A5 replace a session's speakers", async ({ golden }) => {
  const r = await golden.ask({
    eventId: EV.SPEAKERS.id,
    approval: "approve",
    message: `Replace the speakers of the session "${PANEL_SESSION.name}" so that Dr ${PANEL_SPEAKERS.FARES.firstName} ${PANEL_SPEAKERS.FARES.lastName} is the only speaker.`,
  });
  expectPausedThenRan(r, T.replace_session_speakers);
  const roster = await golden.db.sessionSpeaker.findMany({
    where: { sessionId: PANEL_SESSION.id },
    select: { speaker: { select: { email: true } } },
  });
  expect(roster.map((s) => s.speaker.email)).toEqual([PANEL_SPEAKERS.FARES.email]);
});

test("A6 delete a promo code (every delete pauses)", async ({ golden }) => {
  const r = await golden.ask({ eventId: EV.PROMO.id, approval: "approve", message: `Delete the promo code ${SEED_PROMO.code}.` });
  expectPausedThenRan(r, T.delete_promo_code);
  const promo = await golden.db.promoCode.findFirst({ where: { eventId: EV.PROMO.id, code: SEED_PROMO.code }, select: { isActive: true } });
  // A promo delete is a soft delete: the row stays, inactive, with its history.
  expect(promo?.isActive).toBe(false);
});
