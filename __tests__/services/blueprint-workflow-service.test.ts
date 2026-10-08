/**
 * The server-owned Blueprint workflow (plan §4.4, owner rulings Oct 8, 2026):
 * submit mints the reference and logs it, a later submit is an UPDATE, the
 * build team moves only between the non-approval stages, two people acting at
 * once cannot both win, and the emails go to the right people.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const { mockDb, mockSend, mockGet } = vi.hoisted(() => {
  const mockDb = {
    blueprint: { findFirst: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    blueprintStatusLog: { create: vi.fn() },
    user: { findMany: vi.fn(), findFirst: vi.fn() },
  };
  return { mockDb, mockSend: vi.fn(), mockGet: vi.fn() };
});

vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: (tx: unknown) => unknown) => fn(mockDb) }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/email", () => ({ sendEmail: mockSend }));
vi.mock("@/services/blueprint-service", () => ({ getBlueprint: mockGet }));

import { makeRef, moveBlueprintStage, submitBlueprint } from "@/services/blueprint-workflow-service";

const ME = { organizationId: "org-1", userId: "u-writer" };
const ID = "bp_mg9x2k1abcde";
const SUBMIT = { readiness: 72, open: ["Deadline"], count: 0, changes: [] };
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockResolvedValue({ ok: true, blueprint: { id: ID, status: "submitted" } });
  mockSend.mockResolvedValue({ success: true });
  mockDb.blueprint.updateMany.mockResolvedValue({ count: 1 });
  mockDb.blueprint.findUniqueOrThrow.mockResolvedValue({ title: "Summit" });
  mockDb.user.findMany.mockResolvedValue([
    { id: "u-admin", email: "admin@x.test", firstName: "Ada" },
    { id: "u-writer", email: "writer@x.test", firstName: "Wren" },
  ]);
  mockDb.user.findFirst.mockResolvedValue({ id: "u-writer", firstName: "Wren", lastName: "Writer", email: "writer@x.test" });
});

describe("makeRef", () => {
  it("has the page's shape", () => {
    expect(makeRef(new Date(2026, 9, 8))).toMatch(/^EB-261008-[A-Z0-9]{3}$/);
  });
});

describe("submitBlueprint", () => {
  it("a draft becomes Submitted with a reference, a log row, and the build team is emailed (not the sender)", async () => {
    mockDb.blueprint.findFirst.mockResolvedValue({ status: "DRAFT", ref: null, title: "Summit" });
    const res = await submitBlueprint(ME, ID, SUBMIT);
    expect(res.ok).toBe(true);
    const upd = mockDb.blueprint.updateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ id: ID, organizationId: "org-1", status: "DRAFT" });
    expect(upd.data).toMatchObject({ status: "SUBMITTED", readiness: 72 });
    expect(upd.data.ref).toMatch(/^EB-\d{6}-[A-Z0-9]{3}$/);
    expect(mockDb.blueprintStatusLog.create.mock.calls[0][0].data).toMatchObject({ kind: "SUBMITTED", fromStatus: "DRAFT", toStatus: "SUBMITTED", readiness: 72, detail: { open: ["Deadline"] } });
    await flush();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].to).toEqual([{ email: "admin@x.test", name: "Ada" }]);
    expect(mockSend.mock.calls[0][0].subject).toBe("Blueprint submitted: Summit");
  });

  it("a submitted blueprint records an UPDATE and keeps its status", async () => {
    mockDb.blueprint.findFirst.mockResolvedValue({ status: "IN_REVIEW", ref: "EB-261008-AAA", title: "Summit" });
    await submitBlueprint(ME, ID, { ...SUBMIT, count: 3, changes: ["a", "b", "c"] });
    expect(mockDb.blueprint.updateMany).not.toHaveBeenCalled();
    expect(mockDb.blueprintStatusLog.create.mock.calls[0][0].data).toMatchObject({ kind: "UPDATE", detail: { count: 3 } });
    expect(mockSend.mock.calls[0][0].subject).toBe("Blueprint updated: Summit");
  });

  it("a reference that clashes is minted again", async () => {
    mockDb.blueprint.findFirst.mockResolvedValue({ status: "DRAFT", ref: null, title: "Summit" });
    mockDb.blueprint.updateMany
      .mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "t" }))
      .mockResolvedValueOnce({ count: 1 });
    expect((await submitBlueprint(ME, ID, SUBMIT)).ok).toBe(true);
    expect(mockDb.blueprint.updateMany).toHaveBeenCalledTimes(2);
  });

  it("losing the race to another submit is a CONFLICT", async () => {
    mockDb.blueprint.findFirst.mockResolvedValue({ status: "DRAFT", ref: null, title: "Summit" });
    mockDb.blueprint.updateMany.mockResolvedValue({ count: 0 });
    expect(await submitBlueprint(ME, ID, SUBMIT)).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("another organisation's blueprint is not found", async () => {
    mockDb.blueprint.findFirst.mockResolvedValue(null);
    expect(await submitBlueprint(ME, ID, SUBMIT)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(mockDb.blueprint.findFirst.mock.calls[0][0].where).toMatchObject({ id: ID, organizationId: "org-1" });
  });

  it("a failed email is logged and never undoes the submission", async () => {
    mockDb.blueprint.findFirst.mockResolvedValue({ status: "DRAFT", ref: null, title: "Summit" });
    mockSend.mockResolvedValue({ success: false, error: "SES down" });
    expect((await submitBlueprint(ME, ID, SUBMIT)).ok).toBe(true);
  });
});

describe("moveBlueprintStage", () => {
  const ADMIN = { organizationId: "org-1", userId: "u-admin" };

  it.each([
    ["SUBMITTED", "IN_REVIEW"],
    ["IN_REVIEW", "PLAN_READY"],
    ["PLAN_READY", "IN_REVIEW"],
    ["BUILDING", "PREVIEW"],
  ] as const)("moves %s to %s and emails the writer", async (from, to) => {
    mockDb.blueprint.findFirst.mockResolvedValueOnce({ status: from, ref: "EB-1", title: "Summit", ownerId: "u-writer" });
    expect((await moveBlueprintStage(ADMIN, ID, to)).ok).toBe(true);
    expect(mockDb.blueprint.updateMany.mock.calls[0][0]).toMatchObject({ where: { status: from }, data: { status: to } });
    expect(mockSend.mock.calls[0][0].to).toEqual([{ email: "writer@x.test", name: "Wren" }]);
  });

  it.each([
    ["PLAN_READY", "BUILDING"],
    ["PREVIEW", "LIVE"],
    ["DRAFT", "SUBMITTED"],
    ["SUBMITTED", "PLAN_READY"],
  ] as const)("refuses %s to %s (approval or submit only, or a skipped stage)", async (from, to) => {
    mockDb.blueprint.findFirst.mockResolvedValueOnce({ status: from, ref: "EB-1", title: "Summit", ownerId: "u-writer" });
    expect(await moveBlueprintStage(ADMIN, ID, to)).toMatchObject({ ok: false, code: "NOT_ALLOWED_FROM_STAGE" });
    expect(mockDb.blueprint.updateMany).not.toHaveBeenCalled();
  });

  it("does not email the writer about their own move", async () => {
    mockDb.blueprint.findFirst.mockResolvedValueOnce({ status: "SUBMITTED", ref: "EB-1", title: "Summit", ownerId: "u-admin" });
    await moveBlueprintStage(ADMIN, ID, "IN_REVIEW");
    expect(mockSend).not.toHaveBeenCalled();
  });
});
