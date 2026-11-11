/**
 * Certificate assignments on a REAL Postgres (Nov 11, 2026): who receives a
 * certificate is a row, not a tag, and a certificate is owed once a person is
 * assigned AND has answered the survey, in either order.
 *
 * A mocked Prisma cannot show what matters here:
 *   - the per-event lock really makes the survey sweep wait for an assignment
 *     that is being written, and then SEE it (the lost wake-up it exists for);
 *   - re-opening a registration the sweep already looked at makes the next
 *     tick issue to it;
 *   - the relation-filtered counts and pool queries are valid SQL;
 *   - the migration's backfill turns today's tags into exactly the same people;
 *   - the number a confirmation shows is the number the sweep then sends
 *     (review of 631e95bd: it counted one template and sent every one owed);
 *   - the sweep locks and re-reads its own row, so a cancellation or a survey
 *     reset landing while it waits for the lock is honoured.
 *
 * Nothing here renders a PDF or sends an email: the sweep only QUEUES a run
 * (CertificateIssueRun + item), and the tests read that queue.
 *
 * Run: docker compose --profile crm-test up -d
 *      INTEGRATION_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/crm_test npm run test:integration-db
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db } from "@/lib/db";
import { runAutoIssueSweep } from "@/lib/certificates/auto-issue";
import { countAssignmentsByTemplate, lockCertificateAssignments } from "@/lib/certificates/assignments";
import { eligibleForTemplates } from "@/lib/certificates/eligibility";
import { loadCertificatePeople, loadRecipientReport } from "@/lib/certificates/recipients-report";
import {
  assignCertificate,
  resolveAssignmentEmails,
  setTemplateAutoIssue,
  unassignCertificate,
} from "@/services/certificate-assignment-service";
import { applyBackfill } from "../../scripts/backfill-certificate-assignments";
import { resetCrm, type CrmSeed } from "./helper";

let seed: CrmSeed;
let eventId: string;
let typeId: string;
let n = 0;

const ANSWERED = new Date("2026-11-01T10:00:00Z");

async function event(name = "CME Event"): Promise<string> {
  n += 1;
  const row = await db.event.create({
    data: {
      organizationId: seed.orgId,
      name,
      slug: `cme-${Date.now()}-${n}`,
      startDate: new Date("2026-11-01"),
      endDate: new Date("2026-11-02"),
    },
    select: { id: true },
  });
  return row.id;
}

async function registration(
  email: string,
  over: { answered?: boolean; status?: "CONFIRMED" | "CANCELLED"; tags?: string[]; inEvent?: string; swept?: boolean } = {},
): Promise<string> {
  const attendee = await db.attendee.create({
    data: { organizationId: seed.orgId, email, firstName: "Reg", lastName: email.split("@")[0], tags: over.tags ?? [] },
    select: { id: true },
  });
  const row = await db.registration.create({
    data: {
      eventId: over.inEvent ?? eventId,
      organizationId: seed.orgId,
      ticketTypeId: over.inEvent ? null : typeId,
      attendeeId: attendee.id,
      status: over.status ?? "CONFIRMED",
      surveyCompletedAt: over.answered ? ANSWERED : null,
      certAutoIssueCheckedAt: over.swept ? ANSWERED : null,
    },
    select: { id: true },
  });
  return row.id;
}

async function speaker(
  email: string,
  over: {
    sourceRegistrationId?: string;
    tags?: string[];
    status?: "INVITED" | "CONFIRMED" | "DECLINED" | "CANCELLED";
    submitterSource?: string;
  } = {},
): Promise<string> {
  const row = await db.speaker.create({
    data: { eventId, organizationId: seed.orgId, email, firstName: "Spk", lastName: email.split("@")[0], ...over },
    select: { id: true },
  });
  return row.id;
}

async function template(
  name: string,
  over: { category?: "ATTENDANCE" | "APPRECIATION"; auto?: boolean; tag?: string } = {},
): Promise<string> {
  const row = await db.certificateTemplate.create({
    data: {
      eventId,
      organizationId: seed.orgId,
      name,
      category: over.category ?? "ATTENDANCE",
      autoIssueOnSurvey: over.auto ?? false,
      autoIssueTag: over.tag ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

/** `confirmed`: the number of certificates the caller agreed to send now. */
const assign = (
  templateId: string,
  ids: { registrationIds?: string[]; speakerIds?: string[] },
  confirmed?: number,
  mayReleaseNow = true,
) =>
  assignCertificate({
    eventId,
    organizationId: seed.orgId,
    templateId,
    ...ids,
    userId: seed.userId,
    source: "rest",
    assignmentSource: "MANUAL",
    confirmedSendNow: confirmed,
    mayReleaseNow,
  });

const setSwitch = (templateId: string, enabled: boolean, confirmed?: number, mayReleaseNow = true) =>
  setTemplateAutoIssue({
    eventId,
    templateId,
    enabled,
    userId: seed.userId,
    source: "rest",
    confirmedSendNow: confirmed,
    mayReleaseNow,
  });

/** An unassign writes its audit row without waiting: wait for it, as the backfill reads it. */
async function auditLanded(action: string, count = 1): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if ((await db.auditLog.count({ where: { action } })) >= count) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`audit row ${action} never landed`);
}

/** A caller who may read registrations, speakers, abstracts and proposals on the event. */
const SEES_EVERYONE = { registrations: true, speakers: true, submissions: { abstracts: true, proposals: true } };

const checkedAt = async (registrationId: string) =>
  (await db.registration.findUniqueOrThrow({ where: { id: registrationId }, select: { certAutoIssueCheckedAt: true } }))
    .certAutoIssueCheckedAt;

/** The people the sweep has queued a certificate for, as "templateId:personId". */
async function queued(): Promise<string[]> {
  const items = await db.certificateIssueRunItem.findMany({
    where: { run: { eventId, autoIssue: true } },
    select: { registrationId: true, speakerId: true, templateIds: true },
  });
  return items.flatMap((i) => i.templateIds.map((t) => `${t}:${i.registrationId ?? i.speakerId}`)).sort();
}

beforeEach(async () => {
  seed = await resetCrm();
  eventId = await event();
  typeId = (await db.ticketType.create({ data: { eventId, name: "Physician", price: 0, quantity: 500 }, select: { id: true } })).id;
});

// Fire-and-forget audit rows must land before the next reset truncates.
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 200));
  for (let i = 0; i < 50; i++) {
    const [{ n: active }] = await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active'`;
    if (Number(active) === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
});

describe("assignCertificate", () => {
  it("adds a row per person with who and how, and is a no-op the second time", async () => {
    const tpl = await template("CME");
    const [a, b] = [await registration("a@x.com"), await registration("b@x.com")];

    const first = await assign(tpl, { registrationIds: [a, b] });
    expect(first).toMatchObject({ ok: true, assigned: 2, alreadyAssigned: 0, skipped: 0, sendNow: 0 });
    const rows = await db.certificateAssignment.findMany({ where: { certificateTemplateId: tpl } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.organizationId === seed.orgId && r.source === "MANUAL" && r.assignedByUserId === seed.userId && r.eventId === eventId)).toBe(true);
    expect(rows.every((r) => r.registrationId !== null && r.speakerId === null)).toBe(true);

    const again = await assign(tpl, { registrationIds: [a, b] });
    expect(again).toMatchObject({ ok: true, assigned: 0, alreadyAssigned: 2 });
    expect(await db.certificateAssignment.count({ where: { certificateTemplateId: tpl } })).toBe(2);
  });

  it("skips a cancelled registration and one from another event", async () => {
    const tpl = await template("CME");
    const other = await event("Other");
    const ok = await registration("ok@x.com");
    const cancelled = await registration("gone@x.com", { status: "CANCELLED" });
    const foreign = await registration("foreign@x.com", { inEvent: other });

    const res = await assign(tpl, { registrationIds: [ok, cancelled, foreign] });
    expect(res).toMatchObject({ ok: true, assigned: 1, skipped: 2 });
    const rows = await db.certificateAssignment.findMany({ where: { certificateTemplateId: tpl }, select: { registrationId: true } });
    expect(rows.map((r) => r.registrationId)).toEqual([ok]);
  });

  it("refuses a template of another event, and the wrong kind of person", async () => {
    const tpl = await template("CME");
    const appreciation = await template("Speaker", { category: "APPRECIATION" });
    const reg = await registration("a@x.com");
    const spk = await speaker("s@x.com");
    const other = await event("Other");

    expect(await assignCertificate({ eventId: other, organizationId: seed.orgId, templateId: tpl, registrationIds: [reg], userId: seed.userId, source: "rest", assignmentSource: "MANUAL", mayReleaseNow: true }))
      .toMatchObject({ ok: false, code: "TEMPLATE_NOT_FOUND" });
    expect(await assign(tpl, { speakerIds: [spk] })).toMatchObject({ ok: false, code: "WRONG_RECIPIENT_TYPE" });
    expect(await assign(appreciation, { registrationIds: [reg] })).toMatchObject({ ok: false, code: "WRONG_RECIPIENT_TYPE" });
    expect(await db.certificateAssignment.count()).toBe(0);
  });

  it("a dry run reports what would happen and writes nothing", async () => {
    const tpl = await template("CME", { auto: true });
    const answered = await registration("done@x.com", { answered: true, swept: true });
    const res = await assignCertificate({
      eventId, organizationId: seed.orgId, templateId: tpl, registrationIds: [answered],
      userId: seed.userId, source: "rest", assignmentSource: "MANUAL", mayReleaseNow: true, dryRun: true,
    });
    expect(res).toMatchObject({ ok: true, dryRun: true, assigned: 1, sendNow: 1, sendNowPeople: 1, sendNowAllowed: true });
    expect(await db.certificateAssignment.count()).toBe(0);
    expect(await checkedAt(answered)).not.toBeNull();
  });
});

describe("the send-now confirmation", () => {
  it("assigning people who already answered an auto-issue certificate needs the confirmation; nothing is written without it", async () => {
    const tpl = await template("CME", { auto: true });
    const answered = await registration("done@x.com", { answered: true, swept: true });
    const waiting = await registration("later@x.com");

    const refused = await assign(tpl, { registrationIds: [answered, waiting] });
    expect(refused).toMatchObject({ ok: false, code: "CONFIRM_SEND_NOW", meta: { sendNow: 1, assigned: 2 } });
    expect(await db.certificateAssignment.count()).toBe(0);
    expect(await checkedAt(answered)).not.toBeNull();

    const confirmed = await assign(tpl, { registrationIds: [answered, waiting] }, 1);
    expect(confirmed).toMatchObject({ ok: true, assigned: 2, sendNow: 1 });
    // Handed back to the sweep: the stamp is cleared for the one who answered.
    expect(await checkedAt(answered)).toBeNull();
  });

  it("no confirmation is asked when the template does not auto-issue, or when the person already holds the certificate", async () => {
    const manual = await template("Manual");
    const auto = await template("Auto", { auto: true });
    const answered = await registration("done@x.com", { answered: true, swept: true });
    await db.issuedCertificate.create({
      data: { eventId, organizationId: seed.orgId, registrationId: answered, certificateTemplateId: auto, type: "ATTENDANCE", serial: "S-1", recipientSnapshot: {} },
    });

    expect(await assign(manual, { registrationIds: [answered] })).toMatchObject({ ok: true, assigned: 1, sendNow: 0 });
    expect(await assign(auto, { registrationIds: [answered] })).toMatchObject({ ok: true, assigned: 1, sendNow: 0 });
    // Nothing to send, so the sweep is not asked to look again.
    expect(await checkedAt(answered)).not.toBeNull();
  });

  it("turning the switch on for a template whose people already answered needs the confirmation", async () => {
    const tpl = await template("CME");
    const answered = await registration("done@x.com", { answered: true, swept: true });
    const waiting = await registration("later@x.com");
    await assign(tpl, { registrationIds: [answered, waiting] });

    const refused = await setSwitch(tpl, true);
    expect(refused).toMatchObject({ ok: false, code: "CONFIRM_SEND_NOW", meta: { sendNow: 1 } });
    expect((await db.certificateTemplate.findUniqueOrThrow({ where: { id: tpl } })).autoIssueOnSurvey).toBe(false);
    expect(await checkedAt(answered)).not.toBeNull();

    const confirmed = await setSwitch(tpl, true, 1);
    expect(confirmed).toEqual({ ok: true, changed: true, sendNow: 1 });
    expect((await db.certificateTemplate.findUniqueOrThrow({ where: { id: tpl } })).autoIssueOnSurvey).toBe(true);
    expect(await checkedAt(answered)).toBeNull();

    // Turning it off, or on again, asks nothing and changes nothing more.
    expect(await setSwitch(tpl, true)).toEqual({ ok: true, changed: false, sendNow: 0 });
    expect(await setSwitch(tpl, false)).toEqual({ ok: true, changed: true, sendNow: 0 });
  });

  it("the switch turns on without a question when nobody assigned has answered", async () => {
    const tpl = await template("CME");
    await assign(tpl, { registrationIds: [await registration("later@x.com")] });
    expect(await setSwitch(tpl, true)).toEqual({ ok: true, changed: true, sendNow: 0 });
  });

  it("H1: the count is EVERYTHING re-opening sends, a certificate the person was already owed included", async () => {
    // Dr Y answered, and the old sweep passed her over. The deploy carried her
    // tag over onto "Day 1" (auto-issue): on the list, owed, deliberately not sent.
    const day1 = await template("CME Day 1", { auto: true });
    const day2 = await template("CME Day 2", { auto: true });
    const drY = await registration("y@x.com", { answered: true, swept: true });
    await db.certificateAssignment.create({
      data: { eventId, organizationId: seed.orgId, certificateTemplateId: day1, registrationId: drY, source: "TAG_BACKFILL" },
    });

    // Staff assign Day 2. Re-opening her sends BOTH, so both are counted and named.
    const refused = await assign(day2, { registrationIds: [drY] });
    expect(refused).toMatchObject({ ok: false, code: "CONFIRM_SEND_NOW", meta: { sendNow: 2, sendNowPeople: 1 } });
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.message).toContain("CME Day 1 (1)");
    expect(refused.message).toContain("CME Day 2 (1)");
    // Rolled back: no Day 2 row, and she is still stamped.
    expect(await db.certificateAssignment.count({ where: { certificateTemplateId: day2 } })).toBe(0);
    expect(await checkedAt(drY)).not.toBeNull();

    // Agreeing to one certificate is not agreeing to two.
    expect(await assign(day2, { registrationIds: [drY] }, 1)).toMatchObject({ ok: false, code: "CONFIRM_SEND_NOW", meta: { sendNow: 2 } });
    expect(await db.certificateAssignment.count({ where: { certificateTemplateId: day2 } })).toBe(0);

    expect(await assign(day2, { registrationIds: [drY] }, 2)).toMatchObject({ ok: true, assigned: 1, sendNow: 2 });
    // And the sweep sends exactly what was counted, in one email.
    expect(await runAutoIssueSweep()).toMatchObject({ scanned: 1, runsCreated: 2 });
    expect(await queued()).toEqual([`${day1}:${drY}`, `${day2}:${drY}`].sort());
    expect(await db.certificateIssueRun.count({ where: { eventId } })).toBe(1);
  });

  it("H1: the switch counts the same way, and a refusal leaves it off", async () => {
    const day1 = await template("CME Day 1", { auto: true });
    const day2 = await template("CME Day 2");
    const drY = await registration("y@x.com", { answered: true, swept: true });
    await db.certificateAssignment.createMany({
      data: [day1, day2].map((certificateTemplateId) => ({
        eventId, organizationId: seed.orgId, certificateTemplateId, registrationId: drY, source: "TAG_BACKFILL",
      })),
    });

    expect(await setSwitch(day2, true)).toMatchObject({ ok: false, code: "CONFIRM_SEND_NOW", meta: { sendNow: 2 } });
    expect((await db.certificateTemplate.findUniqueOrThrow({ where: { id: day2 } })).autoIssueOnSurvey).toBe(false);
    expect(await setSwitch(day2, true, 2)).toEqual({ ok: true, changed: true, sendNow: 2 });
  });

  it("H2: without the Issue permission a send-now is refused and nothing is written; assigning people who have not answered still works", async () => {
    const tpl = await template("CME", { auto: true });
    const answered = await registration("done@x.com", { answered: true, swept: true });
    const waiting = await registration("later@x.com");

    const refused = await assign(tpl, { registrationIds: [answered, waiting] }, 99, false);
    expect(refused).toMatchObject({ ok: false, code: "SEND_NOW_NOT_PERMITTED", meta: { sendNow: 1 } });
    expect(await db.certificateAssignment.count()).toBe(0);
    expect(await checkedAt(answered)).not.toBeNull();

    expect(await assign(tpl, { registrationIds: [waiting] }, undefined, false)).toMatchObject({ ok: true, assigned: 1, sendNow: 0 });

    // The switch, the same: on a template whose people answered, it stays off.
    const other = await template("Other");
    await assign(other, { registrationIds: [answered] });
    expect(await setSwitch(other, true, 99, false)).toMatchObject({ ok: false, code: "SEND_NOW_NOT_PERMITTED" });
    expect((await db.certificateTemplate.findUniqueOrThrow({ where: { id: other } })).autoIssueOnSurvey).toBe(false);
  });

  it("a certificate already on its way is not counted and the person is not re-opened", async () => {
    const tpl = await template("CME", { auto: true });
    const reg = await registration("flying@x.com", { answered: true, swept: true });
    // A manual run in review already covers this template for this person.
    const run = await db.certificateIssueRun.create({
      data: { eventId, organizationId: seed.orgId, type: "ATTENDANCE", certificateTemplateId: tpl, templateIds: [tpl], status: "AWAITING_REVIEW", totalCount: 1 },
      select: { id: true },
    });
    await db.certificateIssueRunItem.create({
      data: { runId: run.id, organizationId: seed.orgId, registrationId: reg, recipientName: "Reg flying", recipientEmail: "flying@x.com", templateIds: [tpl] },
    });

    expect(await assign(tpl, { registrationIds: [reg] })).toMatchObject({ ok: true, assigned: 1, sendNow: 0 });
    expect(await checkedAt(reg)).not.toBeNull();
  });
});

describe("the survey sweep reads assignments, in either order", () => {
  it("assigned first, answered later: the sweep queues exactly the assigned person", async () => {
    const tpl = await template("CME", { auto: true });
    const assigned = await registration("yes@x.com");
    const notAssigned = await registration("no@x.com");
    await assign(tpl, { registrationIds: [assigned] });
    await db.registration.updateMany({ where: { id: { in: [assigned, notAssigned] } }, data: { surveyCompletedAt: ANSWERED } });

    const res = await runAutoIssueSweep();
    expect(res).toMatchObject({ scanned: 2, resolved: 2, runsCreated: 1 });
    expect(await queued()).toEqual([`${tpl}:${assigned}`]);
    // Both are stamped: the one with nothing assigned is not scanned again.
    expect(await checkedAt(notAssigned)).not.toBeNull();
  });

  it("answered first, assigned later: the person the sweep already passed over is issued on the next tick", async () => {
    const tpl = await template("CME", { auto: true });
    const reg = await registration("late@x.com", { answered: true });

    expect(await runAutoIssueSweep()).toMatchObject({ scanned: 1, runsCreated: 0 });
    expect(await checkedAt(reg)).not.toBeNull();
    // Under the tag this replaced, that person was never looked at again.
    expect(await runAutoIssueSweep()).toMatchObject({ scanned: 0 });

    expect(await assign(tpl, { registrationIds: [reg] }, 1)).toMatchObject({ ok: true, sendNow: 1 });
    expect(await runAutoIssueSweep()).toMatchObject({ scanned: 1, runsCreated: 1 });
    expect(await queued()).toEqual([`${tpl}:${reg}`]);
    // And once queued, never twice.
    expect(await runAutoIssueSweep()).toMatchObject({ scanned: 0 });
  });

  it("a tag no longer decides anything: tagged but not assigned gets nothing", async () => {
    const tpl = await template("CME", { auto: true, tag: "Cme" });
    await registration("tagged@x.com", { answered: true, tags: ["Cme"] });
    expect(await runAutoIssueSweep()).toMatchObject({ scanned: 1, runsCreated: 0 });
    expect(await queued()).toEqual([]);
    expect(await db.certificateAssignment.count({ where: { certificateTemplateId: tpl } })).toBe(0);
  });

  it("an appreciation certificate reaches a speaker through their registration, pointer or same address", async () => {
    const tpl = await template("Speaker", { category: "APPRECIATION", auto: true });
    const companion = await registration("comp@x.com", { answered: true, swept: true });
    const byPointer = await speaker("faculty@x.com", { sourceRegistrationId: companion });
    const sameAddress = await registration("self@x.com", { answered: true, swept: true });
    const byEmail = await speaker("self@x.com");
    const neverRegistered = await speaker("nobody@x.com");

    const refused = await assign(tpl, { speakerIds: [byPointer, byEmail, neverRegistered] });
    expect(refused).toMatchObject({ ok: false, code: "CONFIRM_SEND_NOW", meta: { sendNow: 2, assigned: 3 } });
    expect(await assign(tpl, { speakerIds: [byPointer, byEmail, neverRegistered] }, 2)).toMatchObject({ ok: true, assigned: 3, sendNow: 2 });
    expect(await checkedAt(companion)).toBeNull();
    expect(await checkedAt(sameAddress)).toBeNull();

    expect(await runAutoIssueSweep()).toMatchObject({ scanned: 2, runsCreated: 2 });
    expect(await queued()).toEqual([`${tpl}:${byEmail}`, `${tpl}:${byPointer}`].sort());
  });

  it("the sweep WAITS for an assignment that is being written, then sees it (the lost wake-up)", async () => {
    const tpl = await template("CME", { auto: true });
    const reg = await registration("race@x.com", { answered: true });

    let commit!: () => void;
    const hold = new Promise<void>((r) => (commit = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));

    // An assignment in flight: it holds the event's lock with its row not yet committed.
    const writer = db.$transaction(
      async (tx) => {
        await lockCertificateAssignments(tx, eventId);
        await tx.certificateAssignment.create({
          data: { eventId, organizationId: seed.orgId, certificateTemplateId: tpl, registrationId: reg, source: "MANUAL" },
        });
        locked();
        await hold;
      },
      { timeout: 15_000 },
    );
    await isLocked;

    const sweep = runAutoIssueSweep();
    await new Promise((r) => setTimeout(r, 400));
    // Had the sweep not waited, it would have read "nothing assigned" and
    // stamped the registration by now, burying the assignment for good.
    expect(await checkedAt(reg)).toBeNull();
    expect(await queued()).toEqual([]);

    commit();
    await writer;
    expect(await sweep).toMatchObject({ scanned: 1, runsCreated: 1 });
    expect(await queued()).toEqual([`${tpl}:${reg}`]);
  });

  it("an assignment landing just AFTER the sweep stamped the person re-opens them", async () => {
    const tpl = await template("CME", { auto: true });
    const reg = await registration("after@x.com", { answered: true });

    // Sweep and assignment at once, a few times over: whichever takes the
    // lock first, the person ends up queued exactly once.
    const [, assigned] = await Promise.all([runAutoIssueSweep(), assign(tpl, { registrationIds: [reg] }, 1)]);
    expect(assigned.ok).toBe(true);
    await runAutoIssueSweep();
    expect(await queued()).toEqual([`${tpl}:${reg}`]);
  });

  it("M1: a registration cancelled, or whose survey is reset, while the sweep waits for the lock is not sent to and not stamped", async () => {
    const tpl = await template("CME", { auto: true });
    const cancelled = await registration("cancelled@x.com", { answered: true });
    const reset = await registration("reset@x.com", { answered: true });
    await db.certificateAssignment.createMany({
      data: [cancelled, reset].map((registrationId) => ({
        eventId, organizationId: seed.orgId, certificateTemplateId: tpl, registrationId, source: "MANUAL",
      })),
    });

    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    // Something holds the event's lock (a large assignment): the sweep has
    // already read both people as candidates and now waits.
    const holder = db.$transaction(
      async (tx) => {
        await lockCertificateAssignments(tx, eventId);
        locked();
        await hold;
      },
      { timeout: 15_000 },
    );
    await isLocked;
    const sweep = runAutoIssueSweep();
    await new Promise((r) => setTimeout(r, 400));

    // Meanwhile: a refund cancels one, an organiser resets the other's survey.
    await db.registration.update({ where: { id: cancelled }, data: { status: "CANCELLED" } });
    await db.registration.update({ where: { id: reset }, data: { surveyCompletedAt: null, certAutoIssueCheckedAt: null } });

    release();
    await holder;
    expect(await sweep).toMatchObject({ scanned: 2, skippedChanged: 2, resolved: 0, runsCreated: 0 });
    expect(await queued()).toEqual([]);
    // Not stamped: when the survey is answered again, the sweep looks again and sends.
    expect(await checkedAt(reset)).toBeNull();
    await db.registration.update({ where: { id: reset }, data: { surveyCompletedAt: ANSWERED } });
    expect(await runAutoIssueSweep()).toMatchObject({ scanned: 1, runsCreated: 1 });
    expect(await queued()).toEqual([`${tpl}:${reset}`]);
  });
});

describe("unassignCertificate", () => {
  it("removes people who do not hold the certificate and keeps the one who does", async () => {
    const tpl = await template("CME");
    const holder = await registration("holder@x.com");
    const plain = await registration("plain@x.com");
    await assign(tpl, { registrationIds: [holder, plain] });
    await db.issuedCertificate.create({
      data: { eventId, organizationId: seed.orgId, registrationId: holder, certificateTemplateId: tpl, type: "ATTENDANCE", serial: "S-9", recipientSnapshot: {} },
    });

    const res = await unassignCertificate({ eventId, templateId: tpl, registrationIds: [holder, plain], userId: seed.userId, source: "rest" });
    expect(res).toMatchObject({ ok: true, removed: 1, keptIssued: 1 });
    const left = await db.certificateAssignment.findMany({ where: { certificateTemplateId: tpl }, select: { registrationId: true } });
    expect(left.map((r) => r.registrationId)).toEqual([holder]);
  });

  it("an unassigned person is not issued to by the sweep", async () => {
    const tpl = await template("CME", { auto: true });
    const reg = await registration("off@x.com");
    await assign(tpl, { registrationIds: [reg] });
    await unassignCertificate({ eventId, templateId: tpl, registrationIds: [reg], userId: seed.userId, source: "rest" });
    await db.registration.update({ where: { id: reg }, data: { surveyCompletedAt: ANSWERED } });
    expect(await runAutoIssueSweep()).toMatchObject({ scanned: 1, runsCreated: 0 });
  });
});

describe("the readers", () => {
  it("counts, the Issue pool and the report leave a cancelled registration out but keep its row", async () => {
    const tpl = await template("CME");
    const live = await registration("live@x.com");
    const gone = await registration("gone@x.com");
    await assign(tpl, { registrationIds: [live, gone] });
    await db.registration.update({ where: { id: gone }, data: { status: "CANCELLED" } });

    expect((await countAssignmentsByTemplate(db, [tpl])).get(tpl)).toBe(1);
    const eligible = await eligibleForTemplates(eventId, [{ id: tpl, name: "CME", category: "ATTENDANCE" }]);
    expect(eligible.people.map((p) => p.registrationId)).toEqual([live]);
    expect(eligible.perTemplate[0]).toMatchObject({ count: 1, assigned: 1 });

    const report = await loadRecipientReport({ id: eventId, timezone: "Asia/Dubai", cmeHours: null });
    expect(report.rows.map((r) => [r.email, r.state]).sort()).toEqual([
      ["gone@x.com", "CANCELLED"],
      ["live@x.com", "READY"],
    ]);
    // Reinstated, they have what they had.
    await db.registration.update({ where: { id: gone }, data: { status: "CONFIRMED" } });
    expect((await countAssignmentsByTemplate(db, [tpl])).get(tpl)).toBe(2);
  });

  it("the report tells waiting, sending, sent and answered-but-not-assigned apart", async () => {
    const tpl = await template("CME", { auto: true });
    const waiting = await registration("waiting@x.com");
    const sending = await registration("sending@x.com", { answered: true });
    const sent = await registration("sent@x.com", { answered: true, swept: true });
    const stuck = await registration("stuck@x.com", { answered: true, swept: true });
    await registration("forgotten@x.com", { answered: true, swept: true });
    await db.certificateAssignment.createMany({
      data: [waiting, sending, sent, stuck].map((registrationId) => ({
        eventId, organizationId: seed.orgId, certificateTemplateId: tpl, registrationId, source: "TAG_BACKFILL",
      })),
    });
    // Issued from the person's own sheet (no run): that counts as handed over.
    await db.issuedCertificate.create({
      data: { eventId, organizationId: seed.orgId, registrationId: sent, certificateTemplateId: tpl, type: "ATTENDANCE", serial: "S-7", cmeHoursSnapshot: 6, recipientSnapshot: {}, pdfUrl: "/uploads/certificates/x.pdf" },
    });

    const report = await loadRecipientReport({ id: eventId, timezone: "Asia/Dubai", cmeHours: 2 });
    expect(Object.fromEntries(report.rows.map((r) => [r.email, r.state]))).toEqual({
      "waiting@x.com": "WAITING_FOR_SURVEY",
      "sending@x.com": "SENDING",
      "sent@x.com": "SENT",
      // Answered, already looked at before the list existed, nothing sent: needs Issue.
      "stuck@x.com": "READY",
    });
    expect(report.templates[0]).toMatchObject({ assigned: 4, counts: { SENT: 1, SENDING: 1, WAITING_FOR_SURVEY: 1, READY: 1 } });
    expect(report.answeredNotAssigned.map((r) => r.email)).toEqual(["forgotten@x.com"]);
    // Hours: the certificate's own snapshot, else what the event would give.
    const hours = Object.fromEntries(report.rows.map((r) => [r.email, r.cmeHours]));
    expect(hours["sent@x.com"]).toBe("6");
    expect(hours["waiting@x.com"]).toBe("2");
    expect(report.rows.find((r) => r.email === "sent@x.com")?.certificate?.serial).toBe("S-7");
  });

  it("M4: the Issue pool leaves out a person whose certificate is already on its way, and offers them again if that run dies", async () => {
    const tpl = await template("CME", { auto: true });
    const flying = await registration("flying@x.com", { answered: true, swept: true });
    const waiting = await registration("waiting@x.com");
    expect(await assign(tpl, { registrationIds: [flying, waiting] }, 1)).toMatchObject({ ok: true, sendNow: 1 });
    expect(await runAutoIssueSweep()).toMatchObject({ scanned: 1, runsCreated: 1 });

    // Staff open the Issue tab while the sweep's run is still PENDING: pressing
    // Issue must not email the same certificate a second time.
    const pool = async () =>
      (await eligibleForTemplates(eventId, [{ id: tpl, name: "CME", category: "ATTENDANCE" }])).people.map((p) => p.registrationId);
    expect(await pool()).toEqual([waiting]);

    // The auto run fails: nothing will send it, so the Issue tab offers them again.
    await db.certificateIssueRun.updateMany({ where: { eventId, autoIssue: true }, data: { status: "FAILED" } });
    expect((await pool()).sort()).toEqual([flying, waiting].sort());
  });

  it("answered-but-not-assigned leaves out faculty whose SPEAKER record holds a certificate (pointer or same address)", async () => {
    const appreciation = await template("Faculty", { category: "APPRECIATION", auto: true });
    const companion = await registration("comp@x.com", { answered: true, swept: true });
    const byPointer = await speaker("faculty@x.com", { sourceRegistrationId: companion });
    await registration("self@x.com", { answered: true, swept: true });
    const byEmail = await speaker("self@x.com");
    // A speaker nobody assigned: their registration IS on no list.
    await registration("unassigned-speaker@x.com", { answered: true, swept: true });
    await speaker("unassigned-speaker@x.com");
    await registration("forgotten@x.com", { answered: true, swept: true });
    await db.certificateAssignment.createMany({
      data: [byPointer, byEmail].map((speakerId) => ({
        eventId, organizationId: seed.orgId, certificateTemplateId: appreciation, speakerId, source: "MANUAL",
      })),
    });

    const report = await loadRecipientReport({ id: eventId, timezone: "Asia/Dubai", cmeHours: null });
    expect(report.answeredNotAssigned.map((r) => r.email).sort()).toEqual(["forgotten@x.com", "unassigned-speaker@x.com"]);
    // The same list when the report is narrowed to another template.
    const attendance = await template("CME");
    const narrowed = await loadRecipientReport({ id: eventId, timezone: "Asia/Dubai", cmeHours: null }, { templateId: attendance });
    expect(narrowed.answeredNotAssigned.map((r) => r.email).sort()).toEqual(["forgotten@x.com", "unassigned-speaker@x.com"]);
  });

  it("the people view lists EVERYONE at the event, assigned or not, with a cell per certificate they hold", async () => {
    const day1 = await template("CME Day 1", { auto: true });
    const day2 = await template("CME Day 2");
    const faculty = await template("Faculty", { category: "APPRECIATION", auto: true });
    const zara = await registration("zara@x.com", { answered: true, swept: true });
    const adam = await registration("adam@x.com");
    await registration("lost@x.com", { answered: true, swept: true });
    const gone = await registration("gone@x.com");
    await registration("never-listed@x.com", { status: "CANCELLED" });
    const companion = await registration("comp@x.com", { answered: true, swept: true });
    const prof = await speaker("prof@x.com", { sourceRegistrationId: companion });
    const guest = await speaker("guest@x.com");
    await db.registration.update({ where: { id: adam }, data: { status: "CHECKED_IN" } });
    await assign(day1, { registrationIds: [adam, gone] });
    await db.certificateAssignment.create({
      data: { eventId, organizationId: seed.orgId, certificateTemplateId: day1, registrationId: zara, source: "TAG_BACKFILL" },
    });
    await assign(day2, { registrationIds: [zara] });
    await db.certificateAssignment.create({
      data: { eventId, organizationId: seed.orgId, certificateTemplateId: faculty, speakerId: prof, source: "MANUAL" },
    });
    await db.registration.update({ where: { id: gone }, data: { status: "CANCELLED" } });

    const people = await loadCertificatePeople({ id: eventId, timezone: "Asia/Dubai", cmeHours: 6 }, SEES_EVERYONE);

    // Sorted by name; a cancelled registration only while it is still on a list.
    expect(people.registrations.map((p) => p.email)).toEqual([
      "adam@x.com",
      "comp@x.com",
      "gone@x.com",
      "lost@x.com",
      "zara@x.com",
    ]);
    const reg = Object.fromEntries(people.registrations.map((p) => [p.email, p]));
    expect(reg["adam@x.com"]).toMatchObject({ id: adam, checkedIn: true, cancelled: false, surveyAnsweredAt: null, noList: false, registrationType: "Physician" });
    expect(Object.keys(reg["adam@x.com"].cells)).toEqual([day1]);
    expect(reg["adam@x.com"].cells[day1]).toMatchObject({ state: "WAITING_FOR_SURVEY", source: "MANUAL", cmeHours: "6", certificate: null });
    // One person, two certificates, two different states.
    expect(reg["zara@x.com"].cells[day1].state).toBe("READY");
    expect(reg["zara@x.com"].cells[day2].state).toBe("READY");
    expect(reg["zara@x.com"].surveyAnsweredAt).toEqual(ANSWERED);
    expect(reg["gone@x.com"]).toMatchObject({ cancelled: true });
    expect(reg["gone@x.com"].cells[day1].state).toBe("CANCELLED");
    // Answered and on no list: flagged. The faculty member's companion is not (their speaker record holds one).
    expect(reg["lost@x.com"]).toMatchObject({ noList: true, cells: {} });
    expect(reg["comp@x.com"]).toMatchObject({ noList: false, cells: {} });

    // Speakers: their survey is read through their registration at the event.
    expect(people.speakers.map((p) => p.email)).toEqual(["guest@x.com", "prof@x.com"]);
    const spk = Object.fromEntries(people.speakers.map((p) => [p.email, p]));
    expect(spk["prof@x.com"]).toMatchObject({ id: prof, registrationType: null, surveyAnsweredAt: ANSWERED });
    expect(spk["prof@x.com"].cells[faculty].state).toBe("READY");
    expect(spk["guest@x.com"]).toMatchObject({ id: guest, surveyAnsweredAt: null, cells: {} });

    // The summary cards are the report's own: the two views cannot disagree.
    const report = await loadRecipientReport({ id: eventId, timezone: "Asia/Dubai", cmeHours: 6 });
    expect(people.templates).toEqual(report.templates);
    expect(people.templates.find((t) => t.id === day1)).toMatchObject({ assigned: 3 });
  });

  it("the people view is sorted by surname, whatever the title", async () => {
    await template("CME");
    for (const [title, firstName, lastName] of [["PROF", "Aaron", "Zed"], [null, "Zoe", "Abel"], ["DR", "Bea", "Mills"], ["DR", "Al", "Mills"]] as const) {
      const attendee = await db.attendee.create({
        data: { organizationId: seed.orgId, email: `${firstName}.${lastName}@x.com`.toLowerCase(), title, firstName, lastName },
        select: { id: true },
      });
      await db.registration.create({ data: { eventId, organizationId: seed.orgId, ticketTypeId: typeId, attendeeId: attendee.id, status: "CONFIRMED" } });
    }
    const people = await loadCertificatePeople({ id: eventId, timezone: "Asia/Dubai", cmeHours: null }, SEES_EVERYONE);
    // Not "Zoe Abel" last because she has no title, and not every "Dr." before every "Prof.".
    expect(people.registrations.map((p) => p.name)).toEqual(["Zoe Abel", "Dr. Al Mills", "Dr. Bea Mills", "Prof. Aaron Zed"]);
    expect(people.registrations.every((p) => p.statusLabel === null)).toBe(true);
  });

  it("the people view tags each speaker with a group, so abstract authors and declined speakers are not mistaken for faculty", async () => {
    const appreciation = await template("Faculty", { category: "APPRECIATION" });
    const faculty = await speaker("faculty@x.com", { status: "CONFIRMED" });
    const declined = await speaker("declined@x.com", { status: "DECLINED" });
    // Signed up through the abstract door and is on no session: an abstract submitter, not faculty.
    const author = await speaker("author@x.com", { submitterSource: "abstract" });
    const proposer = await speaker("proposer@x.com", { submitterSource: "proposal" });
    // Reached through a registration on the same address, not through a companion pointer.
    await registration("faculty@x.com", { answered: true, swept: true });
    await db.certificateAssignment.create({
      data: { eventId, organizationId: seed.orgId, certificateTemplateId: appreciation, speakerId: author, source: "MANUAL" },
    });

    const people = await loadCertificatePeople({ id: eventId, timezone: "Asia/Dubai", cmeHours: null }, SEES_EVERYONE);
    const spk = Object.fromEntries(people.speakers.map((p) => [p.id, p]));
    expect(spk[faculty]).toMatchObject({ speakerBucket: "invited", statusLabel: "Confirmed", surveyAnsweredAt: ANSWERED });
    expect(spk[declined]).toMatchObject({ speakerBucket: "inactive", statusLabel: "Declined" });
    expect(spk[author]).toMatchObject({ speakerBucket: "submitters", statusLabel: "Invited" });
    expect(spk[proposer]).toMatchObject({ speakerBucket: "proposers" });
    expect(people.registrations.every((p) => p.speakerBucket === null)).toBe(true);

    // A caller who may not read abstracts or proposals is not told who is an author: as on the Speakers page.
    const blind = await loadCertificatePeople(
      { id: eventId, timezone: "Asia/Dubai", cmeHours: null },
      { ...SEES_EVERYONE, submissions: { abstracts: false, proposals: false } },
    );
    const blindSpk = Object.fromEntries(blind.speakers.map((p) => [p.id, p]));
    expect(blindSpk[author].speakerBucket).toBe("invited");
    expect(blindSpk[proposer].speakerBucket).toBe("invited");
    expect(blindSpk[declined].speakerBucket).toBe("inactive");
  });

  it("without the list's own key, the people view shows only who is already on a list (and who answered and is on none)", async () => {
    const cme = await template("CME");
    const appreciation = await template("Faculty", { category: "APPRECIATION" });
    const assigned = await registration("assigned@x.com");
    const lost = await registration("lost@x.com", { answered: true, swept: true });
    await registration("stranger@x.com");
    const onList = await speaker("onlist@x.com");
    await speaker("other-speaker@x.com");
    await assign(cme, { registrationIds: [assigned] });
    await assign(appreciation, { speakerIds: [onList] });

    const everyone = await loadCertificatePeople({ id: eventId, timezone: "Asia/Dubai", cmeHours: null }, SEES_EVERYONE);
    expect(everyone.everyone).toEqual({ registrations: true, speakers: true });
    expect(everyone.registrations).toHaveLength(3);
    expect(everyone.speakers).toHaveLength(2);

    // certificates.read alone: what the report has always shown, and not the event's attendee list.
    const limited = await loadCertificatePeople(
      { id: eventId, timezone: "Asia/Dubai", cmeHours: null },
      { ...SEES_EVERYONE, registrations: false, speakers: false },
    );
    expect(limited.everyone).toEqual({ registrations: false, speakers: false });
    expect(limited.registrations.map((p) => p.id).sort()).toEqual([assigned, lost].sort());
    expect(limited.registrations.some((p) => p.email === "stranger@x.com")).toBe(false);
    expect(limited.speakers.map((p) => p.id)).toEqual([onList]);

    // Each list is judged on its own key.
    const speakersOnly = await loadCertificatePeople(
      { id: eventId, timezone: "Asia/Dubai", cmeHours: null },
      { ...SEES_EVERYONE, registrations: false },
    );
    expect(speakersOnly.registrations).toHaveLength(2);
    expect(speakersOnly.speakers).toHaveLength(2);
  });

  it("a pasted list of emails resolves whatever the case, and says who it could not find", async () => {
    const live = await registration("Mixed.Case@X.com");
    await registration("cancelled@x.com", { status: "CANCELLED" });
    const res = await resolveAssignmentEmails({
      eventId,
      category: "ATTENDANCE",
      emails: [" mixed.case@x.com ", "MIXED.CASE@x.com", "cancelled@x.com", "stranger@x.com", ""],
    });
    expect(res).toEqual({ registrationIds: [live], speakerIds: [], unmatched: ["stranger@x.com"], cancelled: ["cancelled@x.com"] });
  });
});

describe("the migration's backfill", () => {
  const migration = readFileSync(
    path.resolve(process.cwd(), "prisma/migrations/20261111120000_certificate_assignment/migration.sql"),
    "utf8",
  );
  const block = migration.slice(migration.indexOf("-- BACKFILL:BEGIN"), migration.indexOf("-- BACKFILL:END"));
  // Each INSERT ... ON CONFLICT DO NOTHING statement, comments dropped.
  const statements = block
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  const backfill = async () => {
    for (const sql of statements) await db.$executeRawUnsafe(sql);
  };

  it("has the four inserts between its markers", () => {
    expect(statements).toHaveLength(4);
    expect(statements.every((s) => s.startsWith('INSERT INTO "CertificateAssignment"') && s.endsWith("ON CONFLICT DO NOTHING"))).toBe(true);
  });

  it("assigns exactly the people the tag matched, plus anyone already holding the certificate, and re-running adds nothing", async () => {
    const cme = await template("CME", { tag: "Cme" });
    const speakerTpl = await template("Speaker", { category: "APPRECIATION", tag: "Speaker" });
    const untagged = await template("No tag");
    const blank = await template("Blank tag", { tag: "   " });

    const tagged = await registration("tagged@x.com", { tags: ["Comp", "Cme"] });
    const wrongCase = await registration("case@x.com", { tags: ["cme"] });
    const holderNoTag = await registration("holder@x.com");
    const revoked = await registration("revoked@x.com");
    const taggedSpeaker = await speaker("spk@x.com", { tags: ["Speaker"] });
    await speaker("other@x.com", { tags: ["Moderator"] });
    const elsewhere = await event("Elsewhere");
    await registration("elsewhere@x.com", { tags: ["Cme"], inEvent: elsewhere });
    await db.issuedCertificate.createMany({
      data: [
        { eventId, organizationId: seed.orgId, registrationId: holderNoTag, certificateTemplateId: cme, type: "ATTENDANCE", serial: "B-1", recipientSnapshot: {} },
        { eventId, organizationId: seed.orgId, registrationId: revoked, certificateTemplateId: cme, type: "ATTENDANCE", serial: "B-2", recipientSnapshot: {}, revokedAt: new Date() },
      ],
    });

    await backfill();
    const rows = await db.certificateAssignment.findMany({
      select: { certificateTemplateId: true, registrationId: true, speakerId: true, source: true, organizationId: true, eventId: true },
    });
    const seen = rows.map((r) => `${r.certificateTemplateId}:${r.registrationId ?? r.speakerId}:${r.source}`).sort();
    expect(seen).toEqual(
      [
        `${cme}:${tagged}:TAG_BACKFILL`,
        `${cme}:${holderNoTag}:ISSUED_BACKFILL`,
        `${speakerTpl}:${taggedSpeaker}:TAG_BACKFILL`,
      ].sort(),
    );
    // The match is the code's: exact case, and never across events.
    expect(seen.some((s) => s.includes(wrongCase))).toBe(false);
    expect(rows.every((r) => r.organizationId === seed.orgId && r.eventId === eventId)).toBe(true);
    expect(rows.some((r) => [untagged, blank].includes(r.certificateTemplateId))).toBe(false);

    await backfill();
    expect(await db.certificateAssignment.count()).toBe(3);

    // A tag added between the migration and the new code going live is picked
    // up by running the same block again (scripts/backfill-certificate-assignments.ts).
    const late = await registration("late@x.com", { tags: ["Cme"] });
    await backfill();
    expect(await db.certificateAssignment.count({ where: { registrationId: late, certificateTemplateId: cme } })).toBe(1);
    expect(await db.certificateAssignment.count()).toBe(4);
  });

  it("M3: re-running the catch-up never puts back someone staff removed after the deploy", async () => {
    const cme = await template("CME", { tag: "Cme" });
    const kept = await registration("kept@x.com", { tags: ["Cme"] });
    const removed = await registration("removed@x.com", { tags: ["Cme"] });
    expect(await applyBackfill(statements, { write: true })).toEqual({ inserted: 2, heldBack: 0 });

    // Staff look at the list and take one person off. Their tag is still there.
    expect(await unassignCertificate({ eventId, templateId: cme, registrationIds: [removed], userId: seed.userId, source: "rest" }))
      .toMatchObject({ ok: true, removed: 1 });
    await auditLanded("CERTIFICATE_UNASSIGNED");
    // And a tag is added mid-deploy: the reason the catch-up exists.
    const late = await registration("late@x.com", { tags: ["Cme"] });

    // The dry run says what would happen and changes nothing.
    expect(await applyBackfill(statements, { write: false })).toEqual({ inserted: 1, heldBack: 1 });
    expect(await db.certificateAssignment.count()).toBe(1);

    expect(await applyBackfill(statements, { write: true })).toEqual({ inserted: 1, heldBack: 1 });
    const onList = await db.certificateAssignment.findMany({ where: { certificateTemplateId: cme }, select: { registrationId: true } });
    expect(onList.map((r) => r.registrationId).sort()).toEqual([kept, late].sort());
    // Staff put the person back by hand: that row is theirs, and stays.
    await assign(cme, { registrationIds: [removed] });
    expect(await applyBackfill(statements, { write: true })).toEqual({ inserted: 0, heldBack: 0 });
    expect(await db.certificateAssignment.count({ where: { certificateTemplateId: cme } })).toBe(3);
  });

  it("a backfilled person who answered before the migration is NOT sent a certificate by the deploy", async () => {
    const cme = await template("CME", { auto: true, tag: "Cme" });
    // Tagged after answering: the old sweep had already passed them over.
    const reg = await registration("old@x.com", { tags: ["Cme"], answered: true, swept: true });
    await backfill();
    expect(await db.certificateAssignment.count({ where: { certificateTemplateId: cme, registrationId: reg } })).toBe(1);
    // The backfill writes rows only: it does not re-open anyone.
    expect(await runAutoIssueSweep()).toMatchObject({ scanned: 0, runsCreated: 0 });
    expect(await queued()).toEqual([]);
  });
});
