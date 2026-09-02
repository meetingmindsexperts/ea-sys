/**
 * RLS COVERAGE, does every table that needs a policy actually have one?
 *
 * This file exists because every other tenancy guard in the repo is a
 * CONFORMANCE check, and conformance cannot see an absence:
 *
 *   - rls-apply.test.ts pins the properties of the policies that EXIST (FOR ALL
 *     not FOR SELECT, no NULL escape on reads, always a WITH CHECK, one GUC
 *     name, never FORCE). Rigorous, and blind to a table with no policy at all.
 *   - check-tenant-als.sh pins that routes in a hand-listed set of swept
 *     directories take a lane, against a hand-maintained SWEPT_MODELS string.
 *   - check-tenant-scoping.sh / check-user-email-scope.sh /
 *     check-platform-operator.sh each police one rule inside a known set.
 *
 * All of them answer "is what we wrote correct". None answers "did we write it
 * at all". Nothing in CI reads schema.prisma, so a new model carrying
 * `organizationId` that never gets a prisma/rls/*.sql file is invisible.
 *
 * That is not hypothetical. The Aug 21 2026 audit found FOUR tables in exactly
 * that state: AbstractSubTheme, SpeakerProfileForm, AbstractSerialCounter and
 * SessionProposalSerialCounter. Each of them carried the column AND wrapped
 * its routes AND simply never got a policy file. Two of three steps done
 * correctly by people paying attention, and the third had nothing watching
 * it. That audit was a manual pass and was never turned into a gate, which is
 * what this file is.
 *
 * WHY THE PHYSICAL TABLE NAME MATTERS. A policy targets the table, not the
 * Prisma model, and the two differ wherever `@@map` is used. RsvpItem and
 * RsvpResponse are policied as RsvpDinner / RsvpDinnerResponse (renaming a live
 * table is not blue/green safe, so the model was renamed and the table was
 * not). A naive model-name comparison reports those two as gaps forever, and a
 * gate that cries wolf gets muted, which is worse than no gate.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { readPolicyFiles, sharedPolicyDir } from "../../prisma/rls/apply";

/**
 * Tables that carry `organizationId` and deliberately have NO policy.
 *
 * Every entry is a decision someone took and wrote down, not a way to silence
 * the check. Three tests below keep it honest: an entry naming a model that no
 * longer exists fails, an entry for a model that IS policied fails, and an
 * entry with no real reason fails. So the list can only shrink by accident,
 * never grow by one.
 *
 * The rule most of these share, from PLATFORM_DECISIONS.md: anything read
 * BEFORE identity is resolved cannot be protected by identity. There is no lane
 * yet in which to read the row that says which lane you are in.
 */
const DELIBERATELY_UNPOLICIED: Record<string, string> = {
  TenantDomain:
    "The tenant list itself. Read to LEARN which tenant a Host belongs to, before any lane exists.",
  User:
    "Identity, decision item 6. Enforced by a platform-only compound unique index " +
    "(prisma/platform/010-user-identity.sql), not a policy, because the row is read on the auth path.",
  Event:
    "Never one of the 20 swept domains: 343 call sites across 201 files. A policy would fail-close " +
    "the whole dashboard. Child tables carry their own denormalized organizationId and are policied " +
    "independently, so a readable Event row does not cascade. Recorded as a before-tenant-#2 item.",
  LoginEvent:
    "Security telemetry, recorded as deferred by its own sweep. Unknown-email attempts are org-null " +
    "by nature, so a strict policy would hide exactly the rows an attack shows up in.",
  ApiKey: "Read on the authentication path, which is what ESTABLISHES the lane. Lookup is by secret hash.",
  McpOAuthAuthCode: "Read on the authentication path, same class as ApiKey. Lookup is by secret hash.",
  McpOAuthAccessToken: "Read on the authentication path, same class as ApiKey. Lookup is by secret hash.",
};

interface ModelInfo {
  /** Prisma model name. */
  name: string;
  /** Physical table name, @@map when present, otherwise the model name. */
  table: string;
  /** Does the model declare an organizationId FIELD (not merely an @@index over one)? */
  hasOrgColumn: boolean;
}

function parseModels(): ModelInfo[] {
  const schema = readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8");
  return [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map(([, name, body]) => ({
    name,
    table: body.match(/@@map\("([^"]+)"\)/)?.[1] ?? name,
    // A FIELD declaration: the name at the start of a line, followed by its type.
    // `@@index([organizationId])` deliberately does not match, an index is not
    // a tenant key, and counting it would let an unkeyed table look covered.
    hasOrgColumn: /^\s*organizationId\s+\S/m.test(body),
  }));
}

function policiedTables(): Set<string> {
  const sql = readPolicyFiles([sharedPolicyDir()])
    .map((f) => f.statements.join(";\n"))
    .join(";\n");
  return new Set(
    [...sql.matchAll(/ALTER TABLE\s+"(\w+)"\s+ENABLE ROW LEVEL SECURITY/gi)].map((m) => m[1]),
  );
}

describe("RLS coverage", () => {
  const models = parseModels();
  const policied = policiedTables();

  it("parses a plausible schema and policy set", () => {
    // A guard whose parser silently matched nothing would pass every assertion
    // below while checking nothing at all. Pin both ends first.
    expect(models.length).toBeGreaterThan(50);
    expect(models.filter((m) => m.hasOrgColumn).length).toBeGreaterThan(50);
    expect(policied.size).toBeGreaterThan(50);
  });

  it("gives every org-bearing table a policy, or a written reason for having none", () => {
    const gaps = models
      .filter((m) => m.hasOrgColumn)
      .filter((m) => !policied.has(m.table))
      .filter((m) => !(m.name in DELIBERATELY_UNPOLICIED));

    expect(
      gaps.map((m) => m.name),
      "These models carry organizationId with no RLS policy. Add prisma/rls/<table>.sql " +
        "(copy an existing one, the shape is uniform), add the model to SWEPT_MODELS in " +
        "scripts/check-tenant-als.sh, and add an assertion to tests/tenancy/. If it is " +
        "deliberate, add it to DELIBERATELY_UNPOLICIED above WITH the reason.",
    ).toEqual([]);
  });

  it("keeps the allow-list free of models that no longer exist", () => {
    // A renamed or dropped model leaves a dead entry behind, and a dead entry
    // is how the next real gap gets excused by a line nobody re-read.
    const names = new Set(models.map((m) => m.name));
    const stale = Object.keys(DELIBERATELY_UNPOLICIED).filter((n) => !names.has(n));
    expect(stale, "DELIBERATELY_UNPOLICIED names models that are not in schema.prisma").toEqual([]);
  });

  it("keeps the allow-list free of models that ARE policied", () => {
    // The dangerous direction. An entry for a table that has since been
    // policied does nothing today, and silently excuses that table for good if
    // the policy is ever removed. The list must be exactly the exceptions.
    const redundant = Object.keys(DELIBERATELY_UNPOLICIED).filter((n) => {
      const m = models.find((x) => x.name === n);
      return m && policied.has(m.table);
    });
    expect(
      redundant,
      "These are policied and must be removed from DELIBERATELY_UNPOLICIED",
    ).toEqual([]);
  });

  it("makes every allow-list entry carry a real reason", () => {
    for (const [name, reason] of Object.entries(DELIBERATELY_UNPOLICIED)) {
      expect(reason.length, `${name}: the reason is too short to be a decision`).toBeGreaterThan(40);
    }
  });

  it("has no policy targeting a table the schema does not define", () => {
    // Dead SQL: a policy for a dropped table fails the platform bootstrap
    // half-way through, which is the expensive place to find out.
    const tables = new Set(models.map((m) => m.table));
    const orphaned = [...policied].filter((t) => !tables.has(t));
    expect(orphaned, "prisma/rls policies target tables not present in schema.prisma").toEqual([]);
  });
});
