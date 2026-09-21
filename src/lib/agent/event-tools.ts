// Entry point for agent/MCP tool executors.
// Composes per-domain modules under ./tools/ into the public surface:
// - TOOL_EXECUTOR_MAP (the executors; the MCP registrar runs them for both doors)
// - AgentContext      (shared interface)
//
// There is no hand-written tool-definition list any more (deleted Sep 21, 2026,
// Event Agent Phase 4). Both doors, the in-app Event Agent and the MCP server,
// take every tool's name, description and input schema from the Zod
// registrations in ./register-mcp-tools.ts (the in-app door through
// ./tool-registry.ts), so each tool has ONE schema.
//
// To add a new tool: implement it in the appropriate domain file under
// ./tools/, wire it into that file's *_EXECUTORS export, and register it in
// ./register-mcp-tools.ts. An executor that is not registered there is
// reachable by neither door.
import type { ToolExecutor } from "./tools/_shared";

import { EVENT_EXECUTORS } from "./tools/events";
import { REGISTRATION_EXECUTORS } from "./tools/registrations";
import { SPEAKER_EXECUTORS } from "./tools/speakers";
import { SESSION_EXECUTORS } from "./tools/sessions";
import { ABSTRACT_EXECUTORS } from "./tools/abstracts";
import { ACCOMMODATION_EXECUTORS } from "./tools/accommodations";
import { CONTACT_EXECUTORS } from "./tools/contacts";
import { INVOICE_EXECUTORS } from "./tools/invoices";
import { WEBINAR_EXECUTORS } from "./tools/webinar";
import { COMMUNICATION_EXECUTORS } from "./tools/communications";
import { PROMO_CODE_EXECUTORS } from "./tools/promo-codes";
import { DASHBOARD_EXECUTORS } from "./tools/dashboard";
import { CERTIFICATE_EXECUTORS } from "./tools/certificates";
import { RSVP_EXECUTORS } from "./tools/rsvp";

export type { AgentContext } from "./tools/_shared";

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
  ...CERTIFICATE_EXECUTORS,
  ...RSVP_EXECUTORS,
};
