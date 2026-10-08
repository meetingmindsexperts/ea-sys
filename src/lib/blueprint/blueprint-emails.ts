/**
 * The Event Blueprint's notification emails (owner ruling, Oct 8, 2026):
 *
 *   submitted / update  to the build team: everyone who can move stages
 *                       (`blueprints.manage`), never the sender;
 *   stage / approved    to the blueprint's writer.
 *
 * Pure: builds subject, HTML and text. Every value is escaped; sending, and
 * logging a failed send, is the workflow service's.
 */
import { escapeHtml } from "@/lib/html";

export type BlueprintEmailKind = "submitted" | "update" | "stage" | "approved";

export interface BlueprintEmailInput {
  kind: BlueprintEmailKind;
  recipientName: string | null;
  title: string;
  ref: string;
  actorName: string;
  link: string;
  /** submitted: readiness 0-100 as the page reported it, and what was still open. */
  readiness?: number | null;
  openCount?: number;
  /** update: how many changes were sent. */
  changeCount?: number;
  /** stage / approved: the stage it moved to, in words ("In review", "Building"). */
  stageLabel?: string;
}

export function buildBlueprintEmail(input: BlueprintEmailInput): { subject: string; html: string; text: string } {
  const hi = input.recipientName?.trim() ? `Hello ${input.recipientName.trim()},` : "Hello,";
  const label = `${input.title} (${input.ref})`;
  let subject: string;
  let lead: string;
  let detail: string | null = null;

  switch (input.kind) {
    case "submitted":
      subject = `Blueprint submitted: ${input.title}`;
      lead = `${input.actorName} submitted an event blueprint for review.`;
      detail =
        input.readiness == null
          ? null
          : `Readiness ${input.readiness}%${input.openCount ? `, ${input.openCount} needed item${input.openCount === 1 ? "" : "s"} still open` : ", nothing needed still open"}.`;
      break;
    case "update":
      subject = `Blueprint updated: ${input.title}`;
      lead = `${input.actorName} sent an update to a submitted blueprint.`;
      detail = input.changeCount == null ? null : `${input.changeCount} change${input.changeCount === 1 ? "" : "s"}.`;
      break;
    case "stage":
      subject = `Blueprint ${input.stageLabel?.toLowerCase() ?? "moved"}: ${input.title}`;
      lead = `${input.actorName} moved your blueprint to "${input.stageLabel ?? ""}".`;
      break;
    case "approved":
      subject = `Blueprint approved: ${input.title}`;
      lead = `${input.actorName} approved your blueprint. It is now "${input.stageLabel ?? ""}".`;
      break;
  }

  const html = [
    `<p>${escapeHtml(hi)}</p>`,
    `<p>${escapeHtml(lead)}</p>`,
    `<p style="padding:12px 16px;border-left:3px solid #00aade;background:#f6fbfd;"><strong>${escapeHtml(label)}</strong>${detail ? `<br/>${escapeHtml(detail)}` : ""}</p>`,
    `<p><a href="${escapeHtml(input.link)}">Open the Event Blueprint</a></p>`,
  ].join("\n");
  const text = [hi, "", lead, "", label, detail ?? "", "", `Open the Event Blueprint: ${input.link}`]
    .filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n")
    .trim();
  return { subject, html, text };
}
