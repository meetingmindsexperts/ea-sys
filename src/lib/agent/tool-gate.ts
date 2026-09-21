// One gate for every tool call the in-app Event Agent makes.
//
// The route used to decide four things inline (read-only role, roster
// PII, finance, the write cap), and the write cap keyed on a hand-written
// list of 14 tool names that missed 11 write tools. Everything is now
// derived from the predicates the authorization boundary already uses, so
// a tool added tomorrow is a write until proven otherwise, and the same
// decision can be reused by the MCP door when both doors share a guardrail
// layer (agent architecture review, §4.5).

import { isReadOnlyTool, isWriteTool, ROSTER_PII_AGENT_TOOLS } from "./tools/_shared";
import { FINANCE_ONLY_AGENT_TOOLS } from "@/lib/finance-visibility";

/** Writes one request may perform. A request is one user message and the
 *  tool loop that answers it; the person sends another message to continue. */
export const MAX_WRITES_PER_REQUEST = 20;

export interface ToolGatePolicy {
  /** MEMBER: every tool that is not a read is refused. */
  readOnly: boolean;
  /** Roles outside canViewFinance: wholly financial tools are refused. */
  blockFinance: boolean;
  /** Write tool calls already run in this request. */
  writesSoFar: number;
  /** Test seam; production uses MAX_WRITES_PER_REQUEST. */
  maxWrites?: number;
}

export type ToolGateDecision =
  | { kind: "run"; write: boolean }
  | { kind: "refuse"; result: { error: string; code: string } };

export function gateToolCall(toolName: string, policy: ToolGatePolicy): ToolGateDecision {
  // Read-only gate for the MEMBER role. isReadOnlyTool fails closed: only
  // list_/get_/search_ pass. The model sees a refusal as an ordinary tool
  // error and relays it.
  if (policy.readOnly && !isReadOnlyTool(toolName)) {
    return {
      kind: "refuse",
      result: {
        error:
          `Read-only access — the Member role cannot perform write operations. ` +
          `"${toolName}" modifies data and was refused. Ask an Organizer or Admin to make this change.`,
        code: "READ_ONLY_ROLE",
      },
    };
  }
  // The dinner-RSVP roster (names, emails, dietary notes) is blocked for
  // MEMBER on the REST roster GET; the agent surface agrees even though the
  // tool is list_-prefixed (review R2 M5).
  if (policy.readOnly && ROSTER_PII_AGENT_TOOLS.has(toolName)) {
    return {
      kind: "refuse",
      result: {
        error:
          `The dinner guest list (names, emails, dietary notes) is not available ` +
          `to the Member role — the same policy as the RSVP roster page. Ask an ` +
          `Organizer or Admin for headcounts.`,
        code: "ROSTER_FORBIDDEN",
      },
    };
  }
  // Wholly financial tools have nothing non-financial to salvage, so they
  // are refused outright rather than redacted to an empty husk.
  if (policy.blockFinance && FINANCE_ONLY_AGENT_TOOLS.has(toolName)) {
    return {
      kind: "refuse",
      result: {
        error:
          `Financial data is not available to your role. "${toolName}" returns ` +
          `invoice / payment data, which the Member (read-only viewer) role cannot access.`,
        code: "FINANCE_FORBIDDEN",
      },
    };
  }
  const write = isWriteTool(toolName);
  const maxWrites = policy.maxWrites ?? MAX_WRITES_PER_REQUEST;
  if (write && policy.writesSoFar >= maxWrites) {
    return {
      kind: "refuse",
      result: {
        error: `Write limit reached for this request (max ${maxWrites} write tool calls). Please send a new message to continue.`,
        code: "WRITE_LIMIT",
      },
    };
  }
  return { kind: "run", write };
}
