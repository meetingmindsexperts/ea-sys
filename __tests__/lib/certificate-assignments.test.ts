/**
 * THE rule for who receives a certificate (src/lib/certificates/assignments.ts,
 * Nov 11, 2026): the pure routing, and the two readers every door shares.
 * The writes and the lock are proven on a real Postgres in
 * tests/integration-db/certificate-assignments.db.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import {
  CERTIFICATE_ASSIGNMENT_SOURCES,
  CERTIFICATE_ASSIGNMENT_SOURCE_LABELS,
  LIVE_ASSIGNMENT_WHERE,
  assignedRegistrationWhere,
  assignedSpeakerWhere,
  assignmentSourceLabel,
  certificateAssignmentLockKey,
  countAssignmentsByTemplate,
  loadAssignedTemplateIds,
  recipientKindFor,
  selectAssignedTargets,
} from "@/lib/certificates/assignments";

const ATT = { id: "tpl_att", category: "ATTENDANCE" as const };
const APP = { id: "tpl_app", category: "APPRECIATION" as const };
const set = (...ids: string[]) => new Set(ids);

describe("selectAssignedTargets", () => {
  it("an attendance template assigned to the registration goes to the registration", () => {
    expect(selectAssignedTargets([ATT], set("tpl_att"), null)).toEqual([
      { templateId: "tpl_att", category: "ATTENDANCE", recipient: "registration" },
    ]);
  });

  it("an appreciation template assigned to the speaker goes to the speaker", () => {
    expect(selectAssignedTargets([APP], set(), set("tpl_app"))).toEqual([
      { templateId: "tpl_app", category: "APPRECIATION", recipient: "speaker" },
    ]);
  });

  it("an appreciation template never matches a person with no speaker record", () => {
    expect(selectAssignedTargets([APP], set("tpl_app"), null)).toEqual([]);
  });

  it("each category only reads its own facet: the other facet's assignment does not count", () => {
    // Attendance assigned on the speaker facet, appreciation on the registration facet.
    expect(selectAssignedTargets([ATT, APP], set("tpl_app"), set("tpl_att"))).toEqual([]);
  });

  it("a person who is both gets both, each routed to its own facet, in template order", () => {
    expect(selectAssignedTargets([ATT, APP], set("tpl_att"), set("tpl_app"))).toEqual([
      { templateId: "tpl_att", category: "ATTENDANCE", recipient: "registration" },
      { templateId: "tpl_app", category: "APPRECIATION", recipient: "speaker" },
    ]);
  });

  it("a template nobody was assigned matches nobody: there is no 'everyone' case", () => {
    expect(selectAssignedTargets([ATT, APP], set(), set())).toEqual([]);
    expect(selectAssignedTargets([ATT], set("some_other_template"), null)).toEqual([]);
  });

  it("no templates, no targets", () => {
    expect(selectAssignedTargets([], set("tpl_att"), set("tpl_app"))).toEqual([]);
  });
});

describe("loadAssignedTemplateIds", () => {
  const client = (rows: unknown[]) => {
    const findMany = vi.fn().mockResolvedValue(rows);
    return { findMany, client: { certificateAssignment: { findMany } } as never };
  };

  it("asks once, for these templates and this person's facets only", async () => {
    const { findMany, client: c } = client([]);
    await loadAssignedTemplateIds(c, { templateIds: ["t1", "t2"], registrationId: "reg", speakerId: "spk" });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({
      certificateTemplateId: { in: ["t1", "t2"] },
      OR: [{ registrationId: "reg" }, { speakerId: "spk" }],
    });
  });

  it("splits the rows by facet, and reports no speaker facet as null", async () => {
    const both = client([
      { certificateTemplateId: "t1", registrationId: "reg", speakerId: null },
      { certificateTemplateId: "t2", registrationId: null, speakerId: "spk" },
    ]);
    const res = await loadAssignedTemplateIds(both.client, { templateIds: ["t1", "t2"], registrationId: "reg", speakerId: "spk" });
    expect([...res.registration]).toEqual(["t1"]);
    expect([...(res.speaker ?? [])]).toEqual(["t2"]);

    const regOnly = client([{ certificateTemplateId: "t1", registrationId: "reg", speakerId: null }]);
    const res2 = await loadAssignedTemplateIds(regOnly.client, { templateIds: ["t1"], registrationId: "reg", speakerId: null });
    expect(res2.speaker).toBeNull();
    expect(regOnly.findMany.mock.calls[0][0].where.OR).toEqual([{ registrationId: "reg" }]);
  });

  it("a row for somebody else is ignored even if the query returned it", async () => {
    const { client: c } = client([
      { certificateTemplateId: "t1", registrationId: "someone-else", speakerId: null },
      { certificateTemplateId: "t2", registrationId: null, speakerId: "another-speaker" },
    ]);
    const res = await loadAssignedTemplateIds(c, { templateIds: ["t1", "t2"], registrationId: "reg", speakerId: "spk" });
    expect(res.registration.size).toBe(0);
    expect(res.speaker?.size).toBe(0);
  });

  it("does not query at all with no templates or no person", async () => {
    const none = client([]);
    expect((await loadAssignedTemplateIds(none.client, { templateIds: [], registrationId: "reg", speakerId: null })).registration.size).toBe(0);
    expect((await loadAssignedTemplateIds(none.client, { templateIds: ["t1"], registrationId: null, speakerId: null })).speaker).toBeNull();
    expect(none.findMany).not.toHaveBeenCalled();
  });
});

describe("countAssignmentsByTemplate", () => {
  it("counts live assignments only and reports 0 for a template with none", async () => {
    const groupBy = vi.fn().mockResolvedValue([{ certificateTemplateId: "t1", _count: { _all: 4 } }]);
    const counts = await countAssignmentsByTemplate({ certificateAssignment: { groupBy } } as never, ["t1", "t2"]);
    expect(counts.get("t1")).toBe(4);
    expect(counts.get("t2")).toBe(0);
    expect(groupBy.mock.calls[0][0].where).toEqual({ certificateTemplateId: { in: ["t1", "t2"] }, ...LIVE_ASSIGNMENT_WHERE });
  });

  it("does not query for no templates", async () => {
    const groupBy = vi.fn();
    expect((await countAssignmentsByTemplate({ certificateAssignment: { groupBy } } as never, [])).size).toBe(0);
    expect(groupBy).not.toHaveBeenCalled();
  });
});

describe("the pool filters", () => {
  it("a registration pool is the assigned registrations that are not cancelled", () => {
    expect(assignedRegistrationWhere("t1")).toEqual({
      status: { not: "CANCELLED" },
      certificateAssignments: { some: { certificateTemplateId: "t1" } },
    });
  });

  it("a speaker pool is the assigned speakers", () => {
    expect(assignedSpeakerWhere("t1")).toEqual({ certificateAssignments: { some: { certificateTemplateId: "t1" } } });
  });

  it("a live assignment is a speaker's, or a registration's that is not cancelled", () => {
    expect(LIVE_ASSIGNMENT_WHERE).toEqual({
      OR: [{ speakerId: { not: null } }, { registration: { status: { not: "CANCELLED" } } }],
    });
  });
});

describe("the small things", () => {
  it("each category has one facet", () => {
    expect(recipientKindFor("ATTENDANCE")).toBe("registration");
    expect(recipientKindFor("APPRECIATION")).toBe("speaker");
  });

  it("every source has a plain label, and an unknown one shows as stored", () => {
    for (const source of CERTIFICATE_ASSIGNMENT_SOURCES) {
      expect(CERTIFICATE_ASSIGNMENT_SOURCE_LABELS[source].length).toBeGreaterThan(3);
      expect(assignmentSourceLabel(source)).toBe(CERTIFICATE_ASSIGNMENT_SOURCE_LABELS[source]);
    }
    expect(assignmentSourceLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });

  it("the lock is per event", () => {
    expect(certificateAssignmentLockKey("evt_1")).toBe("certificate-assignment:evt_1");
    expect(certificateAssignmentLockKey("evt_1")).not.toBe(certificateAssignmentLockKey("evt_2"));
  });
});

// ── The migration, its catch-up script, and the retired tag ──────────────────

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { BACKFILL_MIGRATION, readBackfillStatements } from "../../scripts/backfill-certificate-assignments";

describe("the backfill", () => {
  const sql = readFileSync(path.resolve(process.cwd(), BACKFILL_MIGRATION), "utf8");

  it("the catch-up script runs the migration's own statements: four idempotent inserts", () => {
    const statements = readBackfillStatements(sql);
    expect(statements).toHaveLength(4);
    for (const statement of statements) {
      expect(statement.startsWith('INSERT INTO "CertificateAssignment"')).toBe(true);
      expect(statement.endsWith("ON CONFLICT DO NOTHING")).toBe(true);
    }
    // Two from the tag (registrations, speakers), two from certificates already held.
    expect(statements.filter((s) => s.includes("'TAG_BACKFILL'"))).toHaveLength(2);
    expect(statements.filter((s) => s.includes("'ISSUED_BACKFILL'"))).toHaveLength(2);
  });

  it("the migration is additive: it creates, and never drops, renames or rewrites", () => {
    const executable = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    expect(executable).toContain('CREATE TABLE IF NOT EXISTS "CertificateAssignment"');
    // (ON DELETE / ON UPDATE inside a foreign key are not statements.)
    expect(executable).not.toMatch(/^\s*(DROP|UPDATE|DELETE|TRUNCATE)\b/m);
    expect(executable).not.toMatch(/\bDROP (TABLE|COLUMN|INDEX|CONSTRAINT)\b|\bRENAME\b|ALTER COLUMN|SET NOT NULL/);
    // It never touches the registrations the survey sweep has already looked
    // at, so applying it cannot send anyone a certificate.
    expect(executable).not.toContain("certAutoIssueCheckedAt");
  });

  it("refuses a file without the markers", () => {
    expect(() => readBackfillStatements("CREATE TABLE x ();")).toThrow(/BACKFILL markers/);
  });
});

describe("the tag is retired", () => {
  const SRC = path.resolve(process.cwd(), "src");
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name)) files.push(full);
    }
  })(SRC);

  /** Source with comments stripped: a comment may explain the retired column, code may not use it. */
  const code = (file: string) =>
    readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  it("no code under src reads or writes CertificateTemplate.autoIssueTag", () => {
    const users = files.filter((f) => code(f).includes("autoIssueTag")).map((f) => path.relative(process.cwd(), f));
    expect(
      users,
      "autoIssueTag is unread since Nov 11, 2026: who receives a certificate is CertificateAssignment (src/lib/certificates/assignments.ts)",
    ).toEqual([]);
  });

  it("no certificate code decides recipients from a person's tags", () => {
    const certDir = path.join(SRC, "lib", "certificates");
    const offenders = files
      .filter((f) => f.startsWith(certDir))
      .filter((f) => /\b(attendeeTags|speakerTags|tags\.includes|tags:\s*true)\b/.test(code(f)))
      .map((f) => path.relative(process.cwd(), f));
    expect(offenders).toEqual([]);
  });
});
