/**
 * The golden task set's grading module is pure (e2e/agent-golden/_grade.ts)
 * and mirrors a few source constants by value, because Playwright's test
 * files resolve no "@/" alias. This suite pins the predicates and asserts
 * the mirrored values still agree with src/lib/agent, so a gate or approval
 * change cannot silently make the golden set grade against stale rules.
 */
import { describe, expect, it, vi } from "vitest";
import {
  accountIndex,
  approvalRequests,
  calledBefore,
  chargedTokens,
  CODES,
  findErrorCode,
  findRefusal,
  mentionsAll,
  mentionsAny,
  mentionsNumber,
  neverCalled,
  onlyWrites,
  parseSse,
  ranApproved,
  ranWrites,
  replyText,
  summarise,
  summaryMarkdown,
  T,
  WRITE_CAP,
  type GoldenStep,
  type TaskReportLine,
} from "../../e2e/agent-golden/_grade";
import { EV, GOLDEN_ADMINS, GOLDEN_USER_EMAILS, READ_COUNTS, READ_REGISTRATIONS } from "../../e2e/agent-golden/_seed-constants";
import { MAX_WRITES_PER_REQUEST } from "@/lib/agent/tool-gate";
import { APPROVAL_REQUIRED_CODE, requiresApproval } from "@/lib/agent/approvals";
import { collectToolsForActor } from "@/lib/agent/tool-registry";

vi.mock("@/lib/db", () => ({ db: {}, dbOperator: {} }));

function step(tool: string, outcome = "RAN", extra: Partial<GoldenStep> = {}): GoldenStep {
  return { seq: 0, tool, outcome, code: null, write: !/^(list_|get_|search_)/.test(tool), approved: false, durationMs: 1, ...extra };
}

describe("mirrored constants agree with the source", () => {
  it("WRITE_CAP is the gate's MAX_WRITES_PER_REQUEST", () => {
    expect(WRITE_CAP).toBe(MAX_WRITES_PER_REQUEST);
  });

  it("the approval code matches the loop's", () => {
    expect(CODES.APPROVAL_REQUIRED).toBe(APPROVAL_REQUIRED_CODE);
  });

  it("every tool a grader names is registered for an admin on the in-app door", () => {
    // The budget tools register only while the procurement flag is on; the
    // golden run inherits it from .env.local, the unit environment does not.
    vi.stubEnv("PROCUREMENT_MODULE_ENABLED", "true");
    try {
      const registered = new Set(
        collectToolsForActor({
          organizationId: "org",
          actor: { userId: "u1", role: "ADMIN", fromApiKey: false },
          source: "agent",
        }).map((t) => t.name),
      );
      const missing = Object.values(T).filter((name) => !registered.has(name));
      expect(missing).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the approval specs target tools that actually pause", () => {
    for (const name of [T.send_bulk_email, T.upsert_sponsors, T.update_cme_settings, T.replace_session_speakers, T.delete_promo_code]) {
      expect(requiresApproval(name), name).toBe(true);
    }
    expect(requiresApproval(T.create_track)).toBe(false);
  });
});

describe("seed constants", () => {
  it("golden events have distinct ids, slugs and codes", () => {
    const events = Object.values(EV);
    for (const key of ["id", "slug", "code", "name"] as const) {
      expect(new Set(events.map((e) => e[key])).size, key).toBe(events.length);
    }
  });

  it("golden accounts are distinct and the pool is large enough for a run", () => {
    expect(new Set(GOLDEN_USER_EMAILS).size).toBe(GOLDEN_USER_EMAILS.length);
    // ~45 requests per run at 20 per user per hour needs at least three admins; eight leaves room for repeats.
    expect(GOLDEN_ADMINS.length).toBeGreaterThanOrEqual(3);
  });

  it("READ_COUNTS is derived from READ_REGISTRATIONS", () => {
    const notCancelled = READ_REGISTRATIONS.filter((r) => r.status !== "CANCELLED");
    expect(READ_COUNTS.total).toBe(READ_REGISTRATIONS.length);
    expect(READ_COUNTS.notCancelled).toBe(notCancelled.length);
    expect(READ_COUNTS.confirmed).toBe(READ_REGISTRATIONS.filter((r) => r.status === "CONFIRMED").length);
    expect(READ_COUNTS.owing).toBe(notCancelled.filter((r) => r.paymentStatus === "UNPAID").length);
  });
});

describe("parseSse", () => {
  it("reads data frames, skips blanks, comments and partial JSON", () => {
    const body = [
      `data: {"type":"tool_start","name":"list_tracks","input":{},"toolUseId":"t1"}`,
      ``,
      `: keepalive`,
      ``,
      `data: {"type":"text_delta","text":"Hel"}`,
      `data: {"type":"text_delta","text":"lo"}`,
      ``,
      `data: {"type":"needs_approval","toolName":"send_bulk_email","label":"Send a bulk email","input":{"subject":"x"},"token":"tok","expiresAt":"2026-09-22T10:00:00Z","toolUseId":"t2"}`,
      ``,
      `data: {"type":"text_delta","text":`,
      ``,
      `data: {"type":"done"}`,
      ``,
    ].join("\n");
    const events = parseSse(body);
    expect(events.map((e) => e.type)).toEqual(["tool_start", "text_delta", "text_delta", "needs_approval", "done"]);
    expect(replyText(events)).toBe("Hello");
    expect(approvalRequests(events)).toEqual([
      { toolName: "send_bulk_email", label: "Send a bulk email", input: { subject: "x" }, token: "tok", expiresAt: "2026-09-22T10:00:00Z" },
    ]);
  });
});

describe("sequence predicates", () => {
  const steps = [
    step(T.list_tracks),
    step(T.create_track),
    step(T.create_track),
    step(T.create_speaker, "REFUSED", { code: CODES.READ_ONLY_ROLE }),
    step(T.send_bulk_email, "APPROVAL_REQUESTED", { code: CODES.APPROVAL_REQUIRED }),
    step(T.create_registration, "ERROR", { code: CODES.TICKET_TYPE_IS_FACULTY }),
  ];

  it("calledBefore needs both tools and the right order", () => {
    expect(calledBefore(steps, T.list_tracks, T.create_track)).toBe(true);
    expect(calledBefore(steps, T.create_track, T.list_tracks)).toBe(false);
    expect(calledBefore(steps, T.list_tracks, T.list_events)).toBe(false);
    expect(calledBefore(steps, T.list_events, T.create_track)).toBe(false);
  });

  it("neverCalled reports the offenders, any outcome", () => {
    expect(neverCalled(steps, [T.send_bulk_email, T.list_events])).toEqual([T.send_bulk_email]);
    expect(neverCalled(steps, [T.list_events])).toEqual([]);
  });

  it("ranWrites counts only writes that RAN; onlyWrites names the unexpected ones", () => {
    expect(ranWrites(steps).map((s) => s.tool)).toEqual([T.create_track, T.create_track]);
    expect(onlyWrites(steps, [T.create_track])).toEqual([]);
    expect(onlyWrites(steps, [])).toEqual([T.create_track]);
  });

  it("refusals and error codes are found by code", () => {
    expect(findRefusal(steps, CODES.READ_ONLY_ROLE)?.tool).toBe(T.create_speaker);
    expect(findRefusal(steps, CODES.WRITE_LIMIT)).toBeUndefined();
    expect(findErrorCode(steps, CODES.TICKET_TYPE_IS_FACULTY)?.tool).toBe(T.create_registration);
  });

  it("ranApproved needs RAN plus the approved flag", () => {
    const run2 = [step(T.send_bulk_email, "RAN", { approved: true }), step(T.send_bulk_email, "RAN")];
    expect(ranApproved(run2, T.send_bulk_email)).toHaveLength(1);
  });
});

describe("reply matching", () => {
  it("mentionsAll and mentionsAny ignore case", () => {
    expect(mentionsAll("Dr Omar HADDAD and Nadia Farouk", ["haddad", "Farouk"])).toBe(true);
    expect(mentionsAll("Dr Omar Haddad", ["haddad", "Farouk"])).toBe(false);
    expect(mentionsAny("nothing here", ["x", "HERE"])).toBe(true);
  });

  it("mentionsNumber matches a whole number only", () => {
    expect(mentionsNumber("4 confirmed, 2 owe", 4)).toBe(true);
    expect(mentionsNumber("14 confirmed", 4)).toBe(false);
    expect(mentionsNumber("confirmed: 4.", 4)).toBe(true);
    expect(mentionsNumber("42", 4)).toBe(false);
  });
});

describe("accounts and tokens", () => {
  it("accountIndex is stable, in range, and moves with the repeat index", () => {
    const a = accountIndex("W1 create three tracks", 0, 8);
    expect(a).toBe(accountIndex("W1 create three tracks", 0, 8));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(8);
    expect(accountIndex("W1 create three tracks", 1, 8)).not.toBe(a);
    expect(accountIndex("anything", 3, 1)).toBe(0);
  });

  it("chargedTokens excludes cache reads", () => {
    expect(chargedTokens({ inputTokens: 10, outputTokens: 5, cacheCreationTokens: 3 })).toBe(18);
  });
});

describe("summary", () => {
  const line = (over: Partial<TaskReportLine>): TaskReportLine => ({
    title: "t",
    file: "f.spec.ts",
    status: "passed",
    account: "a@test.local",
    repeat: 0,
    runIds: ["r1"],
    model: "claude-sonnet-4-6",
    turns: 2,
    toolCalls: 1,
    writes: 0,
    refusals: 0,
    approvalsRequested: 0,
    approvalsRun: 0,
    toolErrors: 0,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 1000,
    cacheCreationTokens: 0,
    durationMs: 3000,
    wallMs: 4000,
    ...over,
  });

  it("counts passes, failures and skips and computes the rate over graded tasks", () => {
    const s = summarise([line({}), line({ title: "u", status: "failed", error: "boom\nmore" }), line({ title: "v", status: "skipped" })]);
    expect(s).toMatchObject({ tasks: 3, passed: 1, failed: 1, skipped: 1, passRate: 50, chargedTokens: 360, cacheReadTokens: 3000 });
    expect(s.failures).toEqual([{ title: "u", error: "boom\nmore" }]);
    expect(s.models).toEqual(["claude-sonnet-4-6"]);
  });

  it("renders a markdown table with one row per task and a failures list", () => {
    const md = summaryMarkdown([line({}), line({ title: "u", status: "failed", error: "boom" })]);
    expect(md).toContain("| pass | t |");
    expect(md).toContain("| failed | u |");
    expect(md).toContain("- u: boom");
    expect(md).toContain("pass rate 50%");
  });
});
