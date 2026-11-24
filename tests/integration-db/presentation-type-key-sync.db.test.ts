/**
 * Presentation types are stored as text, and the previous image still works
 * (Nov 24, 2026; docs/ABSTRACT_PRESENTATION_TYPES_PLAN.md step 2), on a REAL
 * Postgres. Review of 2729e1de3: the triggers were proven by hand only.
 *
 * The Prisma fields `presentationType`, `requestedPresentationType` and
 * `recommendedFormat` are the text columns; the `...Legacy` fields are the old
 * enum columns, which the previous image still reads and writes, so a write
 * through a `...Legacy` field here stands in for it. The triggers keep each
 * pair in step:
 *   - the old image writes the enum: the key follows;
 *   - this image writes a key: the enum follows when the key is one of its
 *     values, else it is emptied (the old image reads no type, never fails);
 *   - both in one write: the key wins.
 *
 * This harness builds its database with `prisma db push`, which has the
 * columns but never the triggers, so the migration is applied here first,
 * which also proves it applies again on a database that already has the
 * columns.
 *
 * Run: INTEGRATION_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/crm_test npm run test:integration-db
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { resetCrm } from "./helper";

const MIGRATION = join(process.cwd(), "prisma/migrations/20261124140000_presentation_type_key_text_columns/migration.sql");

/** Split the migration into single statements; a dollar-quoted function body stays whole. */
function statements(sql: string): string[] {
  const noComments = sql.replace(/--.*$/gm, "");
  const out: string[] = [];
  let current = "";
  let inBody = false;
  for (const line of noComments.split("\n")) {
    if ((line.match(/\$\$/g) ?? []).length % 2 === 1) inBody = !inBody;
    current += `${line}\n`;
    if (!inBody && line.trimEnd().endsWith(";")) {
      if (current.trim()) out.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

async function applyMigration(): Promise<void> {
  for (const statement of statements(readFileSync(MIGRATION, "utf8"))) {
    await db.$executeRawUnsafe(statement);
  }
}

let orgId: string;
let userId: string;
let eventId: string;
let speakerId: string;
let counter = 0;

type Built = "ORAL" | "POSTER" | "ORAL_POSTER" | "VIDEO" | "WORKSHOP";

async function abstract(data: {
  presentationType?: string | null;
  requestedPresentationType?: string | null;
  presentationTypeLegacy?: Built | null;
  requestedPresentationTypeLegacy?: Built | null;
}) {
  counter += 1;
  return db.abstract.create({
    data: { eventId, speakerId, organizationId: orgId, title: `Abstract ${counter}`, content: "Text.", ...data },
    select: { id: true },
  });
}

const types = (id: string) =>
  db.abstract.findUniqueOrThrow({
    where: { id },
    select: { presentationType: true, presentationTypeLegacy: true, requestedPresentationType: true, requestedPresentationTypeLegacy: true },
  });

const format = (id: string) =>
  db.abstractReviewSubmission.findUniqueOrThrow({ where: { id }, select: { recommendedFormat: true, recommendedFormatLegacy: true } });

beforeAll(async () => {
  await applyMigration();
});

// Leave the harness as db push built it, so no other file here runs with a
// trigger it does not know about.
afterAll(async () => {
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS abstract_presentation_type_key_sync ON "Abstract"`);
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS review_recommended_format_key_sync ON "AbstractReviewSubmission"`);
  await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public.abstract_presentation_type_key_sync()`);
  await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public.review_recommended_format_key_sync()`);
  await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public.enum_key_pair_sync(boolean, text, text, text, text, text[])`);
});

beforeEach(async () => {
  const seeded = await resetCrm();
  orgId = seeded.orgId;
  userId = seeded.userId;
  counter += 1;
  eventId = (
    await db.event.create({
      data: { organizationId: orgId, name: "Types", slug: `types-${Date.now()}-${counter}`, startDate: new Date("2027-01-01"), endDate: new Date("2027-01-02") },
      select: { id: true },
    })
  ).id;
  speakerId = (
    await db.speaker.create({ data: { eventId, organizationId: orgId, email: `author-${counter}@example.test`, firstName: "Ann", lastName: "Author" }, select: { id: true } })
  ).id;
});

describe("abstract_presentation_type_key_sync on Abstract", () => {
  it("the old image writes the enums on create: the keys follow", async () => {
    const { id } = await abstract({ presentationTypeLegacy: "POSTER", requestedPresentationTypeLegacy: "ORAL_POSTER" });
    expect(await types(id)).toEqual({
      presentationType: "POSTER",
      presentationTypeLegacy: "POSTER",
      requestedPresentationType: "ORAL_POSTER",
      requestedPresentationTypeLegacy: "ORAL_POSTER",
    });
  });

  it("this image writes a built-in key: the enum follows", async () => {
    const { id } = await abstract({ presentationType: "ORAL", requestedPresentationType: "ORAL" });
    expect(await types(id)).toMatchObject({ presentationTypeLegacy: "ORAL", requestedPresentationTypeLegacy: "ORAL" });
  });

  it("this image writes an organisation's own key: the enum is emptied", async () => {
    const { id } = await abstract({ presentationType: "SYMPOSIUM", requestedPresentationType: "SYMPOSIUM" });
    expect(await types(id)).toEqual({
      presentationType: "SYMPOSIUM",
      presentationTypeLegacy: null,
      requestedPresentationType: "SYMPOSIUM",
      requestedPresentationTypeLegacy: null,
    });
  });

  it("the old image changing a type carries it into the key; editing anything else leaves both alone", async () => {
    const { id } = await abstract({ presentationType: "SYMPOSIUM" });
    await db.abstract.update({ where: { id }, data: { title: "Renamed" } });
    expect(await types(id)).toMatchObject({ presentationType: "SYMPOSIUM", presentationTypeLegacy: null });
    await db.abstract.update({ where: { id }, data: { presentationTypeLegacy: "VIDEO" } });
    expect(await types(id)).toMatchObject({ presentationType: "VIDEO", presentationTypeLegacy: "VIDEO" });
    await db.abstract.update({ where: { id }, data: { presentationTypeLegacy: null } });
    expect(await types(id)).toMatchObject({ presentationType: null, presentationTypeLegacy: null });
  });

  it("the old image cannot clear an organisation's own type: its enum was already empty, so nothing changed", async () => {
    const { id } = await abstract({ presentationType: "SYMPOSIUM" });
    await db.abstract.update({ where: { id }, data: { presentationTypeLegacy: null } });
    expect(await types(id)).toMatchObject({ presentationType: "SYMPOSIUM", presentationTypeLegacy: null });
  });

  it("both in one write: the key wins", async () => {
    const { id } = await abstract({ presentationType: "ORAL" });
    await db.abstract.update({ where: { id }, data: { presentationType: "WORKSHOP", presentationTypeLegacy: "VIDEO" } });
    expect(await types(id)).toMatchObject({ presentationType: "WORKSHOP", presentationTypeLegacy: "WORKSHOP" });
  });

  it("a blank key is stored as no type", async () => {
    const { id } = await abstract({ presentationType: "POSTER" });
    for (const blank of ["", "   ", "\t "]) {
      await db.abstract.update({ where: { id }, data: { presentationType: "POSTER" } });
      await db.abstract.update({ where: { id }, data: { presentationType: blank } });
      expect(await types(id)).toMatchObject({ presentationType: null, presentationTypeLegacy: null });
    }
  });

  it("a bulk update keeps the two in step", async () => {
    const a = await abstract({ presentationType: "ORAL" });
    const b = await abstract({ presentationType: "POSTER" });
    await db.abstract.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { presentationType: "VIDEO" } });
    for (const { id } of [a, b]) expect(await types(id)).toMatchObject({ presentationType: "VIDEO", presentationTypeLegacy: "VIDEO" });
  });
});

describe("review_recommended_format_key_sync on AbstractReviewSubmission", () => {
  async function review(data: { recommendedFormat?: string | null; recommendedFormatLegacy?: "ORAL" | "POSTER" | "NEITHER" | "VIDEO" | "WORKSHOP" | null }) {
    const { id: abstractId } = await abstract({ presentationType: "ORAL" });
    return db.abstractReviewSubmission.create({ data: { abstractId, reviewerUserId: userId, organizationId: orgId, ...data }, select: { id: true, abstractId: true } });
  }

  it("the old image writes NEITHER: the key follows; this image writes WORKSHOP: the enum follows", async () => {
    const old = await review({ recommendedFormatLegacy: "NEITHER" });
    expect(await format(old.id)).toEqual({ recommendedFormat: "NEITHER", recommendedFormatLegacy: "NEITHER" });
    await db.abstractReviewSubmission.update({ where: { id: old.id }, data: { recommendedFormat: "WORKSHOP" } });
    expect(await format(old.id)).toEqual({ recommendedFormat: "WORKSHOP", recommendedFormatLegacy: "WORKSHOP" });
  });

  it("a key the enum cannot hold (the either-way type, an organisation's own) empties the enum", async () => {
    const r = await review({ recommendedFormat: "SYMPOSIUM" });
    expect(await format(r.id)).toEqual({ recommendedFormat: "SYMPOSIUM", recommendedFormatLegacy: null });
    await db.abstractReviewSubmission.update({ where: { id: r.id }, data: { recommendedFormat: "ORAL_POSTER" } });
    expect(await format(r.id)).toEqual({ recommendedFormat: "ORAL_POSTER", recommendedFormatLegacy: null });
  });

  it("the old image's upsert, the shape the review service writes, keeps the two in step", async () => {
    const r = await review({ recommendedFormat: "ORAL" });
    const where = { abstractId_reviewerUserId: { abstractId: r.abstractId, reviewerUserId: userId } };
    await db.abstractReviewSubmission.upsert({ where, create: { abstractId: r.abstractId, reviewerUserId: userId }, update: { recommendedFormatLegacy: "POSTER" } });
    expect(await format(r.id)).toEqual({ recommendedFormat: "POSTER", recommendedFormatLegacy: "POSTER" });
  });
});

describe("the migration", () => {
  it("applies again on a database that already has it, and leaves every row as it was", async () => {
    const { id } = await abstract({ presentationType: "SYMPOSIUM", requestedPresentationTypeLegacy: "POSTER" });
    const before = await types(id);
    await applyMigration();
    expect(await types(id)).toEqual(before);
  });
});
