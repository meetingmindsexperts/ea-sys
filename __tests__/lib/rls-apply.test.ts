/**
 * The shared RLS policy applier.
 *
 * This module is the single path by which BOTH the isolation harness and the
 * platform bootstrap apply prisma/rls/*.sql. Its statement splitter is the part
 * worth pinning: several policy files wrap idempotency guards in `DO $$ … $$`
 * blocks whose bodies contain semicolons, and a splitter that does not track
 * the dollar-quoting cuts those in half. The resulting error points at a
 * fragment rather than at the real problem, which is exactly the kind of thing
 * that eats an afternoon during a provisioning run.
 *
 * The last test in this file is the useful one operationally: it parses the
 * REAL policy directory, so a malformed .sql file fails here rather than
 * half-way through a bootstrap against a live database.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { splitSql, readPolicyFiles, sharedPolicyDir } from "../../prisma/rls/apply";

describe("splitSql", () => {
  it("splits on top-level semicolons", () => {
    expect(splitSql("SELECT 1; SELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("keeps a trailing statement that has no semicolon", () => {
    // Policy files routinely end without one. Dropping it would silently skip
    // the last CREATE POLICY in a file, which is a leak, not an error.
    expect(splitSql("SELECT 1;\nSELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("keeps a DO $$ … $$ block intact despite its internal semicolons", () => {
    const sql = `
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'x') THEN
          CREATE ROLE x;
        END IF;
      END $$;
      GRANT USAGE ON SCHEMA public TO x;
    `;
    const out = splitSql(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("CREATE ROLE x;");
    expect(out[0]).toContain("END IF;");
    expect(out[1]).toBe("GRANT USAGE ON SCHEMA public TO x");
  });

  it("strips whole-line comments but not inline text", () => {
    const out = splitSql("-- a comment\nSELECT 1;\n  -- indented comment\nSELECT 2;");
    expect(out).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("produces no empty statements from blank lines or stray semicolons", () => {
    // An empty string reaching $executeRawUnsafe is a syntax error at apply
    // time, i.e. a provisioning failure caused by formatting.
    const out = splitSql("\n\nSELECT 1;;\n\n;\n");
    expect(out).toEqual(["SELECT 1"]);
    expect(out.every((s) => s.trim().length > 0)).toBe(true);
  });

  it("returns nothing for a comment-only file", () => {
    expect(splitSql("-- documentation only\n-- no statements\n")).toEqual([]);
  });
});

describe("readPolicyFiles", () => {
  it("reads .sql files in filename order and ignores anything else", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rls-test-"));
    try {
      writeFileSync(path.join(dir, "b.sql"), "SELECT 2;");
      writeFileSync(path.join(dir, "a.sql"), "SELECT 1;");
      // apply.ts itself lives in prisma/rls/, so non-.sql must be skipped.
      writeFileSync(path.join(dir, "apply.ts"), "export const x = 1;");

      const files = readPolicyFiles([dir]);
      expect(files.map((f) => f.file)).toEqual(["a.sql", "b.sql"]);
      expect(files[0].statements).toEqual(["SELECT 1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the broken contract when a policy directory is missing", () => {
    // Git does not track empty directories, so this is reachable by deleting
    // the last .sql file. A raw ENOENT would read as broken tooling.
    expect(() => readPolicyFiles(["/nonexistent/rls/dir"])).toThrow(/load-bearing/);
  });
});

describe("the real prisma/rls directory", () => {
  const files = readPolicyFiles([sharedPolicyDir()]);

  it("parses every committed policy file", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f.statements.length, `${f.file} produced no statements`).toBeGreaterThan(0);
      for (const s of f.statements) {
        expect(s.trim().length, `${f.file} produced an empty statement`).toBeGreaterThan(0);
      }
    }
  });

  it("gives every policied table both ENABLE and a CREATE POLICY", () => {
    // ENABLE without a policy is default-DENY: the table returns zero rows for
    // everyone and the app looks broken rather than insecure. A CREATE POLICY
    // without ENABLE is the opposite and far worse — the policy exists, reads
    // as protection in review, and enforces nothing.
    for (const f of files) {
      const sql = f.statements.join(";");
      const enables = /ENABLE ROW LEVEL SECURITY/i.test(sql);
      const policies = /CREATE POLICY/i.test(sql);
      expect(enables, `${f.file}: has CREATE POLICY but no ENABLE`).toBe(policies);
    }
  });

  it("never adds FORCE ROW LEVEL SECURITY", () => {
    // FORCE binds the OWNER too, which breaks owner-side provisioning (db push,
    // seeds, migrations) on any database where the file was already applied.
    // Enforcement is meant to come from connecting as a non-owner role.
    for (const f of files) {
      expect(/FORCE ROW LEVEL SECURITY/i.test(f.statements.join(";")), f.file).toBe(false);
    }
  });
});

/**
 * Policy conformance.
 *
 * 74 of the 77 policies are byte-identical to one template, which means they
 * were copy-pasted, which means they can drift. The tests above catch a missing
 * ENABLE and a stray FORCE. They do NOT catch the failure that matters most: a
 * block where someone narrowed `FOR ALL` to `FOR SELECT`, or dropped the
 * WITH CHECK, or fat-fingered the GUC name. Each of those still reads as
 * protection in review and enforces less than it appears to.
 *
 * So these pin the PROPERTIES rather than the text. The load-bearing one is
 * that USING is never NULL-permissive: USING governs reads, and a NULL escape
 * there would expose every org-less row to every tenant.
 */
describe("policy conformance", () => {
  const STRICT = `"organizationId" = current_setting('app.current_org', true)`;
  /** Permits INSERTing a row with no org. Read access stays strict regardless. */
  const NULL_PERMISSIVE = `"organizationId" IS NULL OR "organizationId" = current_setting('app.current_org', true)`;

  /**
   * The ONLY tables allowed a NULL-permissive WITH CHECK, and why: each
   * legitimately stores rows with no owning org (an auth email to an org-null
   * account, an audit row from an org-null actor, a help query from a reviewer
   * or submitter). Prisma's create() emits INSERT..RETURNING, so a strict
   * WITH CHECK rejects those writes and the row is silently lost. See
   * docs/PLATFORM_DECISIONS.md §3.
   *
   * A FOURTH table appearing here should be a decision, not a copy-paste.
   */
  const NULL_WRITE_ALLOWED = new Set(["AuditLog", "EmailLog", "HelpChatQuery"]);

  interface Policy {
    file: string;
    table: string;
    name: string;
    body: string;
  }

  const policies: Policy[] = readPolicyFiles([sharedPolicyDir()]).flatMap((f) =>
    [...f.statements.join(";\n").matchAll(/CREATE POLICY\s+(\w+)\s+ON\s+"(\w+)"([\s\S]*?)(?=;|$)/g)].map(
      (m) => ({
        file: f.file,
        name: m[1],
        table: m[2],
        body: m[3].replace(/\s+/g, " ").trim(),
      }),
    ),
  );

  it("found every policy in the directory", () => {
    // Guards the parser itself: a regex that silently matched nothing would
    // make every assertion below vacuously true.
    expect(policies.length).toBeGreaterThan(70);
  });

  it("applies to ALL commands, never just SELECT", () => {
    // FOR SELECT leaves INSERT/UPDATE/DELETE unenforced, so a tenant could
    // write rows into another tenant while reads look correctly isolated.
    for (const p of policies) {
      expect(p.body, `${p.file}: ${p.table}`).toMatch(/^FOR ALL TO PUBLIC\b/);
    }
  });

  it("guards reads strictly, with no NULL escape, on every table", () => {
    // The load-bearing one. USING governs what a lane can READ.
    for (const p of policies) {
      const using = p.body.match(/USING \((.*?)\) WITH CHECK/)?.[1]?.trim();
      expect(using, `${p.file}: ${p.table} has no parseable USING`).toBeTruthy();
      expect(using, `${p.file}: ${p.table} USING is not the strict predicate`).toBe(STRICT);
    }
  });

  it("always has a WITH CHECK", () => {
    // Without it, writes are unenforced entirely.
    for (const p of policies) {
      expect(p.body, `${p.file}: ${p.table}`).toContain("WITH CHECK");
    }
  });

  it("permits NULL-org writes only on the three tables that need it", () => {
    for (const p of policies) {
      const check = p.body.match(/WITH CHECK \(([\s\S]*)\)$/)?.[1]?.trim();
      expect(check, `${p.file}: ${p.table} has no parseable WITH CHECK`).toBeTruthy();

      if (check === STRICT) continue;

      expect(check, `${p.file}: ${p.table} WITH CHECK is neither shape`).toBe(NULL_PERMISSIVE);
      expect(
        NULL_WRITE_ALLOWED.has(p.table),
        `${p.file}: ${p.table} permits NULL-org writes but is not one of the three ` +
          `tables justified for it. If that is deliberate, add it to NULL_WRITE_ALLOWED ` +
          `with the reason.`,
      ).toBe(true);
    }
  });

  it("reads the tenant from one GUC name everywhere", () => {
    // A typo'd GUC never resolves, so the policy fail-closes to zero rows
    // forever and the symptom is an empty page rather than an error.
    for (const p of policies) {
      const gucs = [...p.body.matchAll(/current_setting\('([^']+)'/g)].map((m) => m[1]);
      expect(gucs.length, `${p.file}: ${p.table}`).toBeGreaterThan(0);
      for (const g of gucs) expect(g, `${p.file}: ${p.table}`).toBe("app.current_org");
    }
  });

  it("names each policy after its table", () => {
    for (const p of policies) {
      expect(p.name, `${p.file}: ${p.table}`).toBe(`${p.table.toLowerCase()}_tenant_isolation`);
    }
  });
});
