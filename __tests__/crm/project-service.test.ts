/**
 * Corporate projects (Nov 12, 2026): one name per organisation whatever its
 * case, every id bound to the caller's organisation, the event link audited in
 * the write's own transaction, and archive leaving the deals alone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { db } = vi.hoisted(() => {
  const db = {
    crmProject: { findFirst: vi.fn(), findFirstOrThrow: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    crmCompany: { findFirst: vi.fn() },
    event: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
    userPermissionSet: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  return { db };
});
vi.mock("@/lib/db", () => ({ db, tenantTransaction: (fn: (tx: typeof db) => unknown) => fn(db) }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { Prisma } from "@prisma/client";
import { createProject, projectNameKey, setProjectArchived, updateProject } from "@/crm/services/project-service";

const ORG = "org-1";
const caller = { organizationId: ORG, userId: "u-1", source: "rest" as const };
const stored = {
  id: "p-1", organizationId: ORG, name: "Novartis Ad Board", nameKey: "novartis ad board", companyId: null,
  startDate: null, endDate: null, location: null, ownerId: null, eventId: null, archivedAt: null,
};
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
/**
 * The service asks crmProject.findFirst two things: the project by id, and
 * (by nameKey) whether ANOTHER project holds a name. A single resolved value
 * would answer the second with the project itself, which the real `id: { not }`
 * never does, so the mock answers each question separately.
 */
function projects(byId: unknown, nameHolder: unknown = null) {
  db.crmProject.findFirst.mockImplementation(async (a: { where?: { nameKey?: string } }) => (a?.where?.nameKey ? nameHolder : byId));
}
const audit = () => db.auditLog.create.mock.calls.map((c) => (c[0] as { data: { action: string; changes: Record<string, unknown> } }).data);

beforeEach(() => {
  vi.clearAllMocks();
  db.auditLog.create.mockResolvedValue({});
  db.userPermissionSet.findMany.mockResolvedValue([]);
  projects(null);
  db.crmProject.create.mockImplementation(async (a: { data: Record<string, unknown> }) => ({ id: "p-new", ...a.data }));
  db.crmProject.updateMany.mockResolvedValue({ count: 1 });
  db.crmProject.findFirstOrThrow.mockResolvedValue(stored);
});

describe("projectNameKey", () => {
  it("ignores case, outer spaces and repeated inner spaces", () => {
    expect(projectNameKey("  Novartis   Ad  Board ")).toBe("novartis ad board");
  });
});

describe("createProject", () => {
  it("needs a name", async () => {
    expect(await createProject({ ...caller, name: "   " })).toMatchObject({ ok: false, code: "NAME_REQUIRED" });
    expect(db.crmProject.create).not.toHaveBeenCalled();
  });

  it("creates with the dedup key and an audit row in the same transaction", async () => {
    const res = await createProject({ ...caller, name: " Novartis Ad Board ", location: "  Dubai ", startDate: day("2027-03-01"), endDate: day("2027-03-02") });
    expect(res.ok).toBe(true);
    expect(db.crmProject.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: ORG, name: "Novartis Ad Board", nameKey: "novartis ad board", location: "Dubai", eventId: null }),
    });
    expect(audit()).toEqual([expect.objectContaining({ action: "CRM_PROJECT_CREATED", entityType: "CrmProject", entityId: "p-new" })]);
  });

  it("refuses a name already used, in any case, and says which project holds it", async () => {
    projects(null, { id: "p-1" });
    const res = await createProject({ ...caller, name: "NOVARTIS ad board" });
    expect(res).toMatchObject({ ok: false, code: "NAME_TAKEN", meta: { existingProjectId: "p-1" } });
    expect(db.crmProject.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: ORG, nameKey: "novartis ad board" } }));
    expect(db.crmProject.create).not.toHaveBeenCalled();
  });

  it("two people creating the same name at once: the unique index decides, as NAME_TAKEN", async () => {
    db.crmProject.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }));
    expect(await createProject({ ...caller, name: "Same" })).toMatchObject({ ok: false, code: "NAME_TAKEN" });
  });

  it("refuses an end date before the start date", async () => {
    const res = await createProject({ ...caller, name: "X", startDate: day("2027-03-02"), endDate: day("2027-03-01") });
    expect(res).toMatchObject({ ok: false, code: "DATES_OUT_OF_ORDER" });
  });

  it("binds the account, the owner and the event to the caller's organisation", async () => {
    db.crmCompany.findFirst.mockResolvedValue(null);
    expect(await createProject({ ...caller, name: "X", companyId: "co-theirs" })).toMatchObject({ ok: false, code: "COMPANY_NOT_FOUND" });
    expect(db.crmCompany.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "co-theirs", organizationId: ORG } }));

    db.event.findFirst.mockResolvedValue(null);
    expect(await createProject({ ...caller, name: "X", eventId: "e-theirs" })).toMatchObject({ ok: false, code: "EVENT_NOT_FOUND" });

    db.user.findFirst.mockResolvedValue({ id: "u-desk", role: "ONSITE" });
    expect(await createProject({ ...caller, name: "X", ownerId: "u-desk" })).toMatchObject({ ok: false, code: "OWNER_ROLE_NOT_ALLOWED" });
    expect(db.crmProject.create).not.toHaveBeenCalled();
  });
});

describe("updateProject", () => {
  beforeEach(() => projects(stored));

  it("refuses nothing-to-change, a missing project and an archived one", async () => {
    expect(await updateProject({ ...caller, projectId: "p-1" })).toMatchObject({ ok: false, code: "NO_FIELDS" });
    projects(null);
    expect(await updateProject({ ...caller, projectId: "p-x", name: "Y" })).toMatchObject({ ok: false, code: "PROJECT_NOT_FOUND" });
    projects({ ...stored, archivedAt: new Date() });
    expect(await updateProject({ ...caller, projectId: "p-1", name: "Y" })).toMatchObject({ ok: false, code: "PROJECT_ARCHIVED" });
    expect(db.crmProject.updateMany).not.toHaveBeenCalled();
  });

  it("linking to an event is audited as a link change, with before and after, in the write's transaction", async () => {
    db.event.findFirst.mockResolvedValue({ id: "e-1" });
    const res = await updateProject({ ...caller, projectId: "p-1", eventId: "e-1" });
    expect(res.ok).toBe(true);
    expect(db.crmProject.updateMany).toHaveBeenCalledWith({
      where: { id: "p-1", organizationId: ORG, archivedAt: null },
      data: { eventId: "e-1" },
    });
    expect(audit()).toEqual([
      expect.objectContaining({ action: "CRM_PROJECT_EVENT_LINK_CHANGED", changes: expect.objectContaining({ eventId: { from: null, to: "e-1" } }) }),
    ]);
  });

  it("clearing the link is audited the same way; an ordinary edit is not a link change", async () => {
    projects({ ...stored, eventId: "e-1" });
    await updateProject({ ...caller, projectId: "p-1", eventId: null });
    await updateProject({ ...caller, projectId: "p-1", location: "Abu Dhabi", eventId: "e-1" });
    expect(audit().map((a) => a.action)).toEqual(["CRM_PROJECT_EVENT_LINK_CHANGED", "CRM_PROJECT_UPDATED"]);
    expect(audit()[0]!.changes).toMatchObject({ eventId: { from: "e-1", to: null } });
  });

  it("only an id that CHANGED is checked, so a project stays editable after its account was archived", async () => {
    projects({ ...stored, companyId: "co-old" });
    db.crmCompany.findFirst.mockResolvedValue({ archivedAt: new Date() });
    expect((await updateProject({ ...caller, projectId: "p-1", companyId: "co-old", name: "Renamed" })).ok).toBe(true);
    // Moving it onto an archived account is still refused.
    expect(await updateProject({ ...caller, projectId: "p-1", companyId: "co-other" })).toMatchObject({ ok: false, code: "COMPANY_ARCHIVED" });
  });

  it("checks the dates against what is stored, and a rename against other projects only", async () => {
    projects({ ...stored, startDate: day("2027-03-05") });
    expect(await updateProject({ ...caller, projectId: "p-1", endDate: day("2027-03-01") })).toMatchObject({ ok: false, code: "DATES_OUT_OF_ORDER" });

    // Same key (a change of case only): nobody else is asked for, the write goes through.
    projects(stored, { id: "p-2" });
    expect((await updateProject({ ...caller, projectId: "p-1", name: "NOVARTIS AD BOARD" })).ok).toBe(true);

    expect(await updateProject({ ...caller, projectId: "p-1", name: "Pfizer Tour" })).toMatchObject({ ok: false, code: "NAME_TAKEN", meta: { existingProjectId: "p-2" } });
    // The clash lookup leaves this project out and stays inside the organisation.
    expect(db.crmProject.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, nameKey: "pfizer tour", id: { not: "p-1" } } }),
    );
  });

  it("an archive landing between the read and the write loses", async () => {
    db.crmProject.updateMany.mockResolvedValue({ count: 0 });
    expect(await updateProject({ ...caller, projectId: "p-1", name: "Y" })).toMatchObject({ ok: false, code: "PROJECT_ARCHIVED" });
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("setProjectArchived", () => {
  it("archives and restores with an audit row, and touches no deal", async () => {
    projects({ id: "p-1", archivedAt: null });
    expect((await setProjectArchived({ ...caller, projectId: "p-1", archived: true })).ok).toBe(true);
    projects({ id: "p-1", archivedAt: new Date() });
    expect((await setProjectArchived({ ...caller, projectId: "p-1", archived: false })).ok).toBe(true);
    expect(audit().map((a) => a.action)).toEqual(["CRM_PROJECT_ARCHIVED", "CRM_PROJECT_RESTORED"]);
    expect(db.crmProject.updateMany).toHaveBeenCalledWith({ where: { id: "p-1", organizationId: ORG }, data: { archivedAt: expect.any(Date) } });
  });

  it("archiving an archived project changes nothing and records nothing", async () => {
    projects({ id: "p-1", archivedAt: new Date() });
    expect((await setProjectArchived({ ...caller, projectId: "p-1", archived: true })).ok).toBe(true);
    expect(db.crmProject.updateMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("404s a project of another organisation", async () => {
    projects(null);
    expect(await setProjectArchived({ ...caller, projectId: "p-theirs", archived: true })).toMatchObject({ ok: false, code: "PROJECT_NOT_FOUND" });
  });
});
