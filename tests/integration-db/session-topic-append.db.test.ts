/**
 * appendSessionTopics on a REAL Postgres (review of 5029717c, Nov 12, 2026).
 *
 * Its two promises are about what the database does under two writers, so a
 * mocked Prisma cannot show either: (1) two appends to one session never take
 * the same position or both find a title missing, because the transaction
 * opens by touching the session row; (2) an edit that read the session before
 * the append is refused as stale, instead of replacing the topic list with one
 * that never had the new topics.
 *
 * Run: INTEGRATION_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/crm_test npm run test:integration-db
 */
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { appendSessionTopics, updateSession } from "@/services/session-service";
import { resetCrm } from "./helper";

let orgId: string;
let userId: string;
let eventId: string;
let sessionId: string;
let counter = 0;

const base = () => ({ eventId, organizationId: orgId, sessionId, actorUserId: userId, source: "rest" as const });

const topics = () =>
  db.sessionTopic.findMany({ where: { sessionId }, orderBy: { sortOrder: "asc" }, select: { title: true, sortOrder: true } });

beforeEach(async () => {
  const seeded = await resetCrm();
  orgId = seeded.orgId;
  userId = seeded.userId;
  counter += 1;
  const event = await db.event.create({
    data: { organizationId: orgId, name: "Topic Append", slug: `topic-append-${counter}`, startDate: new Date("2027-01-15"), endDate: new Date("2027-01-17") },
    select: { id: true },
  });
  eventId = event.id;
  const session = await db.eventSession.create({
    data: {
      eventId,
      organizationId: orgId,
      name: "Plenary 1",
      startTime: new Date("2027-01-15T09:00:00Z"),
      endTime: new Date("2027-01-15T10:00:00Z"),
      topics: { create: [{ title: "Opening", sortOrder: 0, organizationId: orgId }] },
    },
    select: { id: true },
  });
  sessionId = session.id;
});

describe("two appends to one session at the same time", () => {
  it("the same file imported twice at once adds each topic once", async () => {
    const file = [{ title: "Talk A" }, { title: "Discussion" }, { title: "Talk B" }, { title: "Discussion" }];

    const results = await Promise.all(
      Array.from({ length: 6 }, () => appendSessionTopics({ ...base(), onlyMissingTitles: true, topics: file })),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    const added = results.reduce((n, r) => n + (r.ok ? r.added.length : 0), 0);
    expect(added).toBe(4);
    expect((await topics()).map((t) => t.title)).toEqual(["Opening", "Talk A", "Discussion", "Talk B", "Discussion"]);
  });

  it("appends that add different topics never share a position", async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => appendSessionTopics({ ...base(), topics: [{ title: `Talk ${i}` }] })),
    );

    const rows = await topics();
    expect(rows).toHaveLength(9);
    expect(rows.map((t) => t.sortOrder)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("an edit that read the session before the append", () => {
  it("is refused as stale and the appended topic survives", async () => {
    const before = await db.eventSession.findUniqueOrThrow({ where: { id: sessionId }, select: { updatedAt: true } });

    const appended = await appendSessionTopics({ ...base(), topics: [{ title: "Talk A" }] });
    expect(appended.ok).toBe(true);

    // The dialog saves the topic list it loaded: "Opening" alone.
    const stale = await updateSession({
      eventId,
      organizationId: orgId,
      sessionId,
      userId,
      source: "rest",
      expectedUpdatedAt: before.updatedAt,
      topics: [{ title: "Opening" }],
    });

    expect(stale).toMatchObject({ ok: false, code: "STALE_WRITE" });
    expect((await topics()).map((t) => t.title)).toEqual(["Opening", "Talk A"]);
  });

  it("an edit that read the session AFTER the append saves", async () => {
    await appendSessionTopics({ ...base(), topics: [{ title: "Talk A" }] });
    const after = await db.eventSession.findUniqueOrThrow({ where: { id: sessionId }, select: { updatedAt: true } });

    const saved = await updateSession({
      eventId,
      organizationId: orgId,
      sessionId,
      userId,
      source: "rest",
      expectedUpdatedAt: after.updatedAt,
      name: "Plenary 1 (renamed)",
    });

    expect(saved.ok).toBe(true);
    expect((await topics()).map((t) => t.title)).toEqual(["Opening", "Talk A"]);
  });
});
