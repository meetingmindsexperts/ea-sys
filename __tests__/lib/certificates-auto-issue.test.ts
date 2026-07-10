/**
 * Phase 2 — survey-gated certificate auto-issue.
 * Covers the pure routing (constraint C: ATTENDANCE→registration tags,
 * APPRECIATION→speaker tags) and the sweep's enqueue / idempotency /
 * retry-backoff behavior.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const registrationFindMany = vi.fn();
const registrationUpdate = vi.fn();
const certificateTemplateFindMany = vi.fn();
const speakerFindFirst = vi.fn();

const txIssuedCertFindFirst = vi.fn();
const txRunItemFindFirst = vi.fn();
const txRunCreate = vi.fn();
const txRunItemCreate = vi.fn();
const txRegistrationUpdate = vi.fn();

const tx = {
  issuedCertificate: { findFirst: (...a: unknown[]) => txIssuedCertFindFirst(...a) },
  certificateIssueRunItem: {
    findFirst: (...a: unknown[]) => txRunItemFindFirst(...a),
    create: (...a: unknown[]) => txRunItemCreate(...a),
  },
  certificateIssueRun: { create: (...a: unknown[]) => txRunCreate(...a) },
  registration: { update: (...a: unknown[]) => txRegistrationUpdate(...a) },
};

vi.mock("@/lib/db", () => ({
  db: {
    registration: {
      findMany: (...a: unknown[]) => registrationFindMany(...a),
      update: (...a: unknown[]) => registrationUpdate(...a),
    },
    certificateTemplate: { findMany: (...a: unknown[]) => certificateTemplateFindMany(...a) },
    speaker: { findFirst: (...a: unknown[]) => speakerFindFirst(...a) },
    $transaction: (cb: (t: typeof tx) => unknown) => cb(tx),
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { selectAutoIssueTargets, runAutoIssueSweep } from "@/lib/certificates/auto-issue";

const attendanceTpl = {
  id: "tpl_att",
  category: "ATTENDANCE" as const,
  autoIssueTag: "delegate",
  emailSubject: null,
  emailBody: null,
};
const appreciationTpl = {
  id: "tpl_app",
  category: "APPRECIATION" as const,
  autoIssueTag: "speaker",
  emailSubject: "Thanks",
  emailBody: "<p>Thanks</p>",
};

describe("selectAutoIssueTargets (constraint C routing)", () => {
  it("ATTENDANCE matches attendee tags → registration recipient", () => {
    const t = selectAutoIssueTargets([attendanceTpl], ["delegate"], null);
    expect(t).toEqual([{ templateId: "tpl_att", category: "ATTENDANCE", recipient: "registration" }]);
  });

  it("APPRECIATION matches speaker tags → speaker recipient", () => {
    const t = selectAutoIssueTargets([appreciationTpl], [], ["speaker"]);
    expect(t).toEqual([{ templateId: "tpl_app", category: "APPRECIATION", recipient: "speaker" }]);
  });

  it("APPRECIATION never matches when there is no linked speaker", () => {
    const t = selectAutoIssueTargets([appreciationTpl], ["speaker"], null);
    expect(t).toEqual([]);
  });

  it("a person who is both gets both certs routed to the right recipient", () => {
    const t = selectAutoIssueTargets([attendanceTpl, appreciationTpl], ["delegate"], ["speaker"]);
    expect(t).toEqual([
      { templateId: "tpl_att", category: "ATTENDANCE", recipient: "registration" },
      { templateId: "tpl_app", category: "APPRECIATION", recipient: "speaker" },
    ]);
  });

  it("a template with no tag never matches (no mass-issue)", () => {
    const t = selectAutoIssueTargets(
      [{ ...attendanceTpl, autoIssueTag: null }],
      ["delegate"],
      null,
    );
    expect(t).toEqual([]);
  });

  it("non-matching tag → no target", () => {
    expect(selectAutoIssueTargets([attendanceTpl], ["vip"], null)).toEqual([]);
  });
});

const NOW = new Date("2026-06-25T12:00:00Z");

beforeEach(() => {
  [
    registrationFindMany, registrationUpdate, certificateTemplateFindMany, speakerFindFirst,
    txIssuedCertFindFirst, txRunItemFindFirst, txRunCreate, txRunItemCreate, txRegistrationUpdate,
  ].forEach((m) => m.mockReset());
  txIssuedCertFindFirst.mockResolvedValue(null);
  txRunItemFindFirst.mockResolvedValue(null);
  txRunCreate.mockResolvedValue({ id: "run_new" });
  txRunItemCreate.mockResolvedValue({ id: "item_new" });
  txRegistrationUpdate.mockResolvedValue({});
  registrationUpdate.mockResolvedValue({});
  speakerFindFirst.mockResolvedValue(null);
});

describe("runAutoIssueSweep", () => {
  it("enqueues an ATTENDANCE auto-run for a matching registration + stamps checkedAt", async () => {
    registrationFindMany.mockResolvedValue([
      {
        id: "reg_1",
        eventId: "evt_1",
        certAutoIssueAttempts: 0,
        attendee: { title: "DR", firstName: "Jane", lastName: "Doe", email: "j@x.com", tags: ["delegate"] },
      },
    ]);
    certificateTemplateFindMany.mockResolvedValue([attendanceTpl]);

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

  it("routes APPRECIATION to the linked speaker (companion case)", async () => {
    registrationFindMany.mockResolvedValue([
      {
        id: "reg_2",
        eventId: "evt_1",
        certAutoIssueAttempts: 0,
        attendee: { title: null, firstName: "Sam", lastName: "Lee", email: "s@x.com", tags: [] },
      },
    ]);
    certificateTemplateFindMany.mockResolvedValue([appreciationTpl]);
    speakerFindFirst.mockResolvedValueOnce({
      id: "spk_2", title: "PROF", firstName: "Sam", lastName: "Lee", email: "s@x.com", tags: ["speaker"],
    });

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.runsCreated).toBe(1);
    const itemArg = txRunItemCreate.mock.calls[0][0].data;
    expect(itemArg.speakerId).toBe("spk_2");
    expect(itemArg.registrationId).toBeNull();
  });

  it("bundles a committee+speaker person into ONE run + ONE person-keyed item (one email)", async () => {
    registrationFindMany.mockResolvedValue([
      {
        id: "reg_5",
        eventId: "evt_1",
        certAutoIssueAttempts: 0,
        attendee: { title: "DR", firstName: "Jane", lastName: "Doe", email: "j@x.com", tags: ["delegate"] },
      },
    ]);
    certificateTemplateFindMany.mockResolvedValue([attendanceTpl, appreciationTpl]);
    speakerFindFirst.mockResolvedValueOnce({
      id: "spk_5", title: "DR", firstName: "Jane", lastName: "Doe", email: "j@x.com", tags: ["speaker"],
    });

    const res = await runAutoIssueSweep({ now: NOW });

    // ONE run covering both templates — not two 1-template runs.
    expect(txRunCreate).toHaveBeenCalledTimes(1);
    const runArg = txRunCreate.mock.calls[0][0].data;
    expect(runArg.templateIds).toEqual(["tpl_att", "tpl_app"]);
    expect(runArg.certificateTemplateId).toBeNull();
    // Multi bundle → null cover snapshot (send phase uses the MULTI defaults).
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

  it("a single surviving target keeps its template's own cover email snapshot", async () => {
    registrationFindMany.mockResolvedValue([
      {
        id: "reg_6", eventId: "evt_1", certAutoIssueAttempts: 0,
        attendee: { title: null, firstName: "Sam", lastName: "Lee", email: "s@x.com", tags: [] },
      },
    ]);
    certificateTemplateFindMany.mockResolvedValue([appreciationTpl]);
    speakerFindFirst.mockResolvedValueOnce({
      id: "spk_6", title: null, firstName: "Sam", lastName: "Lee", email: "s@x.com", tags: ["speaker"],
    });

    await runAutoIssueSweep({ now: NOW });

    const runArg = txRunCreate.mock.calls[0][0].data;
    expect(runArg.certificateTemplateId).toBe("tpl_app");
    expect(runArg.templateIds).toEqual(["tpl_app"]);
    expect(runArg.emailSubject).toBe("Thanks");
    expect(runArg.emailBody).toBe("<p>Thanks</p>");
  });

  it("drops an already-covered target but still bundles the remaining one", async () => {
    registrationFindMany.mockResolvedValue([
      {
        id: "reg_7", eventId: "evt_1", certAutoIssueAttempts: 0,
        attendee: { title: null, firstName: "A", lastName: "B", email: "a@x.com", tags: ["delegate"] },
      },
    ]);
    certificateTemplateFindMany.mockResolvedValue([attendanceTpl, appreciationTpl]);
    speakerFindFirst.mockResolvedValueOnce({
      id: "spk_7", title: null, firstName: "A", lastName: "B", email: "a@x.com", tags: ["speaker"],
    });
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
      {
        id: "reg_3", eventId: "evt_1", certAutoIssueAttempts: 0,
        attendee: { title: null, firstName: "A", lastName: "B", email: "a@x.com", tags: ["delegate"] },
      },
    ]);
    certificateTemplateFindMany.mockResolvedValue([attendanceTpl]);
    txIssuedCertFindFirst.mockResolvedValue({ id: "cert_existing" });

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.runsCreated).toBe(0);
    expect(txRunCreate).not.toHaveBeenCalled();
    // still terminally stamped (idempotent resolve)
    expect(txRegistrationUpdate).toHaveBeenCalled();
    expect(res.resolved).toBe(1);
  });

  it("terminally resolves + counts skippedNoTemplates when the event has no auto-issue templates", async () => {
    registrationFindMany.mockResolvedValue([
      { id: "reg_4", eventId: "evt_1", certAutoIssueAttempts: 0, attendee: { firstName: "X", lastName: "Y", email: "x@x.com", tags: [] } },
    ]);
    certificateTemplateFindMany.mockResolvedValue([]);

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.skippedNoTemplates).toBe(1);
    expect(res.resolved).toBe(1);
    expect(registrationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "reg_4" }, data: { certAutoIssueCheckedAt: NOW } }),
    );
  });

  it("on a transient failure, defers with backoff + increments attempts (does NOT terminally stamp)", async () => {
    registrationFindMany.mockResolvedValue([
      { id: "reg_5", eventId: "evt_1", certAutoIssueAttempts: 1, attendee: { firstName: "P", lastName: "Q", email: "p@x.com", tags: ["delegate"] } },
    ]);
    certificateTemplateFindMany.mockResolvedValue([attendanceTpl]);
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

  it("gives up terminally after exhausting retries", async () => {
    registrationFindMany.mockResolvedValue([
      { id: "reg_6", eventId: "evt_1", certAutoIssueAttempts: 4, attendee: { firstName: "P", lastName: "Q", email: "p@x.com", tags: ["delegate"] } },
    ]);
    certificateTemplateFindMany.mockResolvedValue([attendanceTpl]);
    txRunCreate.mockRejectedValue(new Error("still broken"));

    const res = await runAutoIssueSweep({ now: NOW });

    expect(res.gaveUp).toBe(1);
    const upd = registrationUpdate.mock.calls[0][0];
    expect(upd.data.certAutoIssueAttempts).toBe(5);
    expect(upd.data.certAutoIssueCheckedAt).toBe(NOW);
    expect(upd.data.certAutoIssueNextAttemptAt).toBeNull();
  });
});
