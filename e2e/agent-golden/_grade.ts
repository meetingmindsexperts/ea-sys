/**
 * Grading for the Event Agent golden task set (readiness review E2): pure
 * functions over the SSE frames a request returned and the AgentStep rows
 * the run recorded. No Playwright, no Prisma, no network, so
 * __tests__/lib/agent-golden-grade.test.ts pins every predicate.
 *
 * A task passes on three things the review named: the final database
 * state (the spec queries it), the tool sequence (calledBefore, onlyWrites),
 * and calls that must not happen (neverCalled, no APPROVAL_REQUESTED, no
 * RAN write). Grading is code, never another model.
 *
 * The constants below mirror src/lib/agent (tool-gate.ts, approvals.ts,
 * the registrations service) by VALUE rather than by import, because
 * Playwright's test files resolve no "@/" alias; the unit test asserts they
 * still agree with the source.
 */

/** src/lib/agent/tool-gate.ts MAX_WRITES_PER_REQUEST. */
export const WRITE_CAP = 20;

/** Machine codes the gate, the loop and the registration service emit. */
export const CODES = {
  READ_ONLY_ROLE: "READ_ONLY_ROLE",
  WRITE_LIMIT: "WRITE_LIMIT",
  ROSTER_FORBIDDEN: "ROSTER_FORBIDDEN",
  FINANCE_FORBIDDEN: "FINANCE_FORBIDDEN",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  TICKET_TYPE_IS_FACULTY: "TICKET_TYPE_IS_FACULTY",
  /** update_event refuses a date, slug, type or timezone change (src/lib/agent/tools/events.ts). */
  FIELD_NOT_ALLOWED: "FIELD_NOT_ALLOWED",
  /** update_registration refuses REFUNDED / PENDING / FAILED as bare flags (tools/_shared.ts). */
  PAYMENT_STATUS_NOT_SETTABLE: "PAYMENT_STATUS_NOT_SETTABLE",
} as const;

/** Every tool name a grader mentions; the unit test checks each is registered. */
export const T = {
  list_events: "list_events",
  search_event: "search_event",
  create_event: "create_event",
  get_event_info: "get_event_info",
  get_event_dashboard: "get_event_dashboard",
  get_event_stats: "get_event_stats",
  list_tracks: "list_tracks",
  create_track: "create_track",
  list_ticket_types: "list_ticket_types",
  list_registrations: "list_registrations",
  list_unpaid_registrations: "list_unpaid_registrations",
  create_registration: "create_registration",
  update_registration: "update_registration",
  update_event: "update_event",
  update_speaker: "update_speaker",
  list_contacts: "list_contacts",
  bulk_update_registration_status: "bulk_update_registration_status",
  list_speakers: "list_speakers",
  list_speaker_agreements: "list_speaker_agreements",
  create_speaker: "create_speaker",
  list_sessions: "list_sessions",
  create_session: "create_session",
  replace_session_speakers: "replace_session_speakers",
  list_abstracts: "list_abstracts",
  list_sponsors: "list_sponsors",
  upsert_sponsors: "upsert_sponsors",
  list_promo_codes: "list_promo_codes",
  create_promo_code: "create_promo_code",
  delete_promo_code: "delete_promo_code",
  send_bulk_email: "send_bulk_email",
  list_email_templates: "list_email_templates",
  create_email_template: "create_email_template",
  duplicate_email_template: "duplicate_email_template",
  update_email_template: "update_email_template",
  update_cme_settings: "update_cme_settings",
  list_rsvps: "list_rsvps",
  list_budget_categories: "list_budget_categories",
  create_budget: "create_budget",
  add_budget_lines: "add_budget_lines",
  list_budgets: "list_budgets",
} as const;

export type ToolName = (typeof T)[keyof typeof T];

export interface GoldenStep {
  seq: number;
  tool: string;
  /** RAN | ERROR | REFUSED | APPROVAL_REQUESTED | UNKNOWN_TOOL */
  outcome: string;
  code: string | null;
  write: boolean;
  approved: boolean;
  durationMs: number;
  input?: unknown;
}

export interface GoldenRun {
  id: string;
  outcome: string;
  errorClass: string | null;
  turns: number;
  toolCalls: number;
  writes: number;
  refusals: number;
  approvalsRequested: number;
  approvalsRun: number;
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  durationMs: number | null;
  model: string | null;
  reply: string | null;
  steps: GoldenStep[];
}

export type SseEvent = { type: string } & Record<string, unknown>;

export interface NeedsApproval {
  toolName: string;
  label: string;
  input: Record<string, unknown>;
  token: string;
  expiresAt: string;
}

/** `data: {json}` frames separated by blank lines; anything else is ignored. */
export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const frame of text.split(/\n\n+/)) {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") {
          events.push(parsed as SseEvent);
        }
      } catch {
        // A partial or non-JSON line is not an event.
      }
    }
  }
  return events;
}

export function replyText(events: SseEvent[]): string {
  return events
    .filter((e) => e.type === "text_delta")
    .map((e) => String(e.text ?? ""))
    .join("");
}

export function approvalRequests(events: SseEvent[]): NeedsApproval[] {
  return events
    .filter((e) => e.type === "needs_approval")
    .map((e) => ({
      toolName: String(e.toolName),
      label: String(e.label ?? e.toolName),
      input: (e.input ?? {}) as Record<string, unknown>,
      token: String(e.token),
      expiresAt: String(e.expiresAt ?? ""),
    }));
}

export function sseError(events: SseEvent[]): string | null {
  const err = events.find((e) => e.type === "error");
  return err ? String(err.message ?? "error") : null;
}

export function allSteps(runs: GoldenRun[]): GoldenStep[] {
  return runs.flatMap((r) => r.steps);
}

export function toolNames(steps: GoldenStep[]): string[] {
  return steps.map((s) => s.tool);
}

export function stepsOf(steps: GoldenStep[], tool: string): GoldenStep[] {
  return steps.filter((s) => s.tool === tool);
}

/** The first call of `first` happens before the first call of `second`; false when either is absent. */
export function calledBefore(steps: GoldenStep[], first: string, second: string): boolean {
  const a = steps.findIndex((s) => s.tool === first);
  const b = steps.findIndex((s) => s.tool === second);
  if (a < 0 || b < 0) return false;
  return a < b;
}

/** Names from `names` that were called at all (any outcome); empty means none were. */
export function neverCalled(steps: GoldenStep[], names: readonly string[]): string[] {
  const called = new Set(steps.map((s) => s.tool));
  return names.filter((n) => called.has(n));
}

/** Write tools that actually RAN, in call order. */
export function ranWrites(steps: GoldenStep[]): GoldenStep[] {
  return steps.filter((s) => s.write && s.outcome === "RAN");
}

/** Write tools that RAN and are not in `allowed`; empty means only the allowed writes ran. */
export function onlyWrites(steps: GoldenStep[], allowed: readonly string[]): string[] {
  const ok = new Set(allowed);
  return [...new Set(ranWrites(steps).map((s) => s.tool).filter((t) => !ok.has(t)))];
}

export function findRefusal(steps: GoldenStep[], code: string): GoldenStep | undefined {
  return steps.find((s) => s.outcome === "REFUSED" && s.code === code);
}

export function findErrorCode(steps: GoldenStep[], code: string): GoldenStep | undefined {
  return steps.find((s) => s.outcome === "ERROR" && s.code === code);
}

export function approvalRequestedFor(steps: GoldenStep[], tool: string): GoldenStep[] {
  return steps.filter((s) => s.tool === tool && s.outcome === "APPROVAL_REQUESTED");
}

export function ranApproved(steps: GoldenStep[], tool: string): GoldenStep[] {
  return steps.filter((s) => s.tool === tool && s.outcome === "RAN" && s.approved);
}

/** Case-insensitive; every needle must appear. */
export function mentionsAll(text: string, needles: readonly string[]): boolean {
  const hay = text.toLowerCase();
  return needles.every((n) => hay.includes(n.toLowerCase()));
}

/** Case-insensitive; at least one needle must appear. */
export function mentionsAny(text: string, needles: readonly string[]): boolean {
  const hay = text.toLowerCase();
  return needles.some((n) => hay.includes(n.toLowerCase()));
}

/** A whole number appears as its own token ("4 confirmed", not "14"). */
export function mentionsNumber(text: string, n: number): boolean {
  return new RegExp(`(^|[^\\d])${n}([^\\d]|$)`).test(text);
}

/**
 * Which admin runs a task: a stable hash of the title spread over the pool,
 * shifted per repeat so `--repeat-each` does not pile every repeat of one
 * task onto one account (20 requests per user per hour is the ceiling).
 */
export function accountIndex(title: string, repeatIndex: number, poolSize: number): number {
  let h = 2166136261;
  for (let i = 0; i < title.length; i++) {
    h ^= title.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h + repeatIndex * 7) % Math.max(1, poolSize);
}

/** One line per task in test-results/agent-golden/tasks.jsonl. */
export interface TaskReportLine {
  title: string;
  file: string;
  status: string;
  account: string;
  repeat: number;
  runIds: string[];
  model: string | null;
  turns: number;
  toolCalls: number;
  writes: number;
  refusals: number;
  approvalsRequested: number;
  approvalsRun: number;
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  durationMs: number;
  wallMs: number;
  error?: string;
}

/** Fresh tokens the run paid for; cache reads are counted separately in the summary. */
export function chargedTokens(line: Pick<TaskReportLine, "inputTokens" | "outputTokens" | "cacheCreationTokens">): number {
  return (line.inputTokens ?? 0) + (line.outputTokens ?? 0) + (line.cacheCreationTokens ?? 0);
}

export function sumChargedTokens(lines: Pick<TaskReportLine, "inputTokens" | "outputTokens" | "cacheCreationTokens">[]): number {
  return lines.reduce((sum, l) => sum + chargedTokens(l), 0);
}

export function runTotals(runs: GoldenRun[]) {
  return runs.reduce(
    (acc, r) => ({
      turns: acc.turns + r.turns,
      toolCalls: acc.toolCalls + r.toolCalls,
      writes: acc.writes + r.writes,
      refusals: acc.refusals + r.refusals,
      approvalsRequested: acc.approvalsRequested + r.approvalsRequested,
      approvalsRun: acc.approvalsRun + r.approvalsRun,
      toolErrors: acc.toolErrors + r.toolErrors,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens + r.cacheCreationTokens,
      durationMs: acc.durationMs + (r.durationMs ?? 0),
    }),
    {
      turns: 0, toolCalls: 0, writes: 0, refusals: 0, approvalsRequested: 0, approvalsRun: 0, toolErrors: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, durationMs: 0,
    },
  );
}

export interface GoldenSummary {
  tasks: number;
  passed: number;
  failed: number;
  skipped: number;
  passRate: number;
  models: string[];
  chargedTokens: number;
  cacheReadTokens: number;
  wallMs: number;
  agentMs: number;
  failures: { title: string; error?: string }[];
}

export function summarise(lines: TaskReportLine[]): GoldenSummary {
  const passed = lines.filter((l) => l.status === "passed").length;
  const failed = lines.filter((l) => l.status === "failed" || l.status === "timedOut" || l.status === "interrupted").length;
  const skipped = lines.filter((l) => l.status === "skipped").length;
  const graded = passed + failed;
  return {
    tasks: lines.length,
    passed,
    failed,
    skipped,
    passRate: graded === 0 ? 0 : Math.round((passed / graded) * 1000) / 10,
    models: [...new Set(lines.map((l) => l.model).filter((m): m is string => !!m))],
    chargedTokens: sumChargedTokens(lines),
    cacheReadTokens: lines.reduce((s, l) => s + (l.cacheReadTokens ?? 0), 0),
    wallMs: lines.reduce((s, l) => s + (l.wallMs ?? 0), 0),
    agentMs: lines.reduce((s, l) => s + (l.durationMs ?? 0), 0),
    failures: lines
      .filter((l) => l.status !== "passed" && l.status !== "skipped")
      .map((l) => ({ title: l.title, error: l.error })),
  };
}

/** A markdown table of the summary for the console and summary.md. */
export function summaryMarkdown(lines: TaskReportLine[]): string {
  const s = summarise(lines);
  const rows = lines.map(
    (l) =>
      `| ${l.status === "passed" ? "pass" : l.status} | ${l.title} | ${l.turns} | ${l.toolCalls} | ${l.writes} | ${l.approvalsRequested}/${l.approvalsRun} | ${chargedTokens(l)} | ${l.cacheReadTokens} | ${Math.round(l.durationMs / 100) / 10}s |`,
  );
  return [
    `# Agent golden task set`,
    ``,
    `Tasks ${s.tasks}, passed ${s.passed}, failed ${s.failed}, skipped ${s.skipped}, pass rate ${s.passRate}%.`,
    `Model ${s.models.join(", ") || "(none recorded)"}. Charged tokens ${s.chargedTokens}, cache reads ${s.cacheReadTokens}, agent time ${Math.round(s.agentMs / 1000)}s, wall ${Math.round(s.wallMs / 1000)}s.`,
    ``,
    `| result | task | turns | tool calls | writes | approvals asked/run | charged tokens | cache reads | agent time |`,
    `|---|---|---|---|---|---|---|---|---|`,
    ...rows,
    ...(s.failures.length
      ? [``, `## Failures`, ``, ...s.failures.map((f) => `- ${f.title}: ${(f.error ?? "").split("\n")[0]}`)]
      : []),
    ``,
  ].join("\n");
}
