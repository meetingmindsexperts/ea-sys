/**
 * daily-digest worker (Aug 6, 2026).
 *
 * The properties worth pinning are the ones a future edit could quietly break:
 *   - the verdict is COMPUTED, so an added finding can never leave the email
 *     saying "All clear" (the whole reason the model doesn't decide it);
 *   - the digest SENDS even when the AI summary fails, and even when whole
 *     sections of the snapshot are unavailable — losing the summary is
 *     cosmetic, losing the report defeats the job;
 *   - a section that could not be read is REPORTED as unchecked rather than
 *     silently counting as healthy (the "no news is good news" trap).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InfraSnapshot } from "@/lib/infra/aws-ops";

const { mockSendEmail, mockGetSnapshot, mockStreamChat, mockResolveKey, mockLogger } =
  vi.hoisted(() => ({
    mockSendEmail: vi.fn().mockResolvedValue(undefined),
    mockGetSnapshot: vi.fn(),
    mockStreamChat: vi.fn(),
    mockResolveKey: vi.fn().mockResolvedValue("sk-test"),
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));

vi.mock("@/lib/email", () => ({ sendEmail: mockSendEmail }));
vi.mock("@/lib/infra/aws-ops", () => ({ getInfraSnapshot: mockGetSnapshot }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/ai", () => ({ getAiProvider: () => ({ streamChat: mockStreamChat }) }));
vi.mock("@/lib/ai/credentials", () => ({ resolveAnthropicApiKey: mockResolveKey }));
vi.mock("@/lib/ai/config", () => ({
  getModelConfig: () => ({ model: "m", maxTokens: 300, temperature: 0.2 }),
}));

import {
  assessInfra,
  buildAiSummary,
  buildFacts,
  digestRecipients,
  renderDigest,
  runDailyDigestTick,
  SELF_JOB_NAME,
  SUMMARY_SYSTEM,
} from "@/lib/daily-digest-worker";
import { EXPECTED_JOBS } from "@/lib/worker-jobs";

/** A snapshot with every section present, healthy, and nothing to report. */
function healthySnapshot(): InfraSnapshot {
  return {
    scope: "platform" as const,
    generatedAt: "2026-08-06T05:30:00.000Z",
    region: "ap-south-1",
    build: {
      gitSha: "abc1234567890",
      gitShaShort: "abc1234",
      builtAt: null,
      slot: "green",
      hostname: "box",
    },
    database: { status: "ok", info: { connected: true, latencyMs: 12 } },
    worker: {
      status: "ok",
      info: {
        reachable: true,
        uptimeSeconds: 9999,
        gitSha: "abc1234",
        jobs: [],
        staleJobs: [],
      },
    },
    queues: { status: "ok", rows: [] },
    heartbeat: { status: "ok", info: null },
    errorTrend: { status: "ok", buckets: [{ hour: "05", errors: 0, warns: 3 }] },
    abuse: { status: "ok", rows: [{ label: "Failed logins", value: 2, hint: "" }] },
    dr: {
      status: "ok",
      rows: [
        {
          label: "Database dump",
          prefix: "db/",
          latestAt: "x",
          ageHours: 1,
          staleAfterHours: 18,
          stale: false,
        },
      ],
    },
    backup: {
      status: "ok",
      info: {
        latestKey: "db/x.dump",
        latestAt: "x",
        ageHours: 1.2,
        stale: false,
        bucket: "b",
      },
    },
    alerts: { status: "ok", info: { silencedUntil: null } },
    deploys: { status: "ok", runs: [] },
    ses: {
      status: "ok",
      info: {
        sendingEnabled: true,
        sandbox: false,
        max24Hour: 50000,
        sentLast24Hours: 40,
        maxSendRate: 14,
        bounceRate: 0.001,
        complaintRate: 0,
        send24h: 40,
        bounce24h: 0,
        complaint24h: 0,
      },
    },
    alarms: { status: "ok", inAlarm: [] },
    metrics: {
      status: "ok",
      instanceId: "i-1",
      values: [
        { label: "CPU", value: 4, unit: "%" },
        { label: "CPU credits", value: 864, unit: "" },
        { label: "Memory", value: 30, unit: "%" },
        { label: "Disk", value: 62, unit: "%" },
      ],
    },
    jobs: { status: "ok", workerLastSeen: "x", rows: [] },
    recentErrors: { status: "ok", rows: [] },
    emailFailures: { status: "ok", rows: [] },
  } as InfraSnapshot;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveKey.mockResolvedValue("sk-test");
  mockStreamChat.mockImplementation(async function* () {
    yield { type: "text", delta: "Quiet night. " };
    yield { type: "text", delta: "Nothing needs attention." };
    yield { type: "done", usage: {} };
  });
  process.env.ALERT_EMAIL_TO = "ops@example.com";
});

describe("assessInfra — verdict", () => {
  it("a fully healthy snapshot is OK with no findings", () => {
    const a = assessInfra(healthySnapshot());
    expect(a.verdict).toBe("ok");
    expect(a.findings).toEqual([]);
    expect(a.unavailable).toEqual([]);
  });

  it("an alarm in ALARM is CRITICAL", () => {
    const s = healthySnapshot();
    s.alarms.inAlarm = [
      { name: "ea-sys-ec2-disk-high", metric: "disk_used_percent", reason: "81% > 80", since: null },
    ];
    const a = assessInfra(s);
    expect(a.verdict).toBe("critical");
    expect(a.findings[0].label).toContain("ea-sys-ec2-disk-high");
  });

  it("a failing cron job is CRITICAL and names the job", () => {
    const s = healthySnapshot();
    s.jobs.rows = [
      {
        job: "scheduled-emails",
        cadence: "every minute",
        lastStatus: "FAILED",
        lastRunAt: "x",
        lastDurationMs: 10,
        lastError: "pool timeout",
        ok24h: 100,
        failed24h: 3,
      },
    ];
    const a = assessInfra(s);
    expect(a.verdict).toBe("critical");
    expect(a.findings.some((f) => f.label.includes("scheduled-emails"))).toBe(true);
    expect(a.findings.some((f) => f.detail.includes("pool timeout"))).toBe(true);
  });

  it("flags a job that is SKIPPING rather than failing — the real 2026-08-10 numbers", () => {
    // The pooler advisory-lock leak: nothing failed, the last run was recent,
    // every dashboard was green — and scheduled-emails had run 435 times
    // instead of 1,440 for months. This is the check that would have caught it
    // on day one, so it is pinned to the observed values.
    const s = healthySnapshot();
    s.jobs.rows = [
      {
        job: "scheduled-emails",
        cadence: "every minute",
        lastStatus: "OK",
        lastRunAt: "x",
        lastDurationMs: 40,
        lastError: null,
        ok24h: 435,
        failed24h: 0,
      },
    ];
    const a = assessInfra(s);
    expect(a.verdict).toBe("warn");
    expect(a.findings[0].label).toContain("under-running");
    expect(a.findings[0].label).toContain("435 of ~1440");
    // Must NOT be reported as failing — it isn't, and saying so would send
    // whoever reads it looking in the wrong place.
    expect(a.findings.some((f) => f.label.startsWith("Job failing"))).toBe(false);
  });

  it("never reports the digest itself as under-running", () => {
    // Observed 2026-08-18: a delivered digest whose own body said the digest
    // had not run. recordJobRun writes the JobRun row AFTER the job body, so
    // the tick doing the checking is invisible to its own query, and the
    // previous run sits exactly 24h back — on the window edge. It therefore
    // warns about itself at random.
    //
    // 0 runs is the WORST case (its own row missing and yesterday's fallen out
    // of the window), so that is what this pins.
    const s = healthySnapshot();
    s.jobs.rows = [
      {
        job: SELF_JOB_NAME,
        cadence: "daily 05:30 UTC",
        lastStatus: "OK",
        lastRunAt: "x",
        lastDurationMs: 900,
        lastError: null,
        ok24h: 0,
        failed24h: 0,
      },
    ];
    const a = assessInfra(s);
    expect(a.findings.some((f) => f.label.includes("under-running"))).toBe(false);
    expect(a.verdict).toBe("ok");
  });

  it("still reports the digest as FAILING if it actually failed", () => {
    // The skip above is scoped to the under-run check only. A real failure of
    // this job must still surface — silencing a job entirely to fix a false
    // positive would be the worse bug.
    const s = healthySnapshot();
    s.jobs.rows = [
      {
        job: SELF_JOB_NAME,
        cadence: "daily 05:30 UTC",
        lastStatus: "FAILED",
        lastRunAt: "x",
        lastDurationMs: 900,
        lastError: "boom",
        ok24h: 0,
        failed24h: 1,
      },
    ];
    const a = assessInfra(s);
    expect(a.findings.some((f) => f.label.startsWith("Job failing"))).toBe(true);
  });

  it("SELF_JOB_NAME matches a real registered job, so a rename cannot re-enable the self-check", () => {
    expect(EXPECTED_JOBS.some((j) => j.name === SELF_JOB_NAME)).toBe(true);
  });

  it("the summary prompt forbids inventing consequences", () => {
    // The same 2026-08-18 email claimed "attendees or contacts who should have
    // received it today have not". The digest emails admins; no attendee is
    // involved. The model was given a job name and a count and filled in the
    // rest. The prompt is the only place that can stop it.
    expect(SUMMARY_SYSTEM).toMatch(/never invent/i);
    expect(SUMMARY_SYSTEM).toMatch(/not told what any job does/i);
  });

  it("a job at full cadence is not flagged, and the threshold has deploy headroom", () => {
    const full = healthySnapshot();
    const row = {
      job: "scheduled-emails",
      cadence: "every minute",
      lastStatus: "OK",
      lastRunAt: "x",
      lastDurationMs: 40,
      lastError: null,
      failed24h: 0,
    };
    full.jobs.rows = [{ ...row, ok24h: 1440 }];
    expect(assessInfra(full).verdict).toBe("ok");

    // A handful of deploy restarts must not raise a false alarm.
    const dented = healthySnapshot();
    dented.jobs.rows = [{ ...row, ok24h: 1200 }];
    expect(assessInfra(dented).verdict).toBe("ok");

    // But a real shortfall is caught.
    const short = healthySnapshot();
    short.jobs.rows = [{ ...row, ok24h: 1100 }];
    expect(assessInfra(short).verdict).toBe("warn");
  });

  it("a monthly job is never judged against a 24h window", () => {
    const s = healthySnapshot();
    s.jobs.rows = [
      {
        job: "log-archive",
        cadence: "monthly (1st, 03:30)",
        lastStatus: "OK",
        lastRunAt: "x",
        lastDurationMs: 40,
        lastError: null,
        ok24h: 0,
        failed24h: 0,
      },
    ];
    expect(assessInfra(s).verdict).toBe("ok");
  });

  it("a daily job that did not run at all IS flagged", () => {
    const s = healthySnapshot();
    s.jobs.rows = [
      {
        job: "system-log-prune",
        cadence: "daily 04:45 UTC",
        lastStatus: "OK",
        lastRunAt: "x",
        lastDurationMs: 40,
        lastError: null,
        ok24h: 0,
        failed24h: 0,
      },
    ];
    const a = assessInfra(s);
    expect(a.verdict).toBe("warn");
    expect(a.findings[0].label).toContain("system-log-prune");
  });

  it("a stale database backup is CRITICAL", () => {
    const s = healthySnapshot();
    s.backup.info = { ...s.backup.info!, stale: true, ageHours: 30 };
    expect(assessInfra(s).verdict).toBe("critical");
  });

  it("an unreachable worker is CRITICAL; merely-overdue jobs are only WARN", () => {
    const down = healthySnapshot();
    down.worker.info = { ...down.worker.info!, reachable: false };
    expect(assessInfra(down).verdict).toBe("critical");

    const overdue = healthySnapshot();
    overdue.worker.info = { ...overdue.worker.info!, staleJobs: ["cert-issue"] };
    const a = assessInfra(overdue);
    expect(a.verdict).toBe("warn");
    expect(a.findings[0].detail).toContain("cert-issue");
  });

  it("disk crosses WARN at 70 — below the CloudWatch alarm, so it warns first", () => {
    const below = healthySnapshot();
    below.metrics.values = [{ label: "Disk", value: 69, unit: "%" }];
    expect(assessInfra(below).verdict).toBe("ok");

    const above = healthySnapshot();
    above.metrics.values = [{ label: "Disk", value: 71, unit: "%" }];
    expect(assessInfra(above).verdict).toBe("warn");
  });

  it("a handful of errors is WARN; a storm is CRITICAL", () => {
    const few = healthySnapshot();
    few.errorTrend.buckets = [{ hour: "05", errors: 3, warns: 0 }];
    expect(assessInfra(few).verdict).toBe("warn");

    const storm = healthySnapshot();
    storm.errorTrend.buckets = [{ hour: "05", errors: 60, warns: 0 }];
    expect(assessInfra(storm).verdict).toBe("critical");
  });

  it("silenced error alerts are surfaced, because the operator may have forgotten", () => {
    const s = healthySnapshot();
    s.alerts.info = { silencedUntil: new Date(Date.now() + 3_600_000).toISOString() };
    const a = assessInfra(s);
    expect(a.verdict).toBe("warn");
    expect(a.findings[0].label).toContain("silenced");
  });

  it("an expired silence is NOT reported", () => {
    const s = healthySnapshot();
    s.alerts.info = { silencedUntil: new Date(Date.now() - 3_600_000).toISOString() };
    expect(assessInfra(s).verdict).toBe("ok");
  });

  it("a section that could not be read is listed as unchecked, not treated as healthy", () => {
    const s = healthySnapshot();
    s.backup = { status: "error", error: "AccessDenied", info: null };
    s.alarms = { status: "error", error: "AccessDenied", inAlarm: [] };
    const a = assessInfra(s);
    // Human-readable names, not snapshot keys — the email is read by a person.
    expect(a.unavailable).toEqual(
      expect.arrayContaining(["database backups", "host alarms"]),
    );
    // Unreadable ≠ broken: it must not manufacture a false CRITICAL either.
    expect(a.verdict).toBe("ok");
  });
});

describe("buildAiSummary — failure isolation", () => {
  it("returns the model's prose on the happy path", async () => {
    const a = assessInfra(healthySnapshot());
    await expect(buildAiSummary(a, "CPU: 4%")).resolves.toBe(
      "Quiet night. Nothing needs attention.",
    );
  });

  it("returns null (never throws) when the provider blows up", async () => {
    mockStreamChat.mockImplementation(async function* () {
      throw new Error("provider down");
      yield { type: "done" };
    });
    const a = assessInfra(healthySnapshot());
    await expect(buildAiSummary(a, "x")).resolves.toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "daily-digest:summary-failed" }),
    );
  });

  it("returns null when no API key can be resolved", async () => {
    mockResolveKey.mockRejectedValue(new Error("ANTHROPIC_API_KEY is not set"));
    const a = assessInfra(healthySnapshot());
    await expect(buildAiSummary(a, "x")).resolves.toBeNull();
  });

  it("returns null on an empty completion rather than an empty paragraph", async () => {
    mockStreamChat.mockImplementation(async function* () {
      yield { type: "done", usage: {} };
    });
    const a = assessInfra(healthySnapshot());
    await expect(buildAiSummary(a, "x")).resolves.toBeNull();
  });
});

describe("renderDigest", () => {
  it("puts the computed verdict in the subject, not the model's opinion", () => {
    const s = healthySnapshot();
    s.alarms.inAlarm = [{ name: "a", metric: "m", reason: "r", since: null }];
    const a = assessInfra(s);
    const r = renderDigest(s, a, "Everything looks fine to me!", "https://x.test");
    expect(r.subject).toContain("Critical");
    expect(r.subject).not.toContain("All clear");
  });

  it("says so plainly when the summary is missing, instead of an empty gap", () => {
    const s = healthySnapshot();
    const r = renderDigest(s, assessInfra(s), null, "https://x.test");
    expect(r.html).toContain("summary was unavailable");
    expect(r.text).toContain("No problems detected");
  });

  it("escapes finding text so a log line cannot inject markup", () => {
    const s = healthySnapshot();
    s.alarms.inAlarm = [
      { name: "<img src=x onerror=alert(1)>", metric: "m", reason: "r", since: null },
    ];
    const r = renderDigest(s, assessInfra(s), null, "https://x.test");
    expect(r.html).not.toContain("<img src=x");
    expect(r.html).toContain("&lt;img src=x");
  });

  it("names the unreadable sections in the body", () => {
    const s = healthySnapshot();
    s.ses = { status: "error", error: "denied", info: null };
    const r = renderDigest(s, assessInfra(s), null, "https://x.test");
    expect(r.html).toContain("email delivery");
    expect(r.text).toContain("Could not read");
  });
});

describe("buildFacts", () => {
  it("skips sections that failed rather than printing bogus zeroes", () => {
    const s = healthySnapshot();
    s.metrics = { status: "error", error: "x", instanceId: null, values: [] };
    const facts = buildFacts(s).join("\n");
    expect(facts).not.toContain("CPU:");
    expect(facts).toContain("Errors (24h): 0");
  });
});

describe("runDailyDigestTick", () => {
  it("sends the digest to every configured recipient", async () => {
    process.env.ALERT_EMAIL_TO = "a@x.com, b@x.com";
    mockGetSnapshot.mockResolvedValue(healthySnapshot());
    const res = await runDailyDigestTick();
    expect(res.sent).toBe(true);
    expect(res.verdict).toBe("ok");
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].to).toEqual([
      { email: "a@x.com" },
      { email: "b@x.com" },
    ]);
  });

  it("STILL sends when the AI summary fails — the report is the point", async () => {
    mockGetSnapshot.mockResolvedValue(healthySnapshot());
    mockStreamChat.mockImplementation(async function* () {
      throw new Error("down");
      yield { type: "done" };
    });
    const res = await runDailyDigestTick();
    expect(res.sent).toBe(true);
    expect(res.hadSummary).toBe(false);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it("forces a fresh snapshot so it never reports the dashboard's cached numbers", async () => {
    mockGetSnapshot.mockResolvedValue(healthySnapshot());
    await runDailyDigestTick();
    expect(mockGetSnapshot).toHaveBeenCalledWith(true, { kind: "platform" });
  });

  // The digest is the OPERATOR's email, so its counters must be totals across
  // every tenant. Asserted explicitly because the alternative failure is
  // silent: an org-scoped digest would still arrive daily, still look
  // healthy, and simply under-report.
  it("asks for the platform scope, not one org's numbers", async () => {
    mockGetSnapshot.mockResolvedValue(healthySnapshot());
    await runDailyDigestTick();
    expect(mockGetSnapshot.mock.calls[0][1]).toEqual({ kind: "platform" });
  });

  it("logs and skips instead of throwing when no recipients are configured", async () => {
    process.env.ALERT_EMAIL_TO = "  ,  ";
    mockGetSnapshot.mockResolvedValue(healthySnapshot());
    const res = await runDailyDigestTick();
    expect(res.sent).toBe(false);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "daily-digest:no-recipients" }),
    );
  });
});

describe("digestRecipients", () => {
  it("splits, trims and drops blanks", () => {
    process.env.ALERT_EMAIL_TO = " a@x.com ,, b@x.com ";
    expect(digestRecipients()).toEqual(["a@x.com", "b@x.com"]);
  });
});

/**
 * The digest reads a snapshot built for /admin/infra, which deliberately holds
 * MORE history than a daily email should report (7 days of failed emails, the
 * last 10 workflow runs with no time bound). Before these windows existed, one
 * failure turned the digest amber every morning until it aged out of the
 * SNAPSHOT: seven mornings for an email, and indefinitely for a deploy during
 * a quiet week, each reading like a fresh overnight problem.
 *
 * These tests are about what must NOT fire. Deleting either window makes the
 * "stale" cases below fail, which is the only reason they are worth having.
 */
describe("assessInfra: digest lookback windows", () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

  const emailRow = (at: string) => ({
    to: "a@x.com",
    subject: "s",
    error: "boom",
    templateSlug: null,
    at,
  });

  const run = (conclusion: string | null) => ({
    title: `run ${conclusion}`,
    status: "completed",
    conclusion,
    event: "push",
    createdAt: daysAgo(1),
    url: "https://github.com/x/y/actions/runs/1",
  });

  it("ignores an email failure older than the lookback window", () => {
    const snap = healthySnapshot();
    snap.emailFailures = { status: "ok", rows: [emailRow(daysAgo(5))] };
    const { verdict, findings } = assessInfra(snap);
    expect(verdict).toBe("ok");
    expect(findings).toHaveLength(0);
  });

  it("reports an email failure inside the window, and names the window", () => {
    const snap = healthySnapshot();
    snap.emailFailures = { status: "ok", rows: [emailRow(daysAgo(1))] };
    const { verdict, findings } = assessInfra(snap);
    expect(verdict).toBe("warn");
    expect(findings[0].label).toContain("1 email(s) failed to send in the last 2 days");
  });

  it("counts only the recent rows when the snapshot holds both", () => {
    const snap = healthySnapshot();
    snap.emailFailures = {
      status: "ok",
      rows: [emailRow(daysAgo(1)), emailRow(daysAgo(6)), emailRow(daysAgo(0))],
    };
    const { findings } = assessInfra(snap);
    expect(findings[0].label).toContain("2 email(s)");
  });

  it("counts a row with an unreadable timestamp rather than silencing it", () => {
    // Fail loud: this decides whether to raise an alarm, so an unparseable
    // date must not be the thing that hides a real failure.
    const snap = healthySnapshot();
    snap.emailFailures = { status: "ok", rows: [emailRow("not-a-date")] };
    expect(assessInfra(snap).verdict).toBe("warn");
  });

  it("ignores a deploy failure that has fallen outside the recent runs", () => {
    const snap = healthySnapshot();
    // Newest-first, as the GitHub API returns them: the failure is 4th.
    snap.deploys = {
      status: "ok",
      runs: [run("success"), run("success"), run("success"), run("failure")],
    };
    const { verdict, findings } = assessInfra(snap);
    expect(verdict).toBe("ok");
    expect(findings).toHaveLength(0);
  });

  it("reports a deploy failure still inside the recent runs", () => {
    const snap = healthySnapshot();
    snap.deploys = {
      status: "ok",
      runs: [run("success"), run("success"), run("failure"), run("success")],
    };
    const { verdict, findings } = assessInfra(snap);
    expect(verdict).toBe("warn");
    expect(findings[0].label).toContain("Deploy failure");
  });

  it("does not treat a skipped or still-running deploy as a failure", () => {
    const snap = healthySnapshot();
    snap.deploys = { status: "ok", runs: [run("skipped"), run(null), run("success")] };
    expect(assessInfra(snap).verdict).toBe("ok");
  });
});
