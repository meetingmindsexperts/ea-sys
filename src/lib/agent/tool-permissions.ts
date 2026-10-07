import type { PermissionKey } from "@/lib/permissions/catalogue";
import { TOOL_PERMISSIONS } from "@/lib/permissions/tool-permissions";

export { TOOL_PERMISSIONS };

/**
 * The permission each agent tool needs (custom roles Phase 3, Oct 5, 2026):
 * the key the matching REST route asks, so the agent can do exactly what the
 * person could do on the screens. A tool missing here is refused (fail
 * closed); `tool-permissions.test.ts` fails when a registered tool has no key.
 * For an event-bound key the event is the call's `eventId`, else the event
 * the agent was opened on.
 */
export function toolPermission(toolName: string): PermissionKey | null {
  return TOOL_PERMISSIONS[toolName] ?? null;
}
