/**
 * Purchasing document numbers on a REAL Postgres: twenty concurrent creates in
 * one organisation get twenty distinct, gap-free numbers, the two sequences
 * are independent, a second organisation starts at 0001, and a new year
 * starts at 0001. A mocked Prisma cannot show any of this: the guarantee is
 * the row lock the upsert takes.
 *
 * Run: docker compose --profile crm-test up -d
 *      INTEGRATION_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/crm_test npm run test:integration-db
 */
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { nextDocumentNumber } from "@/procurement/lib/document-numbers";
import { resetCrm } from "./helper";

let orgId: string;

beforeEach(async () => {
  ({ orgId } = await resetCrm());
});

describe("nextDocumentNumber", () => {
  it("hands twenty concurrent creates twenty distinct gap-free numbers", async () => {
    const at = new Date("2026-05-01T08:00:00.000Z");
    const numbers = await Promise.all(
      Array.from({ length: 20 }, () => db.$transaction((tx) => nextDocumentNumber(tx, "PO", orgId, at))),
    );
    expect(new Set(numbers).size).toBe(20);
    expect([...numbers].sort()).toEqual(Array.from({ length: 20 }, (_, i) => `PO-2026-${String(i + 1).padStart(4, "0")}`));
  });

  it("keeps the two sequences, two organisations and two years apart", async () => {
    const at = new Date("2026-05-01T08:00:00.000Z");
    expect(await db.$transaction((tx) => nextDocumentNumber(tx, "PR", orgId, at))).toBe("PR-2026-0001");
    expect(await db.$transaction((tx) => nextDocumentNumber(tx, "PO", orgId, at))).toBe("PO-2026-0001");
    expect(await db.$transaction((tx) => nextDocumentNumber(tx, "PR", orgId, at))).toBe("PR-2026-0002");
    expect(await db.$transaction((tx) => nextDocumentNumber(tx, "PR", orgId, new Date("2027-02-01T08:00:00.000Z")))).toBe("PR-2027-0001");
    const other = await db.organization.create({ data: { name: "Other Org", slug: "other-org-dn", companyName: "Other" }, select: { id: true } });
    expect(await db.$transaction((tx) => nextDocumentNumber(tx, "PR", other.id, at))).toBe("PR-2026-0001");
  });

  it("rolls the number back with a failed create, leaving no gap", async () => {
    const at = new Date("2026-05-01T08:00:00.000Z");
    await expect(
      db.$transaction(async (tx) => {
        await nextDocumentNumber(tx, "PO", orgId, at);
        throw new Error("create failed after the number was taken");
      }),
    ).rejects.toThrow("create failed");
    expect(await db.$transaction((tx) => nextDocumentNumber(tx, "PO", orgId, at))).toBe("PO-2026-0001");
  });
});
