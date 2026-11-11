/**
 * Survey-gated certificate auto-issue: the sweep's enqueue / idempotency /
 * retry-backoff behavior, driven by ASSIGNMENTS since Nov 11, 2026 (the pure
 * routing rule is pinned in certificate-assignments.test.ts).
 *
 * Each registration's transaction takes the per-event lock FIRST, then locks
 * and re-reads its own row, then asks planSurveyReleases what to send (the
 * real function here, over a fake transaction: it is also what a confirmation
 * counts with). The order test pins that, because it is what stops an
 * assignment, a cancellation or a survey reset made at the same moment from
 * being missed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const registrationFindMany = vi.fn();
const registrationUpdateMany = vi.fn();
const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));

const calls: string[] = [];
const txLock = vi.fn();
const txRow = vi.fn();
const txTemplateFindMany = vi.fn();
const txRegistrationFindMany = vi.fn();
const txSpeakerFindMany = vi.fn();
const txAssignmentFindMany = vi.fn();
const txIssuedCertFindMany = vi.fn();
const txRunItemFindMany = vi.fn();
const txRunCreate = vi.fn();
const txRunItemCreate = vi.fn();
const txRegistrationUpdate = vi.fn();

const record = <T extends (...a: never[]) => unknown>(name: string, fn: T) =>
  ((...a: Parameters<T>) => {
    calls.push(name);
    return fn(...a);
  }) as T;

const tx = {
  // Two raw statements: the advisory lock, then the row re-read FOR UPDATE.
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("pg_advisory_xact_lock")) {
      calls.push("lock");
      return txLock(sql, ...values);
    }
    calls.push("row");
    return txRow(sql, ...values);
  },
  certificateTemplate: { findMany: record("templates", (...a: unknown[]) => txTemplateFindMany(...a)) },
  speaker: { findMany: record("speakers", (...a: unknown[]) => txSpeakerFindMany(...a)) },
  certificateAssignment: { findMany: record("assignments", (...a: unknown[]) => txAssignmentFindMany(...a)) },
  issuedCertificate: { findMany: (...a: unknown[]) => txIssuedCertFindMany(...a) },
  certificateIssueRunItem: {
    findMany: (...a: unknown[]) => txRunItemFindMany(...a),
    create: (...a: unknown[]) => txRunItemCreate(...a),
  },
  certificateIssueRun: { create: (...a: unknown[]) => txRunCreate(...a) },
  registration: {
    findMany: (...a: unknown[]) => txRegistrationFindMany(...a),
    update: record("stamp", (...a: unknown[]) => txRegistrationUpdate(...a)),
  },
};

// `dbOperator` is the SAME object as `db` here, which is exactly what it is on
// master (one client, one pool). The worker's candidate scan runs on the
// operator lane; every assertion below still drives the same fake delegates.
vi.mock("@/lib/db", () => {
  const client = {
    registration: {
      findMany: (...a: unknown[]) => registrationFindMany(...a),
      updateMany: (...a: unknown[]) => registrationUpdateMany(...a),
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
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: logWarn, error: vi.fn() } }));

import { runAutoIssueSweep } from "@/lib/certificates/auto-issue";

const attendanceTpl = { id: "tpl_att", name: "Attendance", category: "ATTENDANCE" as const };
const appreciationTpl = { id: "tpl_app", name: "Appreciation", category: "APPRECIATION" as const };

/** Assignment rows as the plan's one query returns them. */
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

const speaker = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: null,
  firstName: "Sam",
  lastName: "Lee",
  email: "s@x.com",
  sourceRegistrationId: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  ...over,
});

const candidate = (id: string, attendee: Record<string, unknown>, attempts = 0) => ({
  id,
  eventId: "evt_1",
  organizationId: null,
  certAutoIssueAttempts: attempts,
  attendee,
});

/** The scan's candidates, and the same registrations as the plan reads them. */
function candidates(...rows: ReturnType<typeof candidate>[]) {
  registrationFindMany.mockResolvedValue(rows);
  txRegistrationFindMany.mockImplementation((args: { where: { id: { in: string[] } } }) =>
    Promise.resolve(
      rows
        .filter((r) => args.where.id.in.includes(r.id))
        .map((r) => ({ id: r.id, attendee: { email: (r.attendee.email as string | undefined) ?? null } })),
    ),
  );
}

const STILL_OWED = [{ status: "CONFIRMED", answered: true, checked: false }];
const NOW = new Date("2026-06-25T12:00:00Z");

beforeEach(() => {
  calls.length = 0;
  [
    registrationFindMany, registrationUpdateMany, logWarn, txLock, txRow, txTemplateFindMany,
    txRegistrationFindMany, txSpeakerFindMany, txAssignmentFindMany, txIssuedCertFindMany,
    txRunItemFindMany, txRunCreate, txRunItemCreate, txRegistrationUpdate,
  ].forEach((m) => m.mockReset());
  txLock.mockResolvedValue([]);
  txRow.mockResolvedValue(STILL_OWED);
  txTemplateFindMany.mockResolvedValue([]);
  txRegistrationFindMany.mockResolvedValue([]);
  txSpeakerFindMany.mockResolvedValue([]);
  txAssignmentFindMany.mockResolvedValue([]);
  txIssuedCertFindMany.mockResolvedValue([]);
  txRunItemFindMany.mockResolvedValue([]);
  txRunCreate.mockResolvedValue({ id: "run_new" });
  txRunItemCreate.mockResolvedValue({ id: "item_new" });
  txRegistrationUpdate.mockResolvedValue({});
  registrationUpdateMany.mockResolvedValue({ count: 1 });
});

describe("runAutoIssueSweep", () => {
  it("enqueues an ATTENDANCE auto-run for an assigned registration + stamps checkedAt", async () => {
    candidates(candidate("reg_1", { title: "DR", firstName: "Jane", lastName: "Doe", email: "j@x.com" }));
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
    expect(itemArg.recipientName).toBe("Dr. Jane Doe");
    // terminal stamp inside the tx
    expect(txRegistrationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "reg_1" }, data: { certAutoIssueCheckedAt: NOW, certAutoIssueError: null } }),
    );
  });

  it("takes the per-event lock FIRST, re-reads its own row, reads templates and assignments after, then stamps", async () => {
    candidates(candidate("reg_1", { title: null, firstName: "A", lastName: "B", email: "a@x.com" }));
    txTemplateFindMany.mockResolvedValue([attendanceTpl]);
    txAssignmentFindMany.mockResolvedValue([regAssigned("tpl_att", "reg_1")]);

    await runAutoIssueSweep({ now: NOW });

    // An assignment or a switch-on that commits at the same moment takes the
    // same lock: reading anything before it would let the stamp bury them.
    expect(calls[0]).toBe("lock");
    expect(calls[1]).toBe("row");
    expect(calls.indexOf("templates")).toBeGreaterThan(1);
    expect(calls.indexOf("assignments")).toBeGreaterThan(calls.indexOf("templates"));
    expect(calls[calls.length - 1]).toBe("stamp");
    // The row is locked, so a cancellation or a survey reset waits for the stamp.
    expect(txRow.mock.calls[0][0]).toContain("FOR UPDATE");
    expect(txRow.mock.calls[0][1]).toBe("reg_1");
    // Only auto-issue templates of the registration's own event are considered.
    expect(txTemplateFindMany.mock.calls[0][0].where).toEqual({ eventId: "evt_1", autoIssueOnSurvey: true });
  });

  it.each([
    ["was cancelled", [{ status: "CANCELLED", answered: true, checked: false }]],
    ["had its survey reset", [{ status: "CONFIRMED", answered: false, checked: false }]],
    ["was already handled", [{ status: "CONFIRMED", answered: true, checked: true }]],
    ["was deleted", []],
  ])("M1: a candidate that %s while it waited for the lock is left alone, NOT stamped and NOT sent", async (_what, row) => {
    candidates(candidate("reg_1", { title: null, firstName: "A", lastName: "B", email: "a@x.com" }));
    txTemplateFindMany.mockResolvedValue([attendanceTpl]);
    txAssignmentFindMany.mockResolvedValue([regAssigned("tpl_att", "reg_1")]);
    txRow.mockResolvedValue(row);

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res).toMatchObject({ scanned: 1, skippedChanged: 1, resolved: 0, runsCreated: 0, deferred: 0 });
    expect(txRunCreate).not.toHaveBeenCalled();
    // No stamp: a survey answered again later must be looked at again.
    expect(txRegistrationUpdate).not.toHaveBeenCalled();
    expect(calls).toEqual(["lock", "row"]);
  });

  it("asks for the assignments of THIS registration and its linked speaker only", async () => {
    candidates(candidate("reg_9", { title: null, firstName: "A", lastName: "B", email: "a@x.com" }));
    txTemplateFindMany.mockResolvedValue([attendanceTpl, appreciationTpl]);
    txSpeakerFindMany.mockResolvedValue([speaker("spk_9", { email: "a@x.com" })]);

    await runAutoIssueSweep({ now: NOW });

    expect(txAssignmentFindMany.mock.calls[0][0].where).toEqual({
      certificateTemplateId: { in: ["tpl_att", "tpl_app"] },
      OR: [{ registrationId: { in: ["reg_9"] } }, { speakerId: { in: ["spk_9"] } }],
    });
    // The speaker is looked for inside the registration's own event.
    expect(txSpeakerFindMany.mock.calls[0][0].where).toEqual({
      eventId: "evt_1",
      OR: [{ sourceRegistrationId: { in: ["reg_9"] } }, { email: { in: ["a@x.com"] } }],
    });
  });

  it("sends nothing to a person who answered but is assigned nothing, and still stamps them", async () => {
    candidates(candidate("reg_n", { title: null, firstName: "N", lastName: "O", email: "n@x.com" }));
    txTemplateFindMany.mockResolvedValue([attendanceTpl]);

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.runsCreated).toBe(0);
    expect(txRunCreate).not.toHaveBeenCalled();
    expect(txRegistrationUpdate).toHaveBeenCalled();
    expect(res.resolved).toBe(1);
  });

  it("ignores an assignment that belongs to somebody else", async () => {
    candidates(candidate("reg_1", { title: null, firstName: "A", lastName: "B", email: "a@x.com" }));
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
    candidates(candidate("reg_2", { title: null, firstName: "Sam", lastName: "Lee", email: "s@x.com" }));
    txTemplateFindMany.mockResolvedValue([appreciationTpl]);
    txSpeakerFindMany.mockResolvedValue([speaker("spk_2", { title: "PROF", sourceRegistrationId: "reg_2", email: "other@x.com" })]);
    txAssignmentFindMany.mockResolvedValue([speakerAssigned("tpl_app", "spk_2")]);

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.runsCreated).toBe(1);
    const itemArg = txRunItemCreate.mock.calls[0][0].data;
    expect(itemArg.speakerId).toBe("spk_2");
    expect(itemArg.registrationId).toBeNull();
    expect(itemArg.recipientName).toBe("Prof. Sam Lee");
    expect(itemArg.recipientEmail).toBe("other@x.com");
  });

  it("the companion pointer wins over a speaker who merely shares the address", async () => {
    candidates(candidate("reg_2", { title: null, firstName: "Sam", lastName: "Lee", email: "s@x.com" }));
    txTemplateFindMany.mockResolvedValue([appreciationTpl]);
    txSpeakerFindMany.mockResolvedValue([
      speaker("spk_same_address", { email: "s@x.com" }),
      speaker("spk_companion", { sourceRegistrationId: "reg_2", email: "faculty@x.com" }),
    ]);
    txAssignmentFindMany.mockResolvedValue([
      speakerAssigned("tpl_app", "spk_same_address"),
      speakerAssigned("tpl_app", "spk_companion"),
    ]);

    await runAutoIssueSweep({ now: NOW });

    expect(txRunItemCreate.mock.calls[0][0].data.speakerId).toBe("spk_companion");
  });

  it("an APPRECIATION template assigned to the REGISTRATION does not issue (wrong facet)", async () => {
    candidates(candidate("reg_2", { title: null, firstName: "Sam", lastName: "Lee", email: "s@x.com" }));
    txTemplateFindMany.mockResolvedValue([appreciationTpl]);
    txAssignmentFindMany.mockResolvedValue([regAssigned("tpl_app", "reg_2")]);

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.runsCreated).toBe(0);
    expect(txRunCreate).not.toHaveBeenCalled();
  });

  it("bundles a committee+speaker person into ONE run + ONE person-keyed item (one email)", async () => {
    candidates(candidate("reg_5", { title: "DR", firstName: "Jane", lastName: "Doe", email: "j@x.com" }));
    txTemplateFindMany.mockResolvedValue([attendanceTpl, appreciationTpl]);
    txSpeakerFindMany.mockResolvedValue([speaker("spk_5", { email: "j@x.com" })]);
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
    candidates(candidate("reg_6", { title: null, firstName: "Sam", lastName: "Lee", email: "s@x.com" }));
    txTemplateFindMany.mockResolvedValue([appreciationTpl]);
    txSpeakerFindMany.mockResolvedValue([speaker("spk_6")]);
    txAssignmentFindMany.mockResolvedValue([speakerAssigned("tpl_app", "spk_6")]);

    await runAutoIssueSweep({ now: NOW });

    const runArg = txRunCreate.mock.calls[0][0].data;
    expect(runArg.certificateTemplateId).toBe("tpl_app");
    expect(runArg.templateIds).toEqual(["tpl_app"]);
    expect(runArg.emailSubject).toBeNull();
    expect(runArg.emailBody).toBeNull();
  });

  it("drops an already-covered target but still bundles the remaining one", async () => {
    candidates(candidate("reg_7", { title: null, firstName: "A", lastName: "B", email: "a@x.com" }));
    txTemplateFindMany.mockResolvedValue([attendanceTpl, appreciationTpl]);
    txSpeakerFindMany.mockResolvedValue([speaker("spk_7", { email: "a@x.com" })]);
    txAssignmentFindMany.mockResolvedValue([
      regAssigned("tpl_att", "reg_7"),
      speakerAssigned("tpl_app", "spk_7"),
    ]);
    // The ATTENDANCE cert already exists; APPRECIATION survives.
    txIssuedCertFindMany.mockResolvedValue([{ certificateTemplateId: "tpl_att", registrationId: "reg_7", speakerId: null }]);

    const res = await runAutoIssueSweep({ now: NOW });

    expect(txRunCreate).toHaveBeenCalledTimes(1);
    const runArg = txRunCreate.mock.calls[0][0].data;
    expect(runArg.templateIds).toEqual(["tpl_app"]);
    const itemArg = txRunItemCreate.mock.calls[0][0].data;
    expect(itemArg.registrationId).toBeNull();
    expect(itemArg.speakerId).toBe("spk_7");
    expect(res.runsCreated).toBe(1);
  });

  it("skips enqueue when a cert already exists for the (template, recipient), revoked or not", async () => {
    candidates(candidate("reg_3", { title: null, firstName: "A", lastName: "B", email: "a@x.com" }));
    txTemplateFindMany.mockResolvedValue([attendanceTpl]);
    txAssignmentFindMany.mockResolvedValue([regAssigned("tpl_att", "reg_3")]);
    txIssuedCertFindMany.mockResolvedValue([{ certificateTemplateId: "tpl_att", registrationId: "reg_3", speakerId: null }]);

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.runsCreated).toBe(0);
    expect(txRunCreate).not.toHaveBeenCalled();
    // The held check does not ask about revocation: a revoked certificate is not re-sent by itself.
    expect(txIssuedCertFindMany.mock.calls[0][0].where).not.toHaveProperty("revokedAt");
    // still terminally stamped (idempotent resolve)
    expect(txRegistrationUpdate).toHaveBeenCalled();
    expect(res.resolved).toBe(1);
  });

  it("skips enqueue when a NON-TERMINAL run (manual OR auto) already has a pending item for the target (H3 double-send guard)", async () => {
    candidates(candidate("reg_h3", { title: null, firstName: "A", lastName: "B", email: "a@x.com" }));
    txTemplateFindMany.mockResolvedValue([attendanceTpl]);
    txAssignmentFindMany.mockResolvedValue([regAssigned("tpl_att", "reg_h3")]);
    // No cert yet: the item guard must catch it. A bundle run names the template in templateIds.
    txRunItemFindMany.mockResolvedValue([
      { registrationId: "reg_h3", speakerId: null, run: { certificateTemplateId: null, templateIds: ["tpl_att"] } },
    ]);

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.runsCreated).toBe(0);
    expect(txRunCreate).not.toHaveBeenCalled();
    // The guard must consider ANY non-terminal run (not just autoIssue) and
    // scope to non-terminal statuses so a failed/cancelled run can't strand it.
    const where = txRunItemFindMany.mock.calls[0][0].where;
    expect(where.run.status).toEqual({
      in: ["PENDING", "RENDERING", "AWAITING_REVIEW", "SENDING"],
    });
    expect(where.run.eventId).toBe("evt_1");
    expect(where.run).not.toHaveProperty("autoIssue");
    expect(where.errorPhase).toBeNull();
    expect(res.resolved).toBe(1);
  });

  it("a live run for a DIFFERENT template does not suppress this one", async () => {
    candidates(candidate("reg_h4", { title: null, firstName: "A", lastName: "B", email: "a@x.com" }));
    txTemplateFindMany.mockResolvedValue([attendanceTpl]);
    txAssignmentFindMany.mockResolvedValue([regAssigned("tpl_att", "reg_h4")]);
    txRunItemFindMany.mockResolvedValue([
      { registrationId: "reg_h4", speakerId: null, run: { certificateTemplateId: "tpl_other", templateIds: [] } },
    ]);

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.runsCreated).toBe(1);
  });

  it("terminally resolves + counts skippedNoTemplates when the event has no auto-issue templates", async () => {
    candidates(candidate("reg_4", { firstName: "X", lastName: "Y", email: "x@x.com" }));
    txTemplateFindMany.mockResolvedValue([]);

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.skippedNoTemplates).toBe(1);
    expect(res.resolved).toBe(1);
    // Stamped inside the locked transaction, so a switch turned on at the same
    // moment either was seen or clears the stamp afterwards.
    expect(calls).toEqual(["lock", "row", "templates", "stamp"]);
    expect(txRegistrationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "reg_4" }, data: { certAutoIssueCheckedAt: NOW, certAutoIssueError: null } }),
    );
    expect(txAssignmentFindMany).not.toHaveBeenCalled();
  });

  it("on a transient failure, defers with backoff + increments attempts (does NOT terminally stamp)", async () => {
    candidates(candidate("reg_5", { firstName: "P", lastName: "Q", email: "p@x.com" }, 1));
    txTemplateFindMany.mockResolvedValue([attendanceTpl]);
    txAssignmentFindMany.mockResolvedValue([regAssigned("tpl_att", "reg_5")]);
    txRunCreate.mockRejectedValue(new Error("db blip"));

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.deferred).toBe(1);
    expect(res.gaveUp).toBe(0);
    const upd = registrationUpdateMany.mock.calls[0][0];
    expect(upd.data.certAutoIssueAttempts).toBe(2);
    expect(upd.data.certAutoIssueError).toContain("db blip");
    expect(upd.data.certAutoIssueNextAttemptAt).toBeInstanceOf(Date);
    expect(upd.data.certAutoIssueCheckedAt).toBeUndefined();
  });

  it("M2: the failure write only lands while the row is as the scan read it (not re-opened, not stamped)", async () => {
    candidates(candidate("reg_5", { firstName: "P", lastName: "Q", email: "p@x.com" }, 4));
    txLock.mockRejectedValue(new Error("lock wait timed out"));
    // Staff confirmed an assignment meanwhile: attempts are back to 0, so the guard matches nothing.
    registrationUpdateMany.mockResolvedValue({ count: 0 });

    await runAutoIssueSweep({ now: NOW });

    // Attempt 5 would be the give-up stamp: it must not overwrite the re-open.
    expect(registrationUpdateMany.mock.calls[0][0].where).toEqual({
      id: "reg_5",
      certAutoIssueCheckedAt: null,
      certAutoIssueAttempts: 4,
    });
    expect(logWarn).toHaveBeenCalledWith(expect.objectContaining({ msg: "cert-auto-issue:defer-skipped-row-changed", registrationId: "reg_5" }));
  });

  it("a failure to take the lock is a transient failure like any other", async () => {
    candidates(candidate("reg_l", { firstName: "L", lastName: "K", email: "l@x.com" }));
    txLock.mockRejectedValue(new Error("lock wait timed out"));

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.deferred).toBe(1);
    expect(txRegistrationUpdate).not.toHaveBeenCalled();
    expect(registrationUpdateMany.mock.calls[0][0].data.certAutoIssueError).toContain("lock wait");
  });

  it("gives up terminally after exhausting retries", async () => {
    candidates(candidate("reg_6", { firstName: "P", lastName: "Q", email: "p@x.com" }, 4));
    txTemplateFindMany.mockResolvedValue([attendanceTpl]);
    txAssignmentFindMany.mockResolvedValue([regAssigned("tpl_att", "reg_6")]);
    txRunCreate.mockRejectedValue(new Error("still broken"));

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.gaveUp).toBe(1);
    const upd = registrationUpdateMany.mock.calls[0][0];
    expect(upd.data.certAutoIssueAttempts).toBe(5);
    expect(upd.data.certAutoIssueCheckedAt).toBe(NOW);
    expect(upd.data.certAutoIssueNextAttemptAt).toBeNull();
  });
});
