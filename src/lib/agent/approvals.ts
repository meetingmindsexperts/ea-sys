// Which tools pause for a person's approval. Client-safe leaf: the page
// reads it to label the approval card; the loop, the MCP registrations and
// the prompt read it so all three agree (architecture review §4.5, owner
// decision Sep 21, 2026: the readiness list, plus every delete tool).
//
// Approval is not authorization: the role gate, the finance gate and the
// write cap still run on an approved call. It is the pause before an
// action that cannot be undone or that reaches many people at once.

export const APPROVAL_REQUIRED_TOOLS: ReadonlySet<string> = new Set([
  "send_bulk_email",
  "create_zoom_meeting",
  "upsert_sponsors",
  "replace_session_speakers",
  "update_cme_settings",
]);

/** The parameter an MCP client sets once the person has said yes. */
export const APPROVAL_CONFIRM_PARAM = "confirm";
export const APPROVAL_REQUIRED_CODE = "APPROVAL_REQUIRED";

/** Every delete tool needs approval, whether or not it is named above. */
export function requiresApproval(toolName: string): boolean {
  return APPROVAL_REQUIRED_TOOLS.has(toolName) || /^delete_/.test(toolName);
}

/** Plain words for the approval card and the prompt. */
export function approvalLabel(toolName: string): string {
  const known: Record<string, string> = {
    send_bulk_email: "Send a bulk email",
    create_zoom_meeting: "Create a Zoom meeting",
    upsert_sponsors: "Replace the sponsor list",
    replace_session_speakers: "Replace a session's speakers",
    update_cme_settings: "Change the CME settings",
    delete_promo_code: "Delete a promo code",
    delete_room_type: "Delete a room type",
  };
  return known[toolName] ?? toolName.replace(/_/g, " ");
}
