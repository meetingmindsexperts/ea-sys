/**
 * daily-digest worker — ONE infrastructure health email per day.
 *
 * The third leg of the monitoring stool, and the only one that tells you
 * "nothing broke" rather than "something did":
 *
 *   1. CloudWatch alarms → SNS → email    — fires when a host metric crosses
 *                                            a threshold (CPU/disk/mem/status).
 *   2. `notifyAdminAlert` (admin-alert.ts) — fires on every `apiLogger.error()`.
 *   3. THIS                                — a scheduled summary, sent whether
 *                                            or not anything happened.
 *
 * Silence from (1) and (2) is ambiguous: a healthy night and a dead alerting
 * pipeline look identical in an inbox. A digest that arrives every morning
 * makes the absence of a digest itself a signal.
 *
 * ── Scope: INFRASTRUCTURE ONLY (owner decision, Aug 6 2026) ─────────────
 * Host metrics, alarms, errors, worker jobs, queues, backups/DR, email
 * deliverability, deploys. Deliberately NOT registration/revenue numbers —
 * those live on the dashboard and would turn an ops signal into a report.
 *
 * ── The verdict is computed, never written by the model ─────────────────
 * `assessInfra()` is a pure function over the snapshot and is the single
 * source of truth for OK / WARN / CRITICAL. The AI writes prose ON TOP of an
 * already-decided verdict and cannot change it, because the failure mode that
 * matters for a daily email is a model softening the one line that needed to
 * be alarming. If the model is unavailable, the digest still sends — with the
 * numbers and no prose. Losing the summary is a cosmetic loss; losing the
 * report is the thing this job exists to prevent.
 *
 * ── No-throw contract ───────────────────────────────────────────────────
 * Every section of `getInfraSnapshot()` carries its own status/error, so a
 * failed AWS call degrades that ROW to "unavailable" instead of killing the
 * email. The tick itself logs at error (which pages via admin-alert) only if
 * the send itself fails — a digest that silently stops arriving is exactly
 * the ambiguity above.
 */

import { getInfraSnapshot, type InfraSnapshot } from "@/lib/infra/aws-ops";
import { EXPECTED_JOBS, JOB_UNDERRUN_RATIO } from "@/lib/worker-jobs";
import { apiLogger } from "@/lib/logger";

// ── Thresholds ───────────────────────────────────────────────────────────
// Deliberately TIGHTER than the CloudWatch alarms (disk 80, mem 85, CPU 90,
// credits 100) so the digest gives a day or two of warning before the pager
// does. A number that shows up amber here for a week is the useful signal.
export const DIGEST_THRESHOLDS = {
  diskWarnPercent: 70,
  memWarnPercent: 80,
  cpuWarnPercent: 60,
  cpuCreditsWarn: 200,
  /** Errors in 24h above which this stops being noise and becomes an incident. */
  errorStormCount: 50,
  /** AWS starts asking questions above ~5% bounce / ~0.1% complaint. */
  sesBounceRateWarn: 0.05,
  sesComplaintRateWarn: 0.001,
  /**
   * How far back a failed email still colours THIS MORNING's digest.
   *
   * The snapshot fetches 7 days (EMAIL_FAILURE_WINDOW_DAYS in aws-ops) because
   * /admin/infra is the drill-down and wants the history. A daily email is a
   * different question ("what happened since yesterday?"), and reporting a
   * 7-day window in it meant ONE failure turned the digest amber for seven
   * consecutive mornings, reading each time like a fresh problem.
   */
  emailFailureLookbackDays: 2,
  /**
   * How many recent workflow runs the digest considers when deciding whether a
   * deploy is broken.
   *
   * Same mismatch, worse: the snapshot holds the last 10 runs with NO time
   * bound, so during a quiet week a single red run stays in the window and
   * holds the digest amber indefinitely. Bounding by COUNT rather than time is
   * deliberate, because deploys are bursty (10 runs spanned 28h in one direction and
   * 3 days in the other), so "the last 3" tracks "did the most recent work
   * land?" better than any fixed number of hours would.
   */
  deployLookbackRuns: 3,
} as const;

export type Severity = "critical" | "warn";
export type Verdict = "critical" | "warn" | "ok";

export interface Finding {
  severity: Severity;
  /** Short noun phrase — the thing that is wrong. */
  label: string;
  /** One sentence of plain English: what it means / what to do. */
  detail: string;
}

export interface Assessment {
  verdict: Verdict;
  findings: Finding[];
  /**
   * Human-readable names of the sections whose data could not be fetched.
   *
   * Reported in the email rather than silently dropped: an unreadable section
   * is NOT a healthy one, and the whole value of a daily "all clear" is that
   * it means everything was actually checked.
   */
  unavailable: string[];
}

/** Snapshot keys are code; the email is read by a human. */
const SECTION_LABELS: Record<string, string> = {
  alarms: "host alarms",
  database: "database",
  worker: "background worker",
  jobs: "scheduled jobs",
  metrics: "server metrics",
  errorTrend: "error counts",
  backup: "database backups",
  dr: "disaster-recovery copies",
  queues: "queues",
  ses: "email delivery",
  emailFailures: "failed emails",
  deploys: "deploys",
  alerts: "alert settings",
};

function pct(n: number | null): string {
  return n == null ? "unknown" : `${n.toFixed(1)}%`;
}

/**
 * Pure verdict engine. Exported for tests — this is the part that must never
 * drift, so it is unit-pinned rather than exercised only through the send path.
 */
export function assessInfra(snap: InfraSnapshot): Assessment {
  const findings: Finding[] = [];
  const unavailable: string[] = [];

  const note = (section: string, s: { status: string }) => {
    if (s.status !== "ok") unavailable.push(SECTION_LABELS[section] ?? section);
  };

  // ── Host alarms ────────────────────────────────────────────────────────
  note("alarms", snap.alarms);
  for (const a of snap.alarms.inAlarm) {
    findings.push({
      severity: "critical",
      label: `Alarm firing: ${a.name}`,
      detail: a.reason || `The ${a.metric} alarm is in ALARM state.`,
    });
  }

  // ── Database + worker liveness ─────────────────────────────────────────
  note("database", snap.database);
  if (snap.database.status === "ok" && snap.database.info?.connected === false) {
    findings.push({
      severity: "critical",
      label: "Database unreachable",
      detail: "The app could not open a connection to Postgres.",
    });
  }

  note("worker", snap.worker);
  if (snap.worker.status === "ok" && snap.worker.info) {
    if (!snap.worker.info.reachable) {
      findings.push({
        severity: "critical",
        label: "Background worker unreachable",
        detail:
          "Scheduled emails, certificates and syncs are not running. Check the ea-sys-worker container.",
      });
    } else if (snap.worker.info.staleJobs.length > 0) {
      findings.push({
        severity: "warn",
        label: `${snap.worker.info.staleJobs.length} worker job(s) overdue`,
        detail: `Not ticking on schedule: ${snap.worker.info.staleJobs.join(", ")}.`,
      });
    }
  }

  // ── Cron job outcomes ──────────────────────────────────────────────────
  note("jobs", snap.jobs);
  const expectedRuns = new Map(EXPECTED_JOBS.map((j) => [j.name, j.expectedPerDay]));
  for (const j of snap.jobs.rows) {
    if (j.failed24h > 0) {
      findings.push({
        severity: "critical",
        label: `Job failing: ${j.job}`,
        detail: `${j.failed24h} failed run(s) in 24h${j.lastError ? ` — ${j.lastError}` : ""}.`,
      });
    }

    // Under-running: the job is not FAILING, it is quietly not happening often
    // enough. Deliberately its own check, because every other signal answers
    // "did the last run succeed?" and would call this healthy — which is how a
    // pooler lock leak kept scheduled-emails at 435 of 1,440 runs a day for
    // months while every dashboard showed green. Skipped for cadences longer
    // than the 24h window (expectedPerDay 0).
    const expected = expectedRuns.get(j.job) ?? 0;
    if (expected > 0) {
      const actual = j.ok24h + j.failed24h;
      // max(1, …) matters for the daily jobs: floor(1 * 0.8) is 0, so without
      // it a once-a-day job that never ran at all would clear the bar. The
      // floor for anything scheduled within the window is "at least once".
      const floorRuns = Math.max(1, Math.floor(expected * JOB_UNDERRUN_RATIO));
      if (actual < floorRuns) {
        findings.push({
          severity: "warn",
          label: `Job under-running: ${j.job} (${actual} of ~${expected})`,
          detail:
            `Runs ${j.cadence || "on a schedule"} but only ticked ${actual} times in 24h. ` +
            "Not failing — skipping. Usual cause is a held advisory lock or worker restarts.",
        });
      }
    }
  }

  // ── Host metrics (early warning, below the alarm thresholds) ───────────
  note("metrics", snap.metrics);
  for (const m of snap.metrics.values) {
    if (m.value == null) continue;
    if (m.label === "Disk" && m.value >= DIGEST_THRESHOLDS.diskWarnPercent) {
      findings.push({
        severity: "warn",
        label: `Disk at ${pct(m.value)}`,
        detail: "The alarm fires at 80%. Check the weekly docker prune is still running.",
      });
    }
    if (m.label === "Memory" && m.value >= DIGEST_THRESHOLDS.memWarnPercent) {
      findings.push({
        severity: "warn",
        label: `Memory at ${pct(m.value)}`,
        detail: "The alarm fires at 85%.",
      });
    }
    if (m.label === "CPU" && m.value >= DIGEST_THRESHOLDS.cpuWarnPercent) {
      findings.push({
        severity: "warn",
        label: `CPU at ${pct(m.value)}`,
        detail: "Sustained load well above the ~4% baseline.",
      });
    }
    if (
      m.label === "CPU credits" &&
      m.value <= DIGEST_THRESHOLDS.cpuCreditsWarn
    ) {
      findings.push({
        severity: "warn",
        label: `CPU credits down to ${m.value.toFixed(0)}`,
        detail:
          "A burstable instance throttles hard at zero. Sustained load is spending faster than it earns.",
      });
    }
  }

  // ── Errors + warnings in the last 24h ──────────────────────────────────
  note("errorTrend", snap.errorTrend);
  // Warnings are reported as a number in the facts block but deliberately do
  // NOT move the verdict — warn-level lines are routine (a rejected input, a
  // rate-limited client), and letting them colour the email amber every day
  // would make the colour meaningless.
  const errors24h = snap.errorTrend.buckets.reduce((n, b) => n + b.errors, 0);
  if (errors24h >= DIGEST_THRESHOLDS.errorStormCount) {
    findings.push({
      severity: "critical",
      label: `${errors24h} errors in 24h`,
      detail:
        "That is a storm, not background noise. Open /logs and filter to errors.",
    });
  } else if (errors24h > 0) {
    findings.push({
      severity: "warn",
      label: `${errors24h} error(s) in 24h`,
      detail: "Each one also sent its own alert email when it happened.",
    });
  }

  // ── Backups + disaster recovery ────────────────────────────────────────
  note("backup", snap.backup);
  if (snap.backup.status === "ok" && snap.backup.info?.stale) {
    findings.push({
      severity: "critical",
      label: "Database backup is stale",
      detail: `Newest dump is ${
        snap.backup.info.ageHours == null
          ? "of unknown age"
          : `${snap.backup.info.ageHours.toFixed(0)}h old`
      }. Backups run hourly — this means the job is broken.`,
    });
  }

  note("dr", snap.dr);
  for (const d of snap.dr.rows) {
    if (d.stale) {
      findings.push({
        severity: "critical",
        label: `DR stream stale: ${d.label}`,
        detail: `Expected within ${d.staleAfterHours}h; newest is ${
          d.ageHours == null ? "missing" : `${d.ageHours.toFixed(0)}h old`
        }.`,
      });
    }
  }

  // ── Queues ─────────────────────────────────────────────────────────────
  note("queues", snap.queues);
  for (const q of snap.queues.rows) {
    if (q.value > q.warnAbove) {
      findings.push({
        severity: "warn",
        label: `${q.label}: ${q.value}`,
        detail: q.hint,
      });
    }
  }

  // ── Email deliverability ───────────────────────────────────────────────
  note("ses", snap.ses);
  if (snap.ses.status === "ok" && snap.ses.info) {
    const s = snap.ses.info;
    if (!s.sendingEnabled) {
      findings.push({
        severity: "critical",
        label: "Email sending is DISABLED",
        detail: "AWS has paused sending on this account. Nothing is going out.",
      });
    }
    if (s.bounceRate != null && s.bounceRate > DIGEST_THRESHOLDS.sesBounceRateWarn) {
      findings.push({
        severity: "warn",
        label: `Bounce rate ${(s.bounceRate * 100).toFixed(1)}%`,
        detail: "AWS suspends accounts that stay above ~5%.",
      });
    }
    if (
      s.complaintRate != null &&
      s.complaintRate > DIGEST_THRESHOLDS.sesComplaintRateWarn
    ) {
      findings.push({
        severity: "warn",
        label: `Complaint rate ${(s.complaintRate * 100).toFixed(2)}%`,
        detail: "Recipients are marking mail as spam. AWS acts above ~0.1%.",
      });
    }
  }

  note("emailFailures", snap.emailFailures);
  // Only the recent slice colours the digest. See emailFailureLookbackDays.
  // A row with an unparseable `at` is COUNTED rather than dropped: this decides
  // whether to raise an alarm, so an unreadable timestamp must not silence one.
  const emailCutoff =
    Date.now() - DIGEST_THRESHOLDS.emailFailureLookbackDays * 24 * 60 * 60 * 1000;
  const recentEmailFailures = snap.emailFailures.rows.filter((r) => {
    const at = Date.parse(r.at);
    return Number.isNaN(at) || at >= emailCutoff;
  });
  if (recentEmailFailures.length > 0) {
    findings.push({
      severity: "warn",
      label: `${recentEmailFailures.length} email(s) failed to send in the last ${DIGEST_THRESHOLDS.emailFailureLookbackDays} days`,
      detail: "Someone did not receive something they were meant to.",
    });
  }

  // ── Deploys ────────────────────────────────────────────────────────────
  note("deploys", snap.deploys);
  // Only the most recent few runs colour the digest. See deployLookbackRuns.
  // `runs` arrives newest-first from the GitHub API.
  for (const d of snap.deploys.runs.slice(0, DIGEST_THRESHOLDS.deployLookbackRuns)) {
    if (d.conclusion && d.conclusion !== "success" && d.conclusion !== "skipped") {
      findings.push({
        severity: "warn",
        label: `Deploy ${d.conclusion} (in the last ${DIGEST_THRESHOLDS.deployLookbackRuns} runs): ${d.title}`,
        detail: `${d.url} — prod may not be running the newest commit.`,
      });
      break; // one is enough; the rest is scrollback
    }
  }

  // ── Alerts silenced ────────────────────────────────────────────────────
  note("alerts", snap.alerts);
  const silencedUntil = snap.alerts.info?.silencedUntil;
  if (silencedUntil && new Date(silencedUntil).getTime() > Date.now()) {
    findings.push({
      severity: "warn",
      label: "Error alerts are silenced",
      detail: `No error emails will arrive until ${silencedUntil}. This digest still will.`,
    });
  }

  const verdict: Verdict = findings.some((f) => f.severity === "critical")
    ? "critical"
    : findings.length > 0
      ? "warn"
      : "ok";

  return { verdict, findings, unavailable };
}

// ── AI summary ───────────────────────────────────────────────────────────

const SUMMARY_TIMEOUT_MS = 25_000;

const SUMMARY_SYSTEM = `You write the opening two or three sentences of a daily server-health email for a non-engineer who runs an events business.

Rules:
- The verdict (OK / NEEDS ATTENTION / CRITICAL) has ALREADY been decided by monitoring code and is shown below your text. Never contradict it, never reassure past it, never downplay a listed problem.
- Plain English. No jargon, no bullet points, no headings, no markdown, no greeting, no sign-off.
- If there are no problems, say so briefly and mention one concrete number that shows the system is healthy.
- If there are problems, lead with the most serious one and say what it means in practice.
- Two or three sentences. Never more.`;

/**
 * Ask the model for a plain-English opener.
 *
 * FAILURE-ISOLATED BY CONTRACT: returns null on any problem (no key, provider
 * down, timeout, empty response). The caller sends the digest regardless.
 */
export async function buildAiSummary(
  assessment: Assessment,
  facts: string,
): Promise<string | null> {
  try {
    const [{ getAiProvider }, { resolveAnthropicApiKey }, { getModelConfig }] =
      await Promise.all([
        import("@/lib/ai"),
        import("@/lib/ai/credentials"),
        import("@/lib/ai/config"),
      ]);

    // Master/operator scope: this is a platform-health email about OUR box,
    // not a tenant's, so it resolves the platform key (org key → env).
    const apiKey = await resolveAnthropicApiKey(null);
    const config = getModelConfig("helpChat", "anthropic");
    const provider = getAiProvider("anthropic");

    const verdictLabel =
      assessment.verdict === "ok"
        ? "OK"
        : assessment.verdict === "warn"
          ? "NEEDS ATTENTION"
          : "CRITICAL";

    const problems =
      assessment.findings.length === 0
        ? "No problems detected."
        : assessment.findings
            .map((f) => `- [${f.severity.toUpperCase()}] ${f.label}: ${f.detail}`)
            .join("\n");

    const userText = `Verdict: ${verdictLabel}\n\nProblems detected:\n${problems}\n\nToday's numbers:\n${facts}`;

    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), SUMMARY_TIMEOUT_MS),
    );

    const collect = (async () => {
      let text = "";
      for await (const event of provider.streamChat({
        model: config.model,
        system: [{ text: SUMMARY_SYSTEM }],
        messages: [{ role: "user", content: userText }],
        maxTokens: 300,
        temperature: 0.2,
        apiKey,
      })) {
        if (event.type === "text") text += event.delta;
      }
      return text.trim() || null;
    })();

    const result = await Promise.race([collect, timeout]);
    if (!result) {
      apiLogger.warn({ msg: "daily-digest:summary-empty-or-timed-out" });
      return null;
    }
    return result;
  } catch (err) {
    // A missing/rejected key, a provider outage, a model change — none of
    // these are worth losing the report over.
    apiLogger.warn({ msg: "daily-digest:summary-failed", err });
    return null;
  }
}

// ── Rendering ────────────────────────────────────────────────────────────

const VERDICT_META: Record<Verdict, { label: string; mark: string; color: string }> =
  {
    ok: { label: "All clear", mark: "🟢", color: "#16a34a" },
    warn: { label: "Needs attention", mark: "🟠", color: "#d97706" },
    critical: { label: "Critical", mark: "🔴", color: "#dc2626" },
  };

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(value: number | null, unit: string): string {
  if (value == null) return "—";
  const n = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${n}${unit}`;
}

/** The number block, shared by the email body and the model's prompt. */
export function buildFacts(snap: InfraSnapshot): string[] {
  const lines: string[] = [];

  if (snap.metrics.status === "ok") {
    for (const m of snap.metrics.values) {
      lines.push(`${m.label}: ${fmt(m.value, m.unit)}`);
    }
  }

  if (snap.errorTrend.status === "ok") {
    const e = snap.errorTrend.buckets.reduce((n, b) => n + b.errors, 0);
    const w = snap.errorTrend.buckets.reduce((n, b) => n + b.warns, 0);
    lines.push(`Errors (24h): ${e}`);
    lines.push(`Warnings (24h): ${w}`);
  }

  if (snap.abuse.status === "ok") {
    for (const a of snap.abuse.rows) lines.push(`${a.label} (24h): ${a.value}`);
  }

  if (snap.jobs.status === "ok") {
    const ok = snap.jobs.rows.reduce((n, j) => n + j.ok24h, 0);
    const failed = snap.jobs.rows.reduce((n, j) => n + j.failed24h, 0);
    lines.push(`Scheduled job runs (24h): ${ok} ok, ${failed} failed`);
  }

  if (snap.backup.status === "ok" && snap.backup.info) {
    lines.push(
      `Newest database backup: ${
        snap.backup.info.ageHours == null
          ? "unknown"
          : `${snap.backup.info.ageHours.toFixed(1)}h old`
      }`,
    );
  }

  if (snap.ses.status === "ok" && snap.ses.info) {
    lines.push(`Emails sent (24h): ${snap.ses.info.send24h ?? "—"}`);
    if (snap.ses.info.bounceRate != null) {
      lines.push(`Bounce rate: ${(snap.ses.info.bounceRate * 100).toFixed(2)}%`);
    }
  }

  if (snap.database.status === "ok" && snap.database.info?.latencyMs != null) {
    lines.push(`Database latency: ${snap.database.info.latencyMs}ms`);
  }

  lines.push(`Running build: ${snap.build.gitShaShort}`);

  return lines;
}

export interface RenderedDigest {
  subject: string;
  html: string;
  text: string;
}

export function renderDigest(
  snap: InfraSnapshot,
  assessment: Assessment,
  summary: string | null,
  appUrl: string,
): RenderedDigest {
  const meta = VERDICT_META[assessment.verdict];
  const date = new Date(snap.generatedAt).toISOString().slice(0, 10);
  const subject = `${meta.mark} EA-SYS daily health — ${meta.label} (${date})`;
  const facts = buildFacts(snap);

  // ── Plain text (the fallback part, and what a watch/phone preview shows) ──
  const textParts: string[] = [
    `EA-SYS daily health — ${meta.label}`,
    date,
    "",
  ];
  if (summary) textParts.push(summary, "");
  if (assessment.findings.length > 0) {
    textParts.push("NEEDS LOOKING AT");
    for (const f of assessment.findings) {
      textParts.push(`  ${f.severity === "critical" ? "!!" : "! "} ${f.label}`);
      textParts.push(`     ${f.detail}`);
    }
    textParts.push("");
  } else {
    textParts.push("No problems detected in the last 24 hours.", "");
  }
  textParts.push("NUMBERS", ...facts.map((l) => `  ${l}`), "");
  if (assessment.unavailable.length > 0) {
    textParts.push(
      `Could not read: ${assessment.unavailable.join(", ")} (these were not checked).`,
      "",
    );
  }
  textParts.push(`Full dashboard: ${appUrl}/admin/infra`);
  const text = textParts.join("\n");

  // ── HTML ────────────────────────────────────────────────────────────────
  const findingsHtml =
    assessment.findings.length > 0
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 24px;">
          ${assessment.findings
            .map(
              (f) => `<tr>
              <td style="padding:10px 12px;border-left:3px solid ${
                f.severity === "critical" ? "#dc2626" : "#d97706"
              };background:#fafafa;">
                <div style="font-weight:600;font-size:14px;color:#111;">${esc(f.label)}</div>
                <div style="font-size:13px;color:#555;margin-top:2px;">${esc(f.detail)}</div>
              </td></tr>
              <tr><td style="height:6px;line-height:6px;">&nbsp;</td></tr>`,
            )
            .join("")}
        </table>`
      : `<p style="margin:0 0 24px;padding:12px;background:#f0fdf4;border-left:3px solid #16a34a;font-size:14px;color:#166534;">
          No problems detected in the last 24 hours.
        </p>`;

  const factsHtml = facts
    .map((line) => {
      const idx = line.indexOf(":");
      const k = idx === -1 ? line : line.slice(0, idx);
      const v = idx === -1 ? "" : line.slice(idx + 1).trim();
      return `<tr>
        <td style="padding:6px 0;font-size:13px;color:#666;">${esc(k)}</td>
        <td style="padding:6px 0;font-size:13px;color:#111;text-align:right;font-variant-numeric:tabular-nums;">${esc(v)}</td>
      </tr>`;
    })
    .join("");

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;">
  <div style="border-bottom:3px solid ${meta.color};padding-bottom:12px;margin-bottom:20px;">
    <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#888;">EA-SYS daily health</div>
    <div style="font-size:22px;font-weight:700;color:${meta.color};margin-top:4px;">${meta.mark} ${esc(meta.label)}</div>
    <div style="font-size:13px;color:#888;margin-top:2px;">${esc(date)} · build ${esc(snap.build.gitShaShort)}</div>
  </div>

  ${
    summary
      ? `<p style="font-size:15px;line-height:1.55;margin:0 0 22px;color:#222;">${esc(summary)}</p>`
      : `<p style="font-size:13px;line-height:1.5;margin:0 0 22px;color:#888;font-style:italic;">
          (The written summary was unavailable this morning — the numbers below are unaffected.)
        </p>`
  }

  ${findingsHtml}

  <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#888;margin:0 0 8px;">Numbers</div>
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 24px;">
    ${factsHtml}
  </table>

  ${
    assessment.unavailable.length > 0
      ? `<p style="font-size:12px;color:#b45309;margin:0 0 20px;">
          Could not read: ${esc(assessment.unavailable.join(", "))} — these were <strong>not</strong> checked.
        </p>`
      : ""
  }

  <a href="${esc(appUrl)}/admin/infra" style="display:inline-block;padding:10px 16px;background:#00aade;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Open the dashboard</a>

  <p style="font-size:11px;color:#aaa;margin:24px 0 0;line-height:1.5;">
    Sent once a day whether or not anything happened — if this stops arriving, that is itself worth checking.
  </p>
</div>`;

  return { subject, html, text };
}

// ── Tick ─────────────────────────────────────────────────────────────────

export interface DigestTickResult {
  verdict: Verdict;
  findingCount: number;
  hadSummary: boolean;
  recipients: number;
  sent: boolean;
}

export function digestRecipients(): string[] {
  return (process.env.ALERT_EMAIL_TO ?? "krishna@meetingmindsdubai.com")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function runDailyDigestTick(): Promise<DigestTickResult> {
  const startedAt = Date.now();

  // force=true — the 60s dashboard cache would otherwise let the digest
  // report numbers from whenever an admin last opened /admin/infra.
  // Explicit platform scope (item 5): this email is the operator's, so its
  // counters are totals across every tenant. It is also the default, but
  // saying so here means a future default flip cannot silently narrow the
  // digest to one org while still sending daily and looking healthy.
  const snap = await getInfraSnapshot(true, { kind: "platform" });
  const assessment = assessInfra(snap);
  const facts = buildFacts(snap);

  const summary = await buildAiSummary(assessment, facts.join("\n"));

  const appUrl = (
    process.env.NEXT_PUBLIC_APP_URL ?? "https://events.meetingmindsgroup.com"
  ).replace(/\/+$/, "");
  const { subject, html, text } = renderDigest(snap, assessment, summary, appUrl);

  const recipients = digestRecipients();
  if (recipients.length === 0) {
    apiLogger.warn({ msg: "daily-digest:no-recipients" });
    return {
      verdict: assessment.verdict,
      findingCount: assessment.findings.length,
      hadSummary: summary != null,
      recipients: 0,
      sent: false,
    };
  }

  const { sendEmail } = await import("@/lib/email");
  await sendEmail({
    to: recipients.map((email) => ({ email })),
    from: {
      email: (process.env.ALERT_EMAIL_FROM ?? "alerts@meetingmindsexperts.com").trim(),
      name: "EA-SYS Health",
    },
    subject,
    htmlContent: html,
    textContent: text,
    // Deliberately entity-less: this goes to operators about the platform, not
    // to anyone with a detail sheet to attach it to.
    noEntityContext: true,
    emailType: "daily_digest",
    stream: "transactional",
    // Deliberately no logContext (same as admin-alert): an out-of-band
    // operator ping, not an entity-bound email — and without a logContext
    // sendEmail writes no EmailLog row, so a daily copy of this never
    // accumulates in the table the prune job has to sweep.
  });

  apiLogger.info({
    msg: "daily-digest:sent",
    verdict: assessment.verdict,
    findingCount: assessment.findings.length,
    unavailable: assessment.unavailable,
    hadSummary: summary != null,
    recipients: recipients.length,
    durationMs: Date.now() - startedAt,
  });

  return {
    verdict: assessment.verdict,
    findingCount: assessment.findings.length,
    hadSummary: summary != null,
    recipients: recipients.length,
    sent: true,
  };
}
