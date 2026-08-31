/**
 * HR module (born tenancy-compliant, Aug 27 2026): the policies from
 * prisma/rls/{employee,leavecode,attendanceentry,attendancerule,leavegrant,publicholiday}.sql
 * — the SAME files the platform bootstrap applies — enforced end to end through
 * the ALS store, the SET LOCAL extension and pgbouncer, as the non-owner
 * app_user.
 *
 * WHY POLICY A MASTER-ONLY MODULE AT ALL. Availability and tenancy are separate
 * questions (docs/HR_MODULE_PLAN.md §2a). HR is gated OFF on the platform by
 * HR_MODULE_ENABLED, but the tables ship in the shared migration chain so they
 * EXIST there regardless, and an existing unpoliced table is a latent hole the
 * day somebody flips the flag. This suite is what proves the backstop is real
 * rather than merely present.
 *
 * Domain-specific proofs:
 *   - `empCode` is unique per ORG, not globally, so BOTH orgs deliberately hold
 *     an employee on the SAME code. An unscoped read by empCode resolving to the
 *     caller's own row is what proves scoping; a count of one would also pass if
 *     the two lanes were swapped, so these assert IDENTITY (the Aug-12 lesson).
 *   - AttendanceEntry is a 2-hop child, and it is read through its own flat
 *     organizationId, so a cross-tenant read addressed by employeeId must miss.
 *   - Writes are tested in both directions: WITH CHECK must refuse smuggling a
 *     foreign org onto a create, and must refuse re-homing an existing row.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { ORG_A_ID, ORG_B_ID } from "./constants";

const EMP_A_ID = "tenancy-hr-emp-a";
const EMP_B_ID = "tenancy-hr-emp-b";
const CODE_A_ID = "tenancy-hr-lc-a";
const CODE_B_ID = "tenancy-hr-lc-b";
const ENTRY_A_ID = "tenancy-hr-ae-a";
const ENTRY_B_ID = "tenancy-hr-ae-b";
const HOL_A_ID = "tenancy-hr-ph-a";
const HOL_B_ID = "tenancy-hr-ph-b";
const RULE_A_ID = "tenancy-hr-rule-a";
const RULE_B_ID = "tenancy-hr-rule-b";

/** Both orgs use this employee code. Scoping is what keeps them apart. */
const SHARED_EMP_CODE = "EMP001";
/** Both orgs use this leave code, which is the whole point of a per-org catalogue. */
const SHARED_LEAVE_CODE = "AL";
const DAY = new Date("2026-03-02T00:00:00.000Z");
const HOLIDAY = new Date("2026-12-02T00:00:00.000Z");

let owner: PrismaClient;

beforeAll(async () => {
  process.env.RLS_SET_LOCAL = "1";
  const url = process.env.TENANCY_DIRECT_URL;
  if (!url) throw new Error("TENANCY_DIRECT_URL (owner, raw :5432) is required to seed fixtures");
  owner = new PrismaClient({ datasources: { db: { url } } });
  await cleanup();

  await owner.employee.createMany({
    data: [
      { id: EMP_A_ID, organizationId: ORG_A_ID, empCode: SHARED_EMP_CODE, name: "Alice in A", joiningDate: new Date("2020-01-01T00:00:00.000Z") },
      { id: EMP_B_ID, organizationId: ORG_B_ID, empCode: SHARED_EMP_CODE, name: "Bob in B", joiningDate: new Date("2020-01-01T00:00:00.000Z") },
    ],
  });
  await owner.leaveCode.createMany({
    data: [
      { id: CODE_A_ID, organizationId: ORG_A_ID, code: SHARED_LEAVE_CODE, label: "Annual Leave", paid: true, dayWeight: 1, countsAs: "ANNUAL" },
      { id: CODE_B_ID, organizationId: ORG_B_ID, code: SHARED_LEAVE_CODE, label: "Annual Leave", paid: true, dayWeight: 1, countsAs: "ANNUAL" },
    ],
  });
  await owner.attendanceEntry.createMany({
    data: [
      { id: ENTRY_A_ID, organizationId: ORG_A_ID, employeeId: EMP_A_ID, date: DAY, leaveCodeId: CODE_A_ID },
      { id: ENTRY_B_ID, organizationId: ORG_B_ID, employeeId: EMP_B_ID, date: DAY, leaveCodeId: CODE_B_ID },
    ],
  });
  // Both orgs hold an ORG-scoped rule over the SAME dates. A rule is what the
  // grid and the balance engine derive from, so one leaking across a lane would
  // put another tenant's company shutdown into this tenant's payroll figures.
  await owner.attendanceRule.createMany({
    data: [
      { id: RULE_A_ID, organizationId: ORG_A_ID, scope: "ORG", leaveCodeId: CODE_A_ID, startDate: DAY, endDate: DAY, label: "Everyone remote (A)", updatedAt: DAY },
      { id: RULE_B_ID, organizationId: ORG_B_ID, scope: "ORG", leaveCodeId: CODE_B_ID, startDate: DAY, endDate: DAY, label: "Everyone remote (B)", updatedAt: DAY },
    ],
  });
  await owner.publicHoliday.createMany({
    data: [
      { id: HOL_A_ID, organizationId: ORG_A_ID, date: HOLIDAY, label: "National Day (A)" },
      { id: HOL_B_ID, organizationId: ORG_B_ID, date: HOLIDAY, label: "National Day (B)" },
    ],
  });
});

async function cleanup() {
  await owner?.attendanceRule.deleteMany({ where: { id: { in: [RULE_A_ID, RULE_B_ID] } } });
  await owner?.attendanceEntry.deleteMany({ where: { id: { in: [ENTRY_A_ID, ENTRY_B_ID] } } });
  await owner?.leaveGrant.deleteMany({ where: { employeeId: { in: [EMP_A_ID, EMP_B_ID] } } });
  await owner?.publicHoliday.deleteMany({ where: { id: { in: [HOL_A_ID, HOL_B_ID] } } });
  await owner?.leaveCode.deleteMany({ where: { id: { in: [CODE_A_ID, CODE_B_ID] } } });
  await owner?.employee.deleteMany({ where: { id: { in: [EMP_A_ID, EMP_B_ID] } } });
}

afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await cleanup();
  await owner?.$disconnect();
  await db.$disconnect();
});

describe("HR RLS via the SET LOCAL extension", () => {
  /**
   * Identity, not count. Two lanes each holding one row also passes a count
   * assertion when the lanes are SWAPPED, which is exactly the mis-routing an
   * isolation suite exists to catch.
   */
  it("lane-scoped: the SHARED employee code resolves to each lane's own row", async () => {
    const inA = await runWithTenant(ORG_A_ID, () =>
      db.employee.findFirst({ where: { empCode: SHARED_EMP_CODE } }),
    );
    const inB = await runWithTenant(ORG_B_ID, () =>
      db.employee.findFirst({ where: { empCode: SHARED_EMP_CODE } }),
    );
    expect(inA?.id).toBe(EMP_A_ID);
    expect(inB?.id).toBe(EMP_B_ID);
  });

  it("cross-tenant miss: B's employee is invisible from A's lane, even by id", async () => {
    const row = await runWithTenant(ORG_A_ID, () =>
      db.employee.findUnique({ where: { id: EMP_B_ID } }),
    );
    expect(row).toBeNull();
  });

  it("lane-scoped: the shared leave code resolves per org", async () => {
    const a = await runWithTenant(ORG_A_ID, () =>
      db.leaveCode.findFirst({ where: { code: SHARED_LEAVE_CODE } }),
    );
    const b = await runWithTenant(ORG_B_ID, () =>
      db.leaveCode.findFirst({ where: { code: SHARED_LEAVE_CODE } }),
    );
    expect(a?.id).toBe(CODE_A_ID);
    expect(b?.id).toBe(CODE_B_ID);
  });

  /** The 2-hop child, read through its own flat organizationId. */
  it("cross-tenant miss: B's attendance is invisible from A's lane, even by employeeId", async () => {
    const rows = await runWithTenant(ORG_A_ID, () =>
      db.attendanceEntry.findMany({ where: { employeeId: EMP_B_ID } }),
    );
    expect(rows).toHaveLength(0);
  });

  it("lane-scoped: a holiday on the same date resolves to each lane's own label", async () => {
    const a = await runWithTenant(ORG_A_ID, () =>
      db.publicHoliday.findFirst({ where: { date: HOLIDAY } }),
    );
    const b = await runWithTenant(ORG_B_ID, () =>
      db.publicHoliday.findFirst({ where: { date: HOLIDAY } }),
    );
    expect(a?.label).toBe("National Day (A)");
    expect(b?.label).toBe("National Day (B)");
  });

  /**
   * Fail CLOSED. `current_setting(..., true)` returns NULL when the GUC is
   * unset, so no tenant context means no rows rather than every row.
   */
  it("fails closed across all five tables with no tenant store", async () => {
    expect(await db.employee.findMany({ where: { empCode: SHARED_EMP_CODE } })).toHaveLength(0);
    expect(await db.leaveCode.findMany({ where: { code: SHARED_LEAVE_CODE } })).toHaveLength(0);
    expect(await db.attendanceEntry.findMany({ where: { date: DAY } })).toHaveLength(0);
    expect(await db.publicHoliday.findMany({ where: { date: HOLIDAY } })).toHaveLength(0);
    expect(await db.leaveGrant.findMany({})).toHaveLength(0);
  });

  it("WITH CHECK refuses smuggling a foreign org onto a create", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.leaveGrant.create({
          data: {
            organizationId: ORG_B_ID,
            employeeId: EMP_B_ID,
            leaveYear: 2026,
            entitlementDays: 30,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  /**
   * The one write a compound-where cannot catch: an UPDATE that moves a row the
   * caller legitimately owns into another tenant.
   */
  it("WITH CHECK refuses re-homing an owned row to another org", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.employee.update({
          where: { id: EMP_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow();
  });

  it("cross-tenant DELETE affects nothing", async () => {
    const res = await runWithTenant(ORG_A_ID, () =>
      db.employee.deleteMany({ where: { id: EMP_B_ID } }),
    );
    expect(res.count).toBe(0);
    const stillThere = await owner.employee.findUnique({ where: { id: EMP_B_ID } });
    expect(stillThere).not.toBeNull();
  });

  it("lane-scoped: an org-wide RULE resolves to each lane's own row", async () => {
    const [a, b] = [
      await runWithTenant(ORG_A_ID, () => db.attendanceRule.findFirst({ where: { scope: "ORG" } })),
      await runWithTenant(ORG_B_ID, () => db.attendanceRule.findFirst({ where: { scope: "ORG" } })),
    ];
    expect(a?.id).toBe(RULE_A_ID);
    expect(b?.id).toBe(RULE_B_ID);
  });

  it("cross-tenant miss: B's rule is invisible from A's lane, even by id", async () => {
    const found = await runWithTenant(ORG_A_ID, () =>
      db.attendanceRule.findUnique({ where: { id: RULE_B_ID } }),
    );
    expect(found).toBeNull();
  });

  it("fails closed: with no lane, no rule is visible at all", async () => {
    const rows = await db.attendanceRule.findMany({
      where: { id: { in: [RULE_A_ID, RULE_B_ID] } },
    });
    expect(rows).toHaveLength(0);
  });

  it("WITH CHECK blocks re-homing a rule into another tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.attendanceRule.update({
          where: { id: RULE_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow();
  });

  it("cross-tenant DELETE cannot reach B's rule from A's lane", async () => {
    const res = await runWithTenant(ORG_A_ID, () =>
      db.attendanceRule.deleteMany({ where: { id: RULE_B_ID } }),
    );
    expect(res.count).toBe(0);
  });
});
