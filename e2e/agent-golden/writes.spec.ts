/**
 * Writes: the model looks before it writes, writes exactly what was asked,
 * and nothing else. Each task has its own event so the final state is
 * graded from zero.
 */
import { calledBefore, neverCalled, onlyWrites, ranWrites, T } from "./_grade";
import { EV, GOLDEN_TZ, UPDATE_REGISTRANT, VIP_TICKET } from "./_seed-constants";
import { expect, test } from "./_harness";

function hourIn(date: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hour12: false }).format(date));
}

test("W1 create three tracks", async ({ golden }) => {
  const r = await golden.ask({ eventId: EV.TRACKS.id, message: "Create three tracks: Cardiology, Neurology, Oncology." });
  const tracks = await golden.db.track.findMany({ where: { eventId: EV.TRACKS.id }, select: { name: true } });
  expect(tracks.map((t) => t.name).sort()).toEqual(["Cardiology", "Neurology", "Oncology"]);
  expect(calledBefore(r.steps, T.list_tracks, T.create_track), "list_tracks before the first create").toBe(true);
  expect(ranWrites(r.steps)).toHaveLength(3);
  expect(onlyWrites(r.steps, [T.create_track])).toEqual([]);
});

test("W2 register a doctor on the VIP type", async ({ golden }) => {
  const r = await golden.ask({
    eventId: EV.VIP.id,
    message: "Register Dr Lina Saeed, lina.saeed@test.local, on the VIP registration type.",
  });
  const regs = await golden.db.registration.findMany({
    where: { eventId: EV.VIP.id, attendee: { email: "lina.saeed@test.local" } },
    select: { ticketTypeId: true, status: true },
  });
  expect(regs).toHaveLength(1);
  expect(regs[0].ticketTypeId).toBe(VIP_TICKET.VIP.id);
  expect(calledBefore(r.steps, T.list_ticket_types, T.create_registration), "list_ticket_types before create_registration").toBe(true);
  expect(ranWrites(r.steps)).toHaveLength(1);
  expect(onlyWrites(r.steps, [T.create_registration])).toEqual([]);
});

test("W3 add a confirmed speaker", async ({ golden }) => {
  const r = await golden.ask({
    eventId: EV.SPEAKERS.id,
    message: "Add Prof. Karim Nasser, karim.nasser@test.local, from Cairo University as a confirmed speaker.",
  });
  const speaker = await golden.db.speaker.findFirst({
    where: { eventId: EV.SPEAKERS.id, email: "karim.nasser@test.local" },
    select: { status: true, organization: true, firstName: true, lastName: true },
  });
  expect(speaker).not.toBeNull();
  expect(speaker?.status).toBe("CONFIRMED");
  expect(speaker?.organization ?? "").toMatch(/Cairo/i);
  expect(ranWrites(r.steps)).toHaveLength(1);
  expect(onlyWrites(r.steps, [T.create_speaker])).toEqual([]);
});

test("W4 create a session on the first day at 09:00 event time", async ({ golden }) => {
  const r = await golden.ask({
    eventId: EV.SESSION_ONE.id,
    message: "Create a session called Golden Workshop on the first day of the event, 09:00 to 10:30 event time, in Hall B.",
  });
  const session = await golden.db.eventSession.findFirst({
    where: { eventId: EV.SESSION_ONE.id, name: "Golden Workshop" },
    select: { startTime: true, endTime: true, location: true },
  });
  expect(session).not.toBeNull();
  expect(hourIn(session!.startTime, GOLDEN_TZ)).toBe(9);
  expect((session!.endTime.getTime() - session!.startTime.getTime()) / 60_000).toBe(90);
  expect(session!.location ?? "").toMatch(/Hall B/i);
  expect(ranWrites(r.steps)).toHaveLength(1);
  expect(onlyWrites(r.steps, [T.create_session])).toEqual([]);
});

test("W5 create a percentage promo code", async ({ golden }) => {
  const r = await golden.ask({
    eventId: EV.PROMO.id,
    message: "Create a promo code GOLDEN20 giving 20% off, limited to 100 uses.",
  });
  const promo = await golden.db.promoCode.findFirst({
    where: { eventId: EV.PROMO.id, code: "GOLDEN20" },
    select: { discountType: true, discountValue: true, maxUses: true, isActive: true },
  });
  expect(promo).not.toBeNull();
  expect(promo?.discountType).toBe("PERCENTAGE");
  expect(Number(promo?.discountValue)).toBe(20);
  expect(promo?.maxUses).toBe(100);
  expect(ranWrites(r.steps)).toHaveLength(1);
  expect(onlyWrites(r.steps, [T.create_promo_code])).toEqual([]);
});

test("W6 three writes in one request", async ({ golden }) => {
  const r = await golden.ask({
    eventId: EV.MULTI.id,
    message:
      "Create a track called Plenary, then add two confirmed speakers: Dr Ali Mansour (ali.mansour@test.local) and Dr Sara Yusuf (sara.yusuf@test.local).",
  });
  const track = await golden.db.track.findFirst({ where: { eventId: EV.MULTI.id, name: "Plenary" } });
  const speakers = await golden.db.speaker.findMany({
    where: { eventId: EV.MULTI.id, email: { in: ["ali.mansour@test.local", "sara.yusuf@test.local"] } },
    select: { status: true },
  });
  expect(track).not.toBeNull();
  expect(speakers).toHaveLength(2);
  expect(speakers.every((s) => s.status === "CONFIRMED")).toBe(true);
  expect(ranWrites(r.steps)).toHaveLength(3);
  expect(onlyWrites(r.steps, [T.create_track, T.create_speaker])).toEqual([]);
});

test("W7 confirm a pending registration", async ({ golden }) => {
  const r = await golden.ask({
    eventId: EV.UPDATE.id,
    message: `Change the registration for ${UPDATE_REGISTRANT.email} to confirmed.`,
  });
  const reg = await golden.db.registration.findFirst({
    where: { eventId: EV.UPDATE.id, attendee: { email: UPDATE_REGISTRANT.email } },
    select: { status: true },
  });
  expect(reg?.status).toBe("CONFIRMED");
  expect(ranWrites(r.steps).length).toBeLessThanOrEqual(1);
  expect(onlyWrites(r.steps, [T.update_registration, T.bulk_update_registration_status])).toEqual([]);
});

// A draft becomes a NEW template, not an overwrite of the built-in invitation:
// the model must reach for create_email_template (September 22, 2026), keep
// the greeting and the agreement button as tokens, and turn "your session
// details are below" into the presentation-details token.
test("W8 create a custom email template from a draft", async ({ golden }) => {
  const r = await golden.ask({
    eventId: EV.TEMPLATE.id,
    message:
      "Create a new email template called Faculty Welcome for our speakers from this draft. " +
      "Subject: Welcome to the faculty. " +
      "Draft: Thank you for agreeing to join our faculty. The programme committee has placed your talk in the scientific programme; " +
      "your session details are below. Please review and sign the speaker agreement using the button, and let us know of any change to your availability. " +
      "Greet each speaker by name and end with the organiser's signature.",
  });
  const templates = await golden.db.emailTemplate.findMany({
    where: { eventId: EV.TEMPLATE.id },
    select: { slug: true, name: true, subject: true, htmlContent: true, isActive: true },
  });
  expect(templates, "exactly one template on the event").toHaveLength(1);
  const t = templates[0];
  expect(["speaker-invitation", "speaker-agreement", "custom-notification"], "a new slug, not a built-in one").not.toContain(t.slug);
  expect(t.slug).toMatch(/^[a-z0-9-]+$/);
  expect(t.name).toMatch(/faculty welcome/i);
  expect(t.subject).toMatch(/welcome to the faculty/i);
  expect(t.isActive).toBe(true);
  expect(t.htmlContent).toMatch(/agreeing to join/i);
  expect(t.htmlContent, "greets by name with a token").toMatch(/\{\{(speakerName|firstName)\}\}/);
  expect(t.htmlContent, "the agreement button is the token").toContain("{{agreementBlock}}");
  expect(t.htmlContent, "session details are the token").toContain("{{presentationDetails}}");
  expect(t.htmlContent).toContain("{{organizerSignature}}");
  expect(ranWrites(r.steps)).toHaveLength(1);
  expect(onlyWrites(r.steps, [T.create_email_template])).toEqual([]);
});

// The September 22, 2026 production case, verbatim in shape: asked for three
// invitation drafts and holding no create tool, the agent overwrote three
// built-in templates (the travel-grant reminder and the presenter agreement
// among them) with token-free text. Three creates, no update, the built-ins
// untouched.
test("W9 three invitation categories become three custom templates, no built-in overwritten", async ({ golden }) => {
  const r = await golden.ask({
    eventId: EV.TEMPLATE3.id,
    message:
      "I need to create the drafts for the speaker invitations, I have 3 categories. " +
      "Category one: International Speakers (outside UAE), entitled to 3 nights accommodation and a two-way flight ticket following the travel policy. " +
      "Category two: Local speakers (inside UAE), entitled to 2 nights accommodation, no air ticket. " +
      "Category three: no entitlements. " +
      "The general information on all invitations is the speaking slot details and the session moderation details.",
  });
  const templates = await golden.db.emailTemplate.findMany({
    where: { eventId: EV.TEMPLATE3.id },
    select: { slug: true, name: true, htmlContent: true },
  });
  expect(templates, "three templates, nothing else on the event").toHaveLength(3);
  for (const t of templates) {
    expect(["speaker-invitation", "speaker-agreement", "travel-grant-invitation", "presenter-agreement", "custom-notification"], `${t.slug} is a new slug`).not.toContain(t.slug);
    expect(t.htmlContent, `${t.slug} greets by name`).toMatch(/\{\{(speakerName|firstName)\}\}/);
    expect(t.htmlContent, `${t.slug} carries the speaking slot details as the token`).toContain("{{presentationDetails}}");
  }
  const names = templates.map((t) => t.name.toLowerCase()).join(" | ");
  expect(names).toMatch(/international/);
  expect(names).toMatch(/local/);
  expect(names).toMatch(/no entitlement/);
  expect(neverCalled(r.steps, [T.update_email_template]), "no built-in template rewritten").toEqual([]);
  expect(ranWrites(r.steps)).toHaveLength(3);
  expect(onlyWrites(r.steps, [T.create_email_template])).toEqual([]);
});
