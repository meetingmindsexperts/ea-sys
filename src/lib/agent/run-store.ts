// Stored runs for the in-app Event Agent (docs/AGENT_ARCHITECTURE_REVIEW.md
// §4.6, the readiness review's O1): one AgentRun per request, one AgentStep
// per tool call. Names, counts, tokens and outcomes only. The message text,
// the tool inputs and the tool results never reach these tables, because
// they carry attendee data; the message is recorded as a length.
//
// Failure-isolated by contract: a run that cannot be recorded still runs.
// startAgentRun returns a no-op recorder when the insert fails, every step
// write is fire-and-forget with a logged catch, and finish() never throws.

import type { AgentRunOutcome, AgentStepOutcome } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";

export interface AgentRunStart {
  organizationId: string;
  userId: string;
  role: string;
  eventId: string | null;
  /** Which door the request came through. */
  route: "org" | "event";
  /** Length of the person's message; the text itself is never stored. */
  messageLength: number;
  historyPairs: number;
  /** The tool the request carried an approved call for, if any. */
  approvedTool?: string | null;
  model?: string | null;
}

export interface AgentStepRecord {
  tool: string;
  outcome: AgentStepOutcome;
  /** A short machine code; anything that is not one is dropped. */
  code?: string | null;
  write: boolean;
  approved: boolean;
  durationMs: number;
}

/** The subset of the SDK's usage block the run keeps. */
export interface AgentTurnUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export type AgentRunEnd = Exclude<AgentRunOutcome, "RUNNING">;

export interface AgentRunRecorder {
  /** The run row's id, or null when nothing is being recorded. */
  readonly id: string | null;
  step(record: AgentStepRecord): void;
  turn(usage: AgentTurnUsage | null | undefined): void;
  finish(outcome: AgentRunEnd, errorClass?: string): Promise<void>;
}

/** Codes are identifiers (READ_ONLY_ROLE, WRITE_LIMIT, EVENT_NOT_FOUND); free text is not. */
const CODE_RE = /^[A-Z][A-Z0-9_]{1,39}$/;

export function sanitizeStepCode(code: unknown): string | null {
  return typeof code === "string" && CODE_RE.test(code) ? code : null;
}

/** Reads a tool's `{ code }` out of its JSON result text, if it has one. */
export function stepCodeFromResult(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { code?: unknown } | null;
    return sanitizeStepCode(parsed?.code);
  } catch {
    return null;
  }
}

export const NOOP_RECORDER: AgentRunRecorder = {
  id: null,
  step() {},
  turn() {},
  async finish() {},
};

interface Counters {
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
}

/** Counts a step into the run's totals; exported so the rule is testable without a database. */
export function countStep(c: Counters, s: AgentStepRecord): void {
  c.toolCalls++;
  if (s.outcome === "RAN" || s.outcome === "ERROR") {
    if (s.write) c.writes++;
    if (s.approved) c.approvalsRun++;
  }
  if (s.outcome === "REFUSED") c.refusals++;
  if (s.outcome === "APPROVAL_REQUESTED") c.approvalsRequested++;
  if (s.outcome === "ERROR" || s.outcome === "UNKNOWN_TOOL") c.toolErrors++;
}

export function emptyCounters(): Counters {
  return {
    turns: 0,
    toolCalls: 0,
    writes: 0,
    refusals: 0,
    approvalsRequested: 0,
    approvalsRun: 0,
    toolErrors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

export async function startAgentRun(input: AgentRunStart): Promise<AgentRunRecorder> {
  const startedAt = new Date();
  let id: string;
  try {
    const row = await runWithTenant(input.organizationId, () =>
      db.agentRun.create({
        data: {
          organizationId: input.organizationId,
          userId: input.userId,
          role: input.role,
          eventId: input.eventId,
          route: input.route,
          source: "agent",
          messageLength: input.messageLength,
          historyPairs: input.historyPairs,
          approvedTool: input.approvedTool ?? null,
          model: input.model ?? null,
          startedAt,
        },
        select: { id: true },
      }),
    );
    id = row.id;
  } catch (err) {
    apiLogger.warn({ err, msg: "agent-run:start-failed", organizationId: input.organizationId, userId: input.userId });
    return NOOP_RECORDER;
  }

  const c = emptyCounters();
  let seq = 0;
  let finished = false;

  return {
    id,
    step(record) {
      countStep(c, record);
      const row = {
        runId: id,
        organizationId: input.organizationId,
        seq: seq++,
        tool: record.tool.slice(0, 100),
        outcome: record.outcome,
        code: sanitizeStepCode(record.code),
        write: record.write,
        approved: record.approved,
        durationMs: Math.max(0, Math.round(record.durationMs)),
      };
      void runWithTenant(input.organizationId, () => db.agentStep.create({ data: row, select: { id: true } })).catch((err) => {
        apiLogger.warn({ err, msg: "agent-run:step-write-failed", runId: id, tool: row.tool });
      });
    },
    turn(usage) {
      c.turns++;
      if (!usage) return;
      c.inputTokens += usage.input_tokens ?? 0;
      c.outputTokens += usage.output_tokens ?? 0;
      c.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
      c.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
    },
    async finish(outcome, errorClass) {
      if (finished) return;
      finished = true;
      const finishedAt = new Date();
      try {
        // Compound where: the org bind is atomic with the write.
        const res = await runWithTenant(input.organizationId, () =>
          db.agentRun.updateMany({
            where: { id, organizationId: input.organizationId },
            data: {
              outcome,
              errorClass: errorClass ?? null,
              ...c,
              finishedAt,
              durationMs: finishedAt.getTime() - startedAt.getTime(),
            },
          }),
        );
        if (res.count !== 1) {
          apiLogger.warn({ msg: "agent-run:finish-missed", runId: id, count: res.count });
        }
      } catch (err) {
        apiLogger.warn({ err, msg: "agent-run:finish-failed", runId: id });
      }
    },
  };
}
