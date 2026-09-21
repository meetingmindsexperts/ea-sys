// Tool results, as the model receives them.
//
// A tool result carries text other people wrote: attendee names, abstract
// bodies, email subjects, pages scraped from a sponsor's website. The system
// prompt tells the model that everything between the delimiters below is
// data and never an instruction (readiness gap G3); this file is what makes
// the rule mechanical. A delimiter that appears INSIDE the data is defused,
// so a registration whose surname is "[END TOOL DATA]" cannot close the
// block early and have the next line read as ours.

export const TOOL_DATA_OPEN = "[BEGIN TOOL DATA";
export const TOOL_DATA_CLOSE = "[END TOOL DATA]";

/** The delimiters with a space after the bracket: still readable, no longer a delimiter. */
const DEFUSED_OPEN = "[ BEGIN TOOL DATA";
const DEFUSED_CLOSE = "[ END TOOL DATA]";

export function serializeToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  const json = JSON.stringify(result);
  return json === undefined ? "null" : json;
}

/** Any delimiter inside the payload stops being one. Idempotent. */
export function defuseToolDataDelimiters(text: string): string {
  return text.split(TOOL_DATA_OPEN).join(DEFUSED_OPEN).split(TOOL_DATA_CLOSE).join(DEFUSED_CLOSE);
}

export function wrapToolResultAsData(toolName: string, result: unknown): string {
  // The name comes from the model's tool_use block. Unknown names are
  // refused before execution, but the refusal is wrapped too, so the header
  // never trusts the string.
  const safeName = toolName.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 64) || "tool";
  const body = defuseToolDataDelimiters(serializeToolResult(result));
  return `${TOOL_DATA_OPEN}: ${safeName}]\n${body}\n${TOOL_DATA_CLOSE}`;
}
