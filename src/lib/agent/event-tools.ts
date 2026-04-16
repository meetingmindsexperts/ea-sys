// Entry point for agent/MCP tool executors.
// Composes per-domain modules under ./tools/ into the public surface:
// - AGENT_TOOL_DEFINITIONS (for the in-app Anthropic agent's tool-use)
// - TOOL_EXECUTOR_MAP       (for MCP HTTP + in-app agent)
// - AgentContext            (shared interface)
//
// To add a new tool, implement it in the appropriate domain file under ./tools/
// and wire it into that file's *_EXECUTORS / *_TOOL_DEFINITIONS exports.
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { ToolExecutor } from "./tools/_shared";

import { EVENT_TOOL_DEFINITIONS, EVENT_EXECUTORS } from "./tools/events";
import { REGISTRATION_TOOL_DEFINITIONS, REGISTRATION_EXECUTORS } from "./tools/registrations";
import { SPEAKER_TOOL_DEFINITIONS, SPEAKER_EXECUTORS } from "./tools/speakers";
import { SESSION_TOOL_DEFINITIONS, SESSION_EXECUTORS } from "./tools/sessions";
import { ABSTRACT_TOOL_DEFINITIONS, ABSTRACT_EXECUTORS } from "./tools/abstracts";
import { ACCOMMODATION_TOOL_DEFINITIONS, ACCOMMODATION_EXECUTORS } from "./tools/accommodations";
import { CONTACT_TOOL_DEFINITIONS, CONTACT_EXECUTORS } from "./tools/contacts";
import { INVOICE_TOOL_DEFINITIONS, INVOICE_EXECUTORS } from "./tools/invoices";
import { WEBINAR_TOOL_DEFINITIONS, WEBINAR_EXECUTORS } from "./tools/webinar";
import { COMMUNICATION_TOOL_DEFINITIONS, COMMUNICATION_EXECUTORS } from "./tools/communications";
import { PROMO_CODE_TOOL_DEFINITIONS, PROMO_CODE_EXECUTORS } from "./tools/promo-codes";
import { DASHBOARD_TOOL_DEFINITIONS, DASHBOARD_EXECUTORS } from "./tools/dashboard";

export type { AgentContext } from "./tools/_shared";

export const AGENT_TOOL_DEFINITIONS: Tool[] = [
  ...EVENT_TOOL_DEFINITIONS,
  ...SPEAKER_TOOL_DEFINITIONS,
  ...REGISTRATION_TOOL_DEFINITIONS,
  ...SESSION_TOOL_DEFINITIONS,
  ...ABSTRACT_TOOL_DEFINITIONS,
  ...ACCOMMODATION_TOOL_DEFINITIONS,
  ...CONTACT_TOOL_DEFINITIONS,
  ...INVOICE_TOOL_DEFINITIONS,
  ...WEBINAR_TOOL_DEFINITIONS,
  ...COMMUNICATION_TOOL_DEFINITIONS,
  ...PROMO_CODE_TOOL_DEFINITIONS,
  ...DASHBOARD_TOOL_DEFINITIONS,
];

export const TOOL_EXECUTOR_MAP: Record<string, ToolExecutor> = {
  ...EVENT_EXECUTORS,
  ...SPEAKER_EXECUTORS,
  ...REGISTRATION_EXECUTORS,
  ...SESSION_EXECUTORS,
  ...ABSTRACT_EXECUTORS,
  ...ACCOMMODATION_EXECUTORS,
  ...CONTACT_EXECUTORS,
  ...INVOICE_EXECUTORS,
  ...WEBINAR_EXECUTORS,
  ...COMMUNICATION_EXECUTORS,
  ...PROMO_CODE_EXECUTORS,
  ...DASHBOARD_EXECUTORS,
};
