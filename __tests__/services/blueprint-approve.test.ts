/**
 * approveBlueprint (plan §4.5, owner rulings Oct 8, 2026): an approver who did
 * not write or edit it signs off; the plan is checked complete on the SERVER,
 * creates one event ever (claimed first, released on failure), and seeds its
 * sessions and sponsors; the preview makes it Live.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  db: {
    blueprint: { findFirst: vi.fn(), updateMany: vi.fn() },
    blueprintStatusLog: { create: vi.fn() },
    user: { findMany: vi.fn(), findFirst: vi.fn() },
  },
  createEvent: vi.fn(),
  createSession: vi.fn(),
  saveSponsors: vi.fn(),
  score: vi.fn(),
  getBlueprint: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: h.db, tenantTransaction: (fn: (tx: unknown) => unknown) => fn(h.db) }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
vi.mock("@/services/blueprint-service", () => ({ getBlueprint: h.getBlueprint }));
vi.mock("@/services/event-service", () => ({ createEvent: h.createEvent }));
vi.mock("@/services/session-service", () => ({ createSession: h.createSession }));
vi.mock("@/services/sponsor-service", () => ({ saveSponsors: h.saveSponsors }));
vi.mock("@/lib/blueprint/vendor-rules", () => ({
  scoreBlueprint: h.score,
  readWhen: (t: string) => (t === "4 March 2027" ? { y: 2027, m: 3, d: 4, approx: false, yearOnly: false } : { y: 2027, m: 3, d: 15, approx: true, yearOnly: false }),
}));

import { approveBlueprint } from "@/services/blueprint-workflow-service";

const APPROVER = { organizationId: "org-1", userId: "u-approver" };
const ID = "bp_mg9x2k1abcde";
const DATA = {
  format: "In person",
  basics: { title: "Summit", when: "4 March 2027", duration: "1 day" },
  programme: { rows: [{ time: "09:00", title: "Opening", space: "Hall", who: "" }] },
  partners: { has: "yes", list: [{ name: "Acme", tier: "Gold" }] },
};
const VERSION = 1_791_446_000_000;
const OPTS = { version: VERSION, mayCreateEvent: () => true };
const row = (over: Record<string, unknown> = {}) => ({ status: "PLAN_READY", ref: "EB-1", title: "Summit", ownerId: "u-writer", editorIds: [], eventId: null, data: DATA, updatedAt: new Date(VERSION), ...over });

beforeEach(() => {
  vi.clearAllMocks();
  h.db.blueprint.findFirst.mockResolvedValue(row());
  h.db.blueprint.updateMany.mockResolvedValue({ count: 1 });
  h.db.user.findFirst.mockResolvedValue({ id: "u-writer", email: "w@x.test", firstName: "Wren", lastName: "W" });
  h.score.mockImplementation((d: unknown) => ({ pct: 100, blocking: [], data: d }));
  h.createEvent.mockResolvedValue({ ok: true, event: { id: "evt-1" } });
  h.createSession.mockResolvedValue({ ok: true, session: { id: "s1" } });
  h.saveSponsors.mockResolvedValue({ ok: true, sponsors: [] });
  h.getBlueprint.mockResolvedValue({ ok: true, blueprint: { id: ID, status: "building", eventId: "evt-1" } });
});

describe("approveBlueprint: the plan", () => {
  it("creates the event, its sessions and sponsors, records it and moves to Building", async () => {
    const res = await approveBlueprint(APPROVER, ID, "plan", OPTS);
    expect(res).toMatchObject({ ok: true, blueprint: { eventId: "evt-1" } });
    expect(h.db.blueprint.updateMany.mock.calls[0][0]).toMatchObject({
      where: { status: "PLAN_READY", eventId: null, OR: [{ approvedAt: null }, { approvedAt: { lt: expect.any(Date) } }] },
      data: { approvedById: "u-approver" },
    });
    expect(h.createEvent).toHaveBeenCalledWith(expect.objectContaining({ name: "Summit", eventType: "CONFERENCE", source: "blueprint" }));
    expect(h.createSession).toHaveBeenCalledWith(expect.objectContaining({ eventId: "evt-1", name: "Opening", source: "blueprint", suppressAdminNotification: true }));
    expect(h.saveSponsors).toHaveBeenCalledWith(expect.objectContaining({ eventId: "evt-1", mode: "merge", sponsors: [{ name: "Acme", tier: "gold" }] }));
    expect(h.db.blueprint.updateMany.mock.calls[1][0]).toMatchObject({ where: { approvedById: "u-approver", eventId: null }, data: { eventId: "evt-1" } });
    expect(h.db.blueprint.updateMany.mock.calls[2][0]).toMatchObject({ where: { status: "PLAN_READY" }, data: { status: "BUILDING" } });
    expect(h.db.blueprintStatusLog.create.mock.calls[0][0].data).toMatchObject({
      kind: "APPROVED",
      toStatus: "BUILDING",
      detail: { which: "plan", eventId: "evt-1", sessions: 1, sponsors: 1 },
    });
  });

  it.each([
    ["the writer", { ownerId: "u-approver" }],
    ["someone who edited it after submission", { editorIds: ["u-approver"] }],
  ])("refuses %s", async (_l, over) => {
    h.db.blueprint.findFirst.mockResolvedValue(row(over));
    expect(await approveBlueprint(APPROVER, ID, "plan", OPTS)).toMatchObject({ ok: false, code: "APPROVER_IS_AUTHOR" });
    expect(h.createEvent).not.toHaveBeenCalled();
  });

  it("refuses a version the approver did not see (review M4)", async () => {
    h.db.blueprint.findFirst.mockResolvedValue(row({ updatedAt: new Date(VERSION + 5000) }));
    expect(await approveBlueprint(APPROVER, ID, "plan", OPTS)).toMatchObject({ ok: false, code: "STALE_VERSION" });
    expect(h.db.blueprint.updateMany).not.toHaveBeenCalled();
  });

  it("refuses an approver whose role cannot create that kind of event (review L10)", async () => {
    const mayCreateEvent = vi.fn().mockReturnValue(false);
    expect(await approveBlueprint(APPROVER, ID, "plan", { version: VERSION, mayCreateEvent })).toMatchObject({ ok: false, code: "OUT_OF_SCOPE" });
    expect(mayCreateEvent).toHaveBeenCalledWith("CONFERENCE");
    expect(h.createEvent).not.toHaveBeenCalled();
  });

  it("a claim older than ten minutes with no event can be taken again (review M3)", async () => {
    await approveBlueprint(APPROVER, ID, "plan", OPTS);
    const cutoff = h.db.blueprint.updateMany.mock.calls[0][0].where.OR[1].approvedAt.lt as Date;
    expect(Date.now() - cutoff.getTime()).toBeGreaterThanOrEqual(10 * 60_000 - 1000);
  });

  it("refuses before Plan ready", async () => {
    h.db.blueprint.findFirst.mockResolvedValue(row({ status: "IN_REVIEW" }));
    expect(await approveBlueprint(APPROVER, ID, "plan", OPTS)).toMatchObject({ ok: false, code: "NOT_ALLOWED_FROM_STAGE" });
  });

  it("refuses an incomplete blueprint and lists what is missing, creating nothing", async () => {
    h.score.mockReturnValue({ pct: 60, blocking: [{ sec: "delivery", label: "Deadline" }], data: DATA });
    expect(await approveBlueprint(APPROVER, ID, "plan", OPTS)).toMatchObject({ ok: false, code: "BLUEPRINT_INCOMPLETE", meta: { missing: ["Deadline"] } });
    expect(h.db.blueprint.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a vague date", async () => {
    h.db.blueprint.findFirst.mockResolvedValue(row({ data: { ...DATA, basics: { ...DATA.basics, when: "March 2027" } } }));
    expect(await approveBlueprint(APPROVER, ID, "plan", OPTS)).toMatchObject({ ok: false, code: "DATES_NEEDED" });
    expect(h.createEvent).not.toHaveBeenCalled();
  });

  it("a second approver at the same moment loses the claim and creates nothing", async () => {
    h.db.blueprint.updateMany.mockResolvedValue({ count: 0 });
    expect(await approveBlueprint(APPROVER, ID, "plan", OPTS)).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(h.createEvent).not.toHaveBeenCalled();
  });

  it("an event that cannot be created releases the claim", async () => {
    h.createEvent.mockResolvedValue({ ok: false, code: "EVENT_CODE_TAKEN", message: "taken" });
    expect(await approveBlueprint(APPROVER, ID, "plan", OPTS)).toMatchObject({ ok: false, code: "EVENT_CREATE_FAILED" });
    expect(h.db.blueprint.updateMany.mock.calls[1][0]).toMatchObject({ where: { eventId: null, approvedById: "u-approver" }, data: { approvedAt: null, approvedById: null } });
  });

  it("a crash after the claim releases it and rethrows", async () => {
    h.createEvent.mockRejectedValue(new Error("db down"));
    await expect(approveBlueprint(APPROVER, ID, "plan", OPTS)).rejects.toThrow("db down");
    expect(h.db.blueprint.updateMany).toHaveBeenCalledTimes(2);
  });

  it("a throw after the event exists keeps the event and the claim, never a second event (review H2)", async () => {
    h.createSession.mockRejectedValue(new Error("validate exploded"));
    const res = await approveBlueprint(APPROVER, ID, "plan", OPTS);
    expect(res.ok).toBe(true);
    const calls = h.db.blueprint.updateMany.mock.calls.map((c) => c[0].data);
    expect(calls).not.toContainEqual({ approvedAt: null, approvedById: null });
    expect(calls[1]).toEqual({ eventId: "evt-1" });
    expect(h.db.blueprintStatusLog.create.mock.calls[0][0].data.detail.skipped).toContain('Session "Opening": could not be added');
  });

  it("a stage move made meanwhile is not overwritten (review L14)", async () => {
    h.db.blueprint.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    expect((await approveBlueprint(APPROVER, ID, "plan", OPTS)).ok).toBe(true);
    expect(h.db.blueprintStatusLog.create.mock.calls[0][0].data).toMatchObject({ kind: "APPROVED", toStatus: null, detail: { eventId: "evt-1" } });
  });

  it("a session that fails is listed, never undoes the event", async () => {
    h.createSession.mockResolvedValue({ ok: false, code: "OUTSIDE_EVENT", message: "outside the event dates" });
    expect((await approveBlueprint(APPROVER, ID, "plan", OPTS)).ok).toBe(true);
    expect(h.db.blueprintStatusLog.create.mock.calls[0][0].data.detail.skipped).toContain('Session "Opening": outside the event dates');
  });

  it("approving again returns the blueprint with its one event", async () => {
    h.db.blueprint.findFirst.mockResolvedValue(row({ status: "BUILDING", eventId: "evt-1" }));
    expect((await approveBlueprint(APPROVER, ID, "plan", OPTS)).ok).toBe(true);
    expect(h.createEvent).not.toHaveBeenCalled();
  });
});

describe("approveBlueprint: the preview", () => {
  it("moves Preview to Live with an APPROVED record, creating nothing", async () => {
    h.db.blueprint.findFirst.mockResolvedValue(row({ status: "PREVIEW", eventId: "evt-1" }));
    expect((await approveBlueprint(APPROVER, ID, "preview", OPTS)).ok).toBe(true);
    expect(h.db.blueprint.updateMany.mock.calls[0][0]).toMatchObject({ where: { status: "PREVIEW" }, data: { status: "LIVE" } });
    expect(h.db.blueprintStatusLog.create.mock.calls[0][0].data).toMatchObject({ kind: "APPROVED", toStatus: "LIVE", detail: { which: "preview" } });
    expect(h.createEvent).not.toHaveBeenCalled();
  });
});
