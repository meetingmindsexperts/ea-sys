/**
 * Survey-gated certificate auto-issue: the sweep's enqueue / idempotency /
 * retry-backoff behavior, driven by ASSIGNMENTS since Nov 11, 2026 (the pure
 * routing rule is pinned in certificate-assignments.test.ts).
 *
 * The sweep takes the per-event lock as the FIRST statement of each
 * registration's transaction and reads the templates, the linked speaker and
 * the assignments after it; the order test below pins that, because it is
 * what stops an assignment made at the same moment from being missed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const registrationFindMany = vi.fn();
const registrationUpdate = vi.fn();

const calls: string[] = [];
const txQueryRaw = vi.fn();
const txTemplateFindMany = vi.fn();
const txSpeakerFindFirst = vi.fn();
const txAssignmentFindMany = vi.fn();
const txIssuedCertFindFirst = vi.fn();
const txRunItemFindFirst = vi.fn();
const txRunCreate = vi.fn();
const txRunItemCreate = vi.fn();
const txRegistrationUpdate = vi.fn();

const record = <T extends (...a: never[]) => unknown>(name: string, fn: T) =>
  ((...a: Parameters<T>) => {
    calls.push(name);
    return fn(...a);
  }) as T;

const tx = {
  $queryRaw: record("lock", (...a: unknown[]) => txQueryRaw(...a)),
  certificateTemplate: { findMany: record("templates", (...a: unknown[]) => txTemplateFindMany(...a)) },
  speaker: { findFirst: record("speaker", (...a: unknown[]) => txSpeakerFindFirst(...a)) },
  certificateAssignment: { findMany: record("assignments", (...a: unknown[]) => txAssignmentFindMany(...a)) },
  issuedCertificate: { findFirst: (...a: unknown[]) => txIssuedCertFindFirst(...a) },
  certificateIssueRunItem: {
    findFirst: (...a: unknown[]) => txRunItemFindFirst(...a),
    create: (...a: unknown[]) => txRunItemCreate(...a),
  },
  certificateIssueRun: { create: (...a: unknown[]) => txRunCreate(...a) },
  registration: { update: record("stamp", (...a: unknown[]) => txRegistrationUpdate(...a)) },
};

// `dbOperator` is the SAME object as `db` here, which is exactly what it is on
// master (one client, one pool). The worker's candidate scan runs on the
// operator lane; every assertion below still drives the same fake delegates.
vi.mock("@/lib/db", () => {
  const client = {
    registration: {
      findMany: (...a: unknown[]) => registrationFindMany(...a),
      update: (...a: unknown[]) => registrationUpdate(...a),
    },
    $transaction: (cb: (t: typeof tx) => unknown) => cb(tx),
  };
  return {
    db: client,
    dbOperator: client,
    // tenantTransaction with the flag off IS db.$transaction, so delegate and the
    // test's tx interception keeps working for the migrated sweep site.
    tenantTransaction: (cb: (t: typeof tx) => unknown) => cb(tx),
  };
});
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { runAutoIssueSweep } from "@/lib/certificates/auto-issue";

const attendanceTpl = { id: "tpl_att", category: "ATTENDANCE" as const };
const appreciationTpl = { id: "tpl_app", category: "APPRECIATION" as const };

/** Assignment rows as the sweep's one query returns them. */
const regAssigned = (templateId: string, registrationId: string) => ({
  certificateTemplateId: templateId,
  registrationId,
  speakerId: null,
});
const speakerAssigned = (templateId: string, speakerId: string) => ({
  certificateTemplateId: templateId,
  registrationId: null,
  speakerId,
});

const candidate = (id: string, attendee: Record<string, unknown>, attempts = 0) => ({
  id,
  eventId: "evt_1",
  organizationId: null,
  certAutoIssueAttempts: attempts,
  attendee,
});

const NOW = new Date("2026-06-25T12:00:00Z");

beforeEach(() => {
  calls.length = 0;
  [
    registrationFindMany, registrationUpdate, txQueryRaw, txTemplateFindMany, txSpeakerFindFirst,
    txAssignmentFindMany, txIssuedCertFindFirst, txRunItemFindFirst, txRunCreate, txRunItemCreate,
    txRegistrationUpdate,
  ].forEach((m) => m.mockReset());
  txQueryRaw.mockResolvedValue([]);
  txTemplateFindMany.mockResolvedValue([]);
  txSpeakerFindFirst.mockResolvedValue(null);
  txAssignmentFindMany.mockResolvedValue([]);
  txIssuedCertFindFirst.mockResolvedValue(null);
  txRunItemFindFirst.mockResolvedValue(null);
  txRunCreate.mockResolvedValue({ id: "run_new" });
  txRunItemCreate.mockResolvedValue({ id: "item_new" });
  txRegistrationUpdate.mockResolvedValue({});
  registrationUpdate.mockResolvedValue({});
});

describe("runAutoIssueSweep", () => {
  it("enqueues an ATTENDANCE auto-run for an assigned registration + stamps checkedAt", async () => {
    registrationFindMany.mockResolvedValue([
      candidate("reg_1", { title: "DR", firstName: "Jane", lastName: "Doe", email: "j@x.com" }),
    ]);
    txTemplateFindMany.mockResolvedValue([attendanceTpl]);
    txAssignmentFindMany.mockResolvedValue([regAssigned("tpl_att", "reg_1")]);

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.scanned).toBe(1);
    expect(res.runsCreated).toBe(1);
    expect(res.resolved).toBe(1);
    // run created with autoIssue + null operator + registration recipient
    const runArg = txRunCreate.mock.calls[0][0].data;
    expect(runArg.autoIssue).toBe(true);
    expect(runArg.triggeredByUserId).toBeNull();
    expect(runArg.type).toBe("ATTENDANCE");
    const itemArg = txRunItemCreate.mock.calls[0][0].data;
    expect(itemArg.registrationId).toBe("reg_1");
    expect(itemArg.speakerId).toBeNull();
    // terminal stamp inside the tx
    expect(txRegistrationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "reg_1" }, data: { certAutoIssueCheckedAt: NOW, certAutoIssueError: null } }),
    );
  });

  it("takes the per-event lock FIRST and reads templates, speaker and assignments after it, then stamps", async () => {
    registrationFindMany.mockResolvedValue([
      candidate("reg_1", { title: null, firstName: "A", lastName: "B", email: "a@x.com" }),
    ]);
    txTemplateFindMany.mockResolvedValue([attendanceTpl]);
    txAssignmentFindMany.mockResolvedValue([regAssigned("tpl_att", "reg_1")]);

    await runAutoIssueSweep({ now: NOW });

    // An assignment or a switch-on that commits at the same moment takes the
    // same lock: reading anything before it would let the stamp bury them.
    expect(calls[0]).toBe("lock");
    expect(calls.indexOf("templates")).toBeGreaterThan(0);
    expect(calls.indexOf("assignments")).toBeGreaterThan(calls.indexOf("templates"));
    expect(calls[calls.length - 1]).toBe("stamp");
    // Only auto-issue templates of the registration's own event are considered.
    expect(txTemplateFindMany.mock.calls[0][0].where).toEqual({ eventId: "evt_1", autoIssueOnSurvey: true });
  });

  it("asks for the assignments of THIS registration and its linked speaker only", async () => {
    registrationFindMany.mockResolvedValue([
      candidate("reg_9", { title: null, firstName: "A", lastName: "B", email: "a@x.com" }),
    ]);
    txTemplateFindMany.mockResolvedValue([attendanceTpl, appreciationTpl]);
    txSpeakerFindFirst.mockResolvedValueOnce({ id: "spk_9", title: null, firstName: "A", lastName: "B", email: "a@x.com" });

    await runAutoIssueSweep({ now: NOW });

    expect(txAssignmentFindMany.mock.calls[0][0].where).toEqual({
      certificateTemplateId: { in: ["tpl_att", "tpl_app"] },
      OR: [{ registrationId: "reg_9" }, { speakerId: "spk_9" }],
    });
  });

  it("sends nothing to a person who answered but is assigned nothing, and still stamps them", async () => {
    registrationFindMany.mockResolvedValue([
      candidate("reg_n", { title: null, firstName: "N", lastName: "O", email: "n@x.com" }),
    ]);
    txTemplateFindMany.mockResolvedValue([attendanceTpl]);
    txAssignmentFindMany.mockResolvedValue([]);

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.runsCreated).toBe(0);
    expect(txRunCreate).not.toHaveBeenCalled();
    expect(txRegistrationUpdate).toHaveBeenCalled();
    expect(res.resolved).toBe(1);
  });

  it("ignores an assignment that belongs to somebody else", async () => {
    registrationFindMany.mockResolvedValue([
      candidate("reg_1", { title: null, firstName: "A", lastName: "B", email: "a@x.com" }),
    ]);
    txTemplateFindMany.mockResolvedValue([attendanceTpl]);
    // A wrong row slipping through the query must still not issue.
    txAssignmentFindMany.mockResolvedValue([regAssigned("tpl_att", "reg_other")]);

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.runsCreated).toBe(0);
    expect(txRunCreate).not.toHaveBeenCalled();
  });

  it("excludes CANCELLED registrations from the candidate query (M2)", async () => {
    registrationFindMany.mockResolvedValue([]);
    await runAutoIssueSweep({ now: NOW });
    const where = registrationFindMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ not: "CANCELLED" });
  });

  it("routes APPRECIATION to the linked speaker (companion case)", async () => {
    registrationFindMany.mockResolvedValue([
      candidate("reg_2", { title: null, firstName: "Sam", lastName: "Lee", email: "s@x.com" }),
    ]);
    txTemplateFindMany.mockResolvedValue([appreciationTpl]);
    txSpeakerFindFirst.mockResolvedValueOnce({
      id: "spk_2", title: "PROF", firstName: "Sam", lastName: "Lee", email: "s@x.com",
    });
    txAssignmentFindMany.mockResolvedValue([speakerAssigned("tpl_app", "spk_2")]);

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.runsCreated).toBe(1);
    const itemArg = txRunItemCreate.mock.calls[0][0].data;
    expect(itemArg.speakerId).toBe("spk_2");
    expect(itemArg.registrationId).toBeNull();
  });

  it("an APPRECIATION template assigned to the REGISTRATION does not issue (wrong facet)", async () => {
    registrationFindMany.mockResolvedValue([
      candidate("reg_2", { title: null, firstName: "Sam", lastName: "Lee", email: "s@x.com" }),
    ]);
    txTemplateFindMany.mockResolvedValue([appreciationTpl]);
    txAssignmentFindMany.mockResolvedValue([regAssigned("tpl_app", "reg_2")]);

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.runsCreated).toBe(0);
    expect(txRunCreate).not.toHaveBeenCalled();
  });

  it("bundles a committee+speaker person into ONE run + ONE person-keyed item (one email)", async () => {
    registrationFindMany.mockResolvedValue([
      candidate("reg_5", { title: "DR", firstName: "Jane", lastName: "Doe", email: "j@x.com" }),
    ]);
    txTemplateFindMany.mockResolvedValue([attendanceTpl, appreciationTpl]);
    txSpeakerFindFirst.mockResolvedValueOnce({
      id: "spk_5", title: "DR", firstName: "Jane", lastName: "Doe", email: "j@x.com",
    });
    txAssignmentFindMany.mockResolvedValue([
      regAssigned("tpl_att", "reg_5"),
      speakerAssigned("tpl_app", "spk_5"),
    ]);

    const res = await runAutoIssueSweep({ now: NOW });

    // ONE run covering both templates, not two 1-template runs.
    expect(txRunCreate).toHaveBeenCalledTimes(1);
    const runArg = txRunCreate.mock.calls[0][0].data;
    expect(runArg.templateIds).toEqual(["tpl_att", "tpl_app"]);
    expect(runArg.certificateTemplateId).toBeNull();
    // Multi bundle: null cover snapshot (send phase uses the MULTI defaults).
    expect(runArg.emailSubject).toBeNull();
    expect(runArg.emailBody).toBeNull();
    // ONE person-keyed item with BOTH facets + the stamped subset.
    expect(txRunItemCreate).toHaveBeenCalledTimes(1);
    const itemArg = txRunItemCreate.mock.calls[0][0].data;
    expect(itemArg.registrationId).toBe("reg_5");
    expect(itemArg.speakerId).toBe("spk_5");
    expect(itemArg.templateIds).toEqual(["tpl_att", "tpl_app"]);
    expect(res.runsCreated).toBe(2); // targets enqueued
  });

  it("a single surviving target leaves the run's cover snapshot empty, so the send phase resolves the event's Email Template", async () => {
    registrationFindMany.mockResolvedValue([
      candidate("reg_6", { title: null, firstName: "Sam", lastName: "Lee", email: "s@x.com" }),
    ]);
    txTemplateFindMany.mockResolvedValue([appreciationTpl]);
    txSpeakerFindFirst.mockResolvedValueOnce({
      id: "spk_6", title: null, firstName: "Sam", lastName: "Lee", email: "s@x.com",
    });
    txAssignmentFindMany.mockResolvedValue([speakerAssigned("tpl_app", "spk_6")]);

    await runAutoIssueSweep({ now: NOW });

    const runArg = txRunCreate.mock.calls[0][0].data;
    expect(runArg.certificateTemplateId).toBe("tpl_app");
    expect(runArg.templateIds).toEqual(["tpl_app"]);
    expect(runArg.emailSubject).toBeNull();
    expect(runArg.emailBody).toBeNull();
  });

  it("drops an already-covered target but still bundles the remaining one", async () => {
    registrationFindMany.mockResolvedValue([
      candidate("reg_7", { title: null, firstName: "A", lastName: "B", email: "a@x.com" }),
    ]);
    txTemplateFindMany.mockResolvedValue([attendanceTpl, appreciationTpl]);
    txSpeakerFindFirst.mockResolvedValueOnce({
      id: "spk_7", title: null, firstName: "A", lastName: "B", email: "a@x.com",
    });
    txAssignmentFindMany.mockResolvedValue([
      regAssigned("tpl_att", "reg_7"),
      speakerAssigned("tpl_app", "spk_7"),
    ]);
    // The ATTENDANCE cert already exists; APPRECIATION survives.
    txIssuedCertFindFirst.mockImplementation((args: { where: { certificateTemplateId: string } }) =>
      Promise.resolve(args.where.certificateTemplateId === "tpl_att" ? { id: "cert_existing" } : null),
    );

    const res = await runAutoIssueSweep({ now: NOW });

    expect(txRunCreate).toHaveBeenCalledTimes(1);
    const runArg = txRunCreate.mock.calls[0][0].data;
    expect(runArg.templateIds).toEqual(["tpl_app"]);
    const itemArg = txRunItemCreate.mock.calls[0][0].data;
    expect(itemArg.registrationId).toBeNull();
    expect(itemArg.speakerId).toBe("spk_7");
    expect(res.runsCreated).toBe(1);
  });

  it("skips enqueue when a cert already exists for the (template, recipient)", async () => {
    registrationFindMany.mockResolvedValue([
      candidate("reg_3", { title: null, firstName: "A", lastName: "B", email: "a@x.com" }),
    ]);
    txTemplateFindMany.mockResolvedValue([attendanceTpl]);
    txAssignmentFindMany.mockResolvedValue([regAssigned("tpl_att", "reg_3")]);
    txIssuedCertFindFirst.mockResolvedValue({ id: "cert_existing" });

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.runsCreated).toBe(0);
    expect(txRunCreate).not.toHaveBeenCalled();
    // still terminally stamped (idempotent resolve)
    expect(txRegistrationUpdate).toHaveBeenCalled();
    expect(res.resolved).toBe(1);
  });

  it("skips enqueue when a NON-TERMINAL run (manual OR auto) already has a pending item for the target (H3 double-send guard)", async () => {
    registrationFindMany.mockResolvedValue([
      candidate("reg_h3", { title: null, firstName: "A", lastName: "B", email: "a@x.com" }),
    ]);
    txTemplateFindMany.mockResolvedValue([attendanceTpl]);
    txAssignmentFindMany.mockResolvedValue([regAssigned("tpl_att", "reg_h3")]);
    txIssuedCertFindFirst.mockResolvedValue(null); // no cert yet: the item guard must catch it
    txRunItemFindFirst.mockResolvedValue({ id: "item_from_manual_run" });

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.runsCreated).toBe(0);
    expect(txRunCreate).not.toHaveBeenCalled();
    // The guard must consider ANY non-terminal run (not just autoIssue) and
    // scope to non-terminal statuses so a failed/cancelled run can't strand it.
    const where = txRunItemFindFirst.mock.calls[0][0].where;
    expect(where.run.status).toEqual({
      in: ["PENDING", "RENDERING", "AWAITING_REVIEW", "SENDING"],
    });
    expect(where.run).not.toHaveProperty("autoIssue");
    expect(where.errorPhase).toBeNull();
    expect(res.resolved).toBe(1);
  });

  it("terminally resolves + counts skippedNoTemplates when the event has no auto-issue templates", async () => {
    registrationFindMany.mockResolvedValue([
      candidate("reg_4", { firstName: "X", lastName: "Y", email: "x@x.com" }),
    ]);
    txTemplateFindMany.mockResolvedValue([]);

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.skippedNoTemplates).toBe(1);
    expect(res.resolved).toBe(1);
    // Stamped inside the locked transaction, so a switch turned on at the same
    // moment either was seen or clears the stamp afterwards.
    expect(calls).toEqual(["lock", "templates", "stamp"]);
    expect(txRegistrationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "reg_4" }, data: { certAutoIssueCheckedAt: NOW, certAutoIssueError: null } }),
    );
    expect(txAssignmentFindMany).not.toHaveBeenCalled();
  });

  it("on a transient failure, defers with backoff + increments attempts (does NOT terminally stamp)", async () => {
    registrationFindMany.mockResolvedValue([
      candidate("reg_5", { firstName: "P", lastName: "Q", email: "p@x.com" }, 1),
    ]);
    txTemplateFindMany.mockResolvedValue([attendanceTpl]);
    txAssignmentFindMany.mockResolvedValue([regAssigned("tpl_att", "reg_5")]);
    txRunCreate.mockRejectedValue(new Error("db blip"));

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.deferred).toBe(1);
    expect(res.gaveUp).toBe(0);
    const upd = registrationUpdate.mock.calls[0][0];
    expect(upd.where).toEqual({ id: "reg_5" });
    expect(upd.data.certAutoIssueAttempts).toBe(2);
    expect(upd.data.certAutoIssueError).toContain("db blip");
    expect(upd.data.certAutoIssueNextAttemptAt).toBeInstanceOf(Date);
    expect(upd.data.certAutoIssueCheckedAt).toBeUndefined();
  });

  it("a failure to take the lock is a transient failure like any other", async () => {
    registrationFindMany.mockResolvedValue([
      candidate("reg_l", { firstName: "L", lastName: "K", email: "l@x.com" }),
    ]);
    txQueryRaw.mockRejectedValue(new Error("lock wait timed out"));

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.deferred).toBe(1);
    expect(txRegistrationUpdate).not.toHaveBeenCalled();
    expect(registrationUpdate.mock.calls[0][0].data.certAutoIssueError).toContain("lock wait");
  });

  it("gives up terminally after exhausting retries", async () => {
    registrationFindMany.mockResolvedValue([
      candidate("reg_6", { firstName: "P", lastName: "Q", email: "p@x.com" }, 4),
    ]);
    txTemplateFindMany.mockResolvedValue([attendanceTpl]);
    txAssignmentFindMany.mockResolvedValue([regAssigned("tpl_att", "reg_6")]);
    txRunCreate.mockRejectedValue(new Error("still broken"));

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.gaveUp).toBe(1);
    const upd = registrationUpdate.mock.calls[0][0];
    expect(upd.data.certAutoIssueAttempts).toBe(5);
    expect(upd.data.certAutoIssueCheckedAt).toBe(NOW);
    expect(upd.data.certAutoIssueNextAttemptAt).toBeNull();
  });
});
