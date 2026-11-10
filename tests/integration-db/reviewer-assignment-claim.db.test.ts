/**
 * "Send assignments" on a REAL Postgres (review of 2df0f9e6, Nov 10, 2026).
 *
 * The reviewer's rows are leased in one conditional UPDATE before their email
 * goes out, so two overlapping sends (a retry after a gateway timeout, two
 * tabs, two organisers) cannot both email the same assignments. That safety is
 * Postgres re-testing the UPDATE's own-column predicates after a row lock
 * wait. A mocked Prisma has one fake connection and cannot show it, which is
 * exactly how the unclaimed version passed its unit tests.
 *
 * The email transport is the only thing mocked: nothing here may reach SES.
 *
 * Run: docker compose --profile crm-test up -d
 *      INTEGRATION_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/crm_test npm run test:integration-db
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockSend, hooks } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  // Runs between a send's first read of the rows and its claim: the one place
  // a test can hold a send to force an interleaving.
  hooks: { betweenReadAndClaim: null as null | (() => Promise<void>) },
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendEmail: (...a: unknown[]) => mockSend(...a),
    getEventTemplate: async (...a: Parameters<typeof actual.getEventTemplate>) => {
      await hooks.betweenReadAndClaim?.();
      return actual.getEventTemplate(...a);
    },
  };
});

import { db } from "@/lib/db";
import { ASSIGNMENT_CLAIM_TTL_MS, sendPendingAssignments } from "@/lib/abstract-reviewer-notify";
import { resetCrm } from "./helper";

interface Seed {
  orgId: string;
  adminId: string;
  eventId: string;
  speakerId: string;
}

let counter = 0;

async function seed(): Promise<Seed> {
  const { orgId, userId: adminId } = await resetCrm();
  counter += 1;
  const event = await db.event.create({
    data: { organizationId: orgId, name: "Claim Test Event", slug: `claim-test-${counter}`, startDate: new Date("2027-01-15"), endDate: new Date("2027-01-17") },
    select: { id: true },
  });
  const speaker = await db.speaker.create({
    data: { eventId: event.id, organizationId: orgId, email: "author@test.local", firstName: "Ann", lastName: "Author" },
    select: { id: true },
  });
  return { orgId, adminId, eventId: event.id, speakerId: speaker.id };
}

async function reviewer(email: string, setUp = true): Promise<string> {
  const user = await db.user.create({
    data: { email, passwordHash: "x", firstName: "Rev", lastName: email.split("@")[0], role: "REVIEWER", emailVerified: setUp ? new Date() : null },
    select: { id: true },
  });
  return user.id;
}

async function assign(s: Seed, userId: string, title: string, over: { status?: "SUBMITTED" | "ACCEPTED"; conflictFlag?: boolean } = {}): Promise<string> {
  const abstract = await db.abstract.create({
    data: { eventId: s.eventId, organizationId: s.orgId, speakerId: s.speakerId, title, content: "Body", status: over.status ?? "SUBMITTED" },
    select: { id: true },
  });
  const row = await db.abstractReviewer.create({
    data: { abstractId: abstract.id, organizationId: s.orgId, userId, assignedById: s.adminId, role: "PRIMARY", conflictFlag: over.conflictFlag ?? false },
    select: { id: true },
  });
  return row.id;
}

const send = (s: Seed, reviewerUserId: string) =>
  sendPendingAssignments({ eventId: s.eventId, organizationId: s.orgId, reviewerUserId, triggeredByUserId: s.adminId });
const rows = (userId: string) =>
  db.abstractReviewer.findMany({ where: { userId }, select: { id: true, notifiedAt: true, notifyClaimedAt: true, notifyClaimToken: true }, orderBy: { assignedAt: "asc" } });
const slowSend = (ms: number) => () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), ms));
const bodies = () => mockSend.mock.calls.map((c) => (c[0] as { textContent: string }).textContent);

let s: Seed;
beforeEach(async () => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({ success: true });
  hooks.betweenReadAndClaim = null;
  s = await seed();
});

describe("sendPendingAssignments on real Postgres", () => {
  it("six sends started together for one reviewer: exactly ONE email, every row marked once", async () => {
    const rev = await reviewer("one@test.local");
    await assign(s, rev, "First abstract");
    await assign(s, rev, "Second abstract");
    await assign(s, rev, "Third abstract");
    mockSend.mockImplementation(slowSend(150));

    const results = await Promise.all(Array.from({ length: 6 }, () => send(s, rev)));

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.ok)).toEqual([{ ok: true, sent: 3, recorded: true, reclaimed: false }]);
    // Everyone else was told someone has it, or found nothing left: never a second email.
    expect(results.filter((r) => !r.ok).map((r) => (r.ok ? "" : r.code)).every((c) => c === "IN_PROGRESS" || c === "NOTHING_PENDING")).toBe(true);
    expect(bodies()[0]).toContain("1. First abstract");
    expect(bodies()[0]).toContain("3. Third abstract");
    const after = await rows(rev);
    expect(after.every((r) => r.notifiedAt && !r.notifyClaimedAt && !r.notifyClaimToken)).toBe(true);
  });

  it("a send that read the rows as free, then claims AFTER another began emailing, is stopped by the claim itself", async () => {
    // The retry after a gateway timeout, exactly: both requests read the rows
    // as unsent; the second reaches its claim while the first is mid-send. Only
    // the claim's own WHERE (not claimed, or claim expired) can stop it, and
    // only Postgres can show that: this is the case the six-at-once test hides.
    const rev = await reviewer("retry-race@test.local");
    await assign(s, rev, "First abstract");
    await assign(s, rev, "Second abstract");

    let arrived = 0;
    let bothHaveRead!: () => void;
    const barrier = new Promise<void>((resolve) => (bothHaveRead = resolve));
    let firstIsSending!: () => void;
    const midSend = new Promise<void>((resolve) => (firstIsSending = resolve));
    hooks.betweenReadAndClaim = async () => {
      const mine = ++arrived;
      if (arrived === 2) bothHaveRead();
      await barrier; // both have read the rows as free
      if (mine === 2) await midSend; // the second claims only once the first is sending
    };
    mockSend.mockImplementation(async () => {
      firstIsSending();
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { success: true };
    });

    const results = await Promise.all([send(s, rev), send(s, rev)]);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.ok)).toEqual([{ ok: true, sent: 2, recorded: true, reclaimed: false }]);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, code: "IN_PROGRESS" });
    expect((await rows(rev)).every((r) => r.notifiedAt && !r.notifyClaimToken)).toBe(true);
  });

  it("two reviewers do not block each other", async () => {
    const a = await reviewer("a@test.local");
    const b = await reviewer("b@test.local");
    await assign(s, a, "For A");
    await assign(s, b, "For B");
    mockSend.mockImplementation(slowSend(100));
    const [ra, rb] = await Promise.all([send(s, a), send(s, b)]);
    expect(ra).toMatchObject({ ok: true, sent: 1 });
    expect(rb).toMatchObject({ ok: true, sent: 1 });
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("a live claim answers IN_PROGRESS and sends nothing; the rows still show as not emailed", async () => {
    const rev = await reviewer("held@test.local");
    const id = await assign(s, rev, "Held");
    await db.abstractReviewer.update({ where: { id }, data: { notifyClaimedAt: new Date(), notifyClaimToken: "someone-else" } });
    expect(await send(s, rev)).toMatchObject({ ok: false, code: "IN_PROGRESS" });
    expect(mockSend).not.toHaveBeenCalled();
    expect((await rows(rev))[0]).toMatchObject({ notifiedAt: null, notifyClaimToken: "someone-else" });
  });

  it("a claim older than the lease (a killed send) is taken over, sent, and reported as reclaimed", async () => {
    const rev = await reviewer("stale@test.local");
    const id = await assign(s, rev, "Interrupted");
    await db.abstractReviewer.update({
      where: { id },
      data: { notifyClaimedAt: new Date(Date.now() - ASSIGNMENT_CLAIM_TTL_MS - 60_000), notifyClaimToken: "dead-process" },
    });
    expect(await send(s, rev)).toEqual({ ok: true, sent: 1, recorded: true, reclaimed: true });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect((await rows(rev))[0]).toMatchObject({ notifyClaimedAt: null, notifyClaimToken: null });
  });

  it("a failed send leaves the rows not emailed with the claim cleared, and the next press sends", async () => {
    const rev = await reviewer("retry@test.local");
    await assign(s, rev, "Retry me");
    mockSend.mockResolvedValueOnce({ success: false, error: "provider down" });
    expect(await send(s, rev)).toMatchObject({ ok: false, code: "SEND_FAILED" });
    expect((await rows(rev))[0]).toMatchObject({ notifiedAt: null, notifyClaimedAt: null, notifyClaimToken: null });
    expect(await send(s, rev)).toMatchObject({ ok: true, sent: 1 });
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("an assignment made while a send is in flight stays pending for the next one", async () => {
    const rev = await reviewer("late@test.local");
    await assign(s, rev, "Early");
    mockSend.mockImplementation(async () => {
      await assign(s, rev, "Arrived mid-send");
      return { success: true };
    });
    expect(await send(s, rev)).toMatchObject({ ok: true, sent: 1 });
    const after = await rows(rev);
    expect(after.map((r) => !!r.notifiedAt)).toEqual([true, false]);
    mockSend.mockResolvedValue({ success: true });
    expect(await send(s, rev)).toMatchObject({ ok: true, sent: 1 });
    expect(bodies()[1]).toContain("Arrived mid-send");
    expect(bodies()[1]).not.toContain("Early");
  });

  it("leaves out a declared conflict and a decided abstract, and an account not set up gets nothing", async () => {
    const rev = await reviewer("mixed@test.local");
    await assign(s, rev, "Sendable");
    await assign(s, rev, "Conflicted", { conflictFlag: true });
    await assign(s, rev, "Already accepted", { status: "ACCEPTED" });
    expect(await send(s, rev)).toMatchObject({ ok: true, sent: 1 });
    expect(bodies()[0]).toContain("Sendable");
    expect(bodies()[0]).not.toMatch(/Conflicted|Already accepted/);
    // Nothing sendable is left, so a second press is a no-op, not a loop.
    expect(await send(s, rev)).toMatchObject({ ok: false, code: "NOTHING_PENDING" });

    const pending = await reviewer("pending@test.local", false);
    await assign(s, pending, "Waiting for the invitation");
    expect(await send(s, pending)).toMatchObject({ ok: false, code: "ACCOUNT_NOT_SET_UP" });
    expect((await rows(pending))[0]).toMatchObject({ notifiedAt: null, notifyClaimedAt: null });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
