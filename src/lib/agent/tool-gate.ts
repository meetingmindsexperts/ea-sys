// One gate for every tool call the in-app Event Agent makes.
//
// The route used to decide four things inline (read-only role, roster
// PII, finance, the write cap), and the write cap keyed on a hand-written
// list of 14 tool names that missed 11 write tools. Everything is now
// derived from the predicates the authorization boundary already uses, so
// a tool added tomorrow is a write until proven otherwise, and the same
// decision can be reused by the MCP door when both doors share a guardrail
// layer (agent architecture review, §4.5).

import { isWriteTool } from "./tools/_shared";
import { toolPermission } from "./tool-permissions";
import { can, type EventFacts, type Principal } from "@/lib/permissions/can";

/** Writes one request may perform. A request is one user message and the
 *  tool loop that answers it; the person sends another message to continue. */
export const MAX_WRITES_PER_REQUEST = 20;

export interface ToolGatePolicy {
  /** The person, as the routes see them (custom roles Phase 3, Oct 5, 2026). */
  principal: Principal;
  /** The event the call acts on; undefined when the call names none. */
  event?: EventFacts | null;
  /** Write tool calls already run in this request. */
  writesSoFar: number;
  /** Test seam; production uses MAX_WRITES_PER_REQUEST. */
  maxWrites?: number;
}

export type ToolGateDecision =
  | { kind: "run"; write: boolean }
  | { kind: "refuse"; result: { error: string; code: string } };

export function gateToolCall(toolName: string, policy: ToolGatePolicy): ToolGateDecision {
  // Each tool needs the key its REST route asks (`tool-permissions.ts`), so
  // the agent does exactly what the person could do on the screens. A tool
  // with no key is refused: a tool added tomorrow is closed until mapped.
  const key = toolPermission(toolName);
  if (!key) {
    return { kind: "refuse", result: { error: `"${toolName}" has no permission mapped and was refused.`, code: "NO_PERMISSION_KEY" } };
  }
  const allowed = policy.event === undefined ? can(policy.principal, key) : can(policy.principal, key, { event: policy.event });
  if (!allowed) {
    return {
      kind: "refuse",
      result: {
        error:
          `Your access does not include "${toolName}"${policy.event === undefined ? "" : " on this event"}. ` +
          `Ask an organisation admin if you need it.`,
        code: "PERMISSION_DENIED",
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
