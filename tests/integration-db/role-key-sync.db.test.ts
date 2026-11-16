/**
 * Role is stored as text, and the previous image still works (Nov 16, 2026;
 * docs/ORG_FIELDS_PLAN.md step 1b, option C), on a REAL Postgres.
 *
 * The Prisma field `role` is the new text column "roleKey"; `roleLegacy` is the
 * old enum column "role". The previous image knows only the old column, so a
 * write through `roleLegacy` here stands in for it. The trigger
 * `person_role_key_sync` keeps the two in step:
 *   - the old image writes the enum: the key follows;
 *   - this image writes the key: the enum follows when the key is one of the
 *     nine, else it is emptied (the old image reads no role and never fails);
 *   - both in one write: the key wins.
 *
 * This harness builds its database with `prisma db push`, which has the
 * columns but never the trigger, so the migration is applied here first, which
 * also proves it applies again on a database that already has the columns.
 *
 * Run: INTEGRATION_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/crm_test npm run test:integration-db
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { resetCrm } from "./helper";

const MIGRATION = join(process.cwd(), "prisma/migrations/20261116130000_role_key_text_column/migration.sql");

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
let counter = 0;

async function contact(data: { role?: string | null; roleLegacy?: "PHYSICIAN" | "PHARMA" | "STUDENT" | null }) {
  counter += 1;
  return db.contact.create({
    data: { organizationId: orgId, email: `role-${counter}@example.test`, firstName: "Rae", lastName: "Role", ...data },
    select: { id: true },
  });
}

const both = (id: string) =>
  db.contact.findUniqueOrThrow({ where: { id }, select: { role: true, roleLegacy: true } });

beforeAll(async () => {
  await applyMigration();
});

beforeEach(async () => {
  const seeded = await resetCrm();
  orgId = seeded.orgId;
  userId = seeded.userId;
});

describe("person_role_key_sync on Contact", () => {
  it("the old image writes the enum on create: the key follows", async () => {
    const { id } = await contact({ roleLegacy: "PHARMA" });
    expect(await both(id)).toEqual({ role: "PHARMA", roleLegacy: "PHARMA" });
  });

  it("this image writes one of the nine: the enum follows", async () => {
    const { id } = await contact({ role: "PHYSICIAN" });
    expect(await both(id)).toEqual({ role: "PHYSICIAN", roleLegacy: "PHYSICIAN" });
  });

  it("this image writes an organisation's own answer: the enum is emptied", async () => {
    const { id } = await contact({ role: "ENGINEER" });
    expect(await both(id)).toEqual({ role: "ENGINEER", roleLegacy: null });
  });

  it("the old image editing anything else leaves an organisation's own answer alone", async () => {
    const { id } = await contact({ role: "ENGINEER" });
    await db.contact.update({ where: { id }, data: { firstName: "Renamed" } });
    await db.contact.update({ where: { id }, data: { roleLegacy: null } });
    expect(await both(id)).toEqual({ role: "ENGINEER", roleLegacy: null });
  });

  it("the old image changing or clearing a role carries it into the key", async () => {
    const { id } = await contact({ role: "ENGINEER" });
    await db.contact.update({ where: { id }, data: { roleLegacy: "STUDENT" } });
    expect(await both(id)).toEqual({ role: "STUDENT", roleLegacy: "STUDENT" });
    await db.contact.update({ where: { id }, data: { roleLegacy: null } });
    expect(await both(id)).toEqual({ role: null, roleLegacy: null });
  });

  it("this image changing or clearing the key carries it into the enum", async () => {
    const { id } = await contact({ role: "PHYSICIAN" });
    await db.contact.update({ where: { id }, data: { role: "STUDENT" } });
    expect(await both(id)).toEqual({ role: "STUDENT", roleLegacy: "STUDENT" });
    await db.contact.update({ where: { id }, data: { role: null } });
    expect(await both(id)).toEqual({ role: null, roleLegacy: null });
  });

  it("a blank key is stored as no answer, as the enum column always did", async () => {
    const { id } = await contact({ role: "" });
    expect(await both(id)).toEqual({ role: null, roleLegacy: null });
    await db.contact.update({ where: { id }, data: { role: "PHYSICIAN" } });
    await db.contact.update({ where: { id }, data: { role: "   " } });
    expect(await both(id)).toEqual({ role: null, roleLegacy: null });
  });

  it("an ordinary read does not show the old column", async () => {
    const { id } = await contact({ role: "PHYSICIAN" });
    const row = await db.contact.findUniqueOrThrow({ where: { id } });
    expect(row).not.toHaveProperty("roleLegacy");
    expect(row.role).toBe("PHYSICIAN");
  });

  it("both in one write: the key wins", async () => {
    const { id } = await contact({ role: "PHYSICIAN" });
    await db.contact.update({ where: { id }, data: { role: "STUDENT", roleLegacy: "PHARMA" } });
    expect(await both(id)).toEqual({ role: "STUDENT", roleLegacy: "STUDENT" });
  });
});

describe("the trigger is on all four records", () => {
  it("Attendee, Speaker and AccountProfile copy an old-image role into the key", async () => {
    const event = await db.event.create({
      data: { organizationId: orgId, name: "Role Test", slug: `role-test-${counter}`, startDate: new Date("2027-01-15"), endDate: new Date("2027-01-17") },
      select: { id: true },
    });
    const attendee = await db.attendee.create({
      data: { organizationId: orgId, email: "att@example.test", firstName: "A", lastName: "T", roleLegacy: "STUDENT" },
      select: { role: true },
    });
    const speaker = await db.speaker.create({
      data: { organizationId: orgId, eventId: event.id, email: "spk@example.test", firstName: "S", lastName: "P", roleLegacy: "PHARMA" },
      select: { role: true },
    });
    const profile = await db.accountProfile.create({
      data: { userId, roleLegacy: "PHYSICIAN" },
      select: { role: true },
    });
    expect([attendee.role, speaker.role, profile.role]).toEqual(["STUDENT", "PHARMA", "PHYSICIAN"]);
  });

  it("an organisation's own answer empties the enum on each of them", async () => {
    const event = await db.event.create({
      data: { organizationId: orgId, name: "Role Test", slug: `role-test-own-${counter}`, startDate: new Date("2027-01-15"), endDate: new Date("2027-01-17") },
      select: { id: true },
    });
    const attendee = await db.attendee.create({
      data: { organizationId: orgId, email: "att2@example.test", firstName: "A", lastName: "T", role: "DEVELOPER" },
      select: { roleLegacy: true },
    });
    const speaker = await db.speaker.create({
      data: { organizationId: orgId, eventId: event.id, email: "spk2@example.test", firstName: "S", lastName: "P", role: "DEVELOPER" },
      select: { roleLegacy: true },
    });
    const profile = await db.accountProfile.create({ data: { userId, role: "DEVELOPER" }, select: { roleLegacy: true } });
    expect([attendee.roleLegacy, speaker.roleLegacy, profile.roleLegacy]).toEqual([null, null, null]);
  });
});

describe("the backfill", () => {
  it("fills the key of a row written before the trigger existed, and a re-run changes nothing", async () => {
    await db.$executeRawUnsafe(`ALTER TABLE "Contact" DISABLE TRIGGER person_role_key_sync`);
    let id = "";
    try {
      ({ id } = await contact({ roleLegacy: "PHARMA" }));
      expect(await both(id)).toEqual({ role: null, roleLegacy: "PHARMA" });
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE "Contact" ENABLE TRIGGER person_role_key_sync`);
    }
    await applyMigration();
    expect(await both(id)).toEqual({ role: "PHARMA", roleLegacy: "PHARMA" });
    await applyMigration();
    expect(await both(id)).toEqual({ role: "PHARMA", roleLegacy: "PHARMA" });
  });
});
