// Stored runs for the in-app Event Agent (docs/AGENT_ARCHITECTURE_REVIEW.md
// §4.6, the readiness review's O1): one AgentRun per request, one AgentStep
// per tool call. Names, counts, tokens and outcomes, and since Sep 21, 2026
// (owner decision: "I need messages list, hold off on chat") the person's
// message, the agent's reply and each tool call's input, for the SUPER_ADMIN
// /admin/agent-messages page. Tool RESULTS are still never stored: they are
// the largest attendee-data payload and nobody asked for them. The text that
// is stored carries attendee data, which is why the page is operator-only and
// the rows leave with the 180-day prune; the bounds below keep one runaway
// request from writing megabytes.
//
// Failure-isolated by contract: a run that cannot be recorded still runs.
// startAgentRun returns a no-op recorder when the insert fails, every step
// write is fire-and-forget with a logged catch, and finish() never throws.

import type { AgentRunOutcome, AgentStepOutcome, Prisma } from "@prisma/client";
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
  /** The person's message, stored up to MAX_STORED_MESSAGE_LENGTH. */
  message: string;
  /** Length of the person's message, kept for the counts. */
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
  /** The tool's exact input; bounded by boundStepInput before it is written. */
  input?: unknown;
}

/** What finish() may add to the row beyond the outcome. */
export interface AgentRunFinishExtra {
  /** The agent's reply as the page received it; empty means none. */
  reply?: string;
}

/** The handler caps the message at 2,000; this is the storage bound behind it. */
export const MAX_STORED_MESSAGE_LENGTH = 4000;
/** Characters of the reply kept; a longer one is cut, not dropped. */
export const MAX_STORED_REPLY_LENGTH = 20_000;
/** Serialised characters of a step input kept; a larger one becomes a marker. */
export const MAX_STORED_INPUT_CHARS = 50_000;

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
  finish(outcome: AgentRunEnd, errorClass?: string, extra?: AgentRunFinishExtra): Promise<void>;
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

/**
 * The JSON that lands in AgentStep.input for a tool's input: the input itself
 * when it is plain JSON of a sane size, a marker when it is not. `undefined`
 * means "write nothing", which the row then stores as NULL. A JSON null is
 * treated the same way, since Prisma needs a special value to store one and
 * a null input carries nothing worth a column.
 */
export function boundStepInput(input: unknown): Prisma.InputJsonValue | undefined {
  if (input === undefined || input === null) return undefined;
  let text: string;
  try {
    text = JSON.stringify(input);
  } catch {
    return { unserializable: true };
  }
  if (text === undefined || text === "null") return undefined;
  if (text.length > MAX_STORED_INPUT_CHARS) return { truncated: true, chars: text.length };
  // The round trip drops functions and undefined members, leaving plain JSON.
  return JSON.parse(text) as Prisma.InputJsonValue;
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
          message: input.message.slice(0, MAX_STORED_MESSAGE_LENGTH),
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
      const boundedInput = boundStepInput(record.input);
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
        ...(boundedInput !== undefined ? { input: boundedInput } : {}),
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
    async finish(outcome, errorClass, extra) {
      if (finished) return;
      finished = true;
      const finishedAt = new Date();
      const reply = extra?.reply ? extra.reply.slice(0, MAX_STORED_REPLY_LENGTH) : null;
      try {
        // Compound where: the org bind is atomic with the write.
        const res = await runWithTenant(input.organizationId, () =>
          db.agentRun.updateMany({
            where: { id, organizationId: input.organizationId },
            data: {
              outcome,
              errorClass: errorClass ?? null,
              reply,
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
