// How an approval card shows a tool's input, in plain rows. Client-safe leaf:
// the card renders it and a test pins it. The card exists so the person sees
// EXACTLY what is about to run; "2 items" for a list of budget lines defeated
// that (found Sep 22, 2026 on replace_budget_lines), so an array of objects
// now opens into one row per item with that item's own fields, and an array
// of plain values is written out.

export interface ApprovalRow {
  /** The input key, spaced and lower-cased for reading ("recipient type"). */
  label: string;
  /** The value on one line, or the array's summary when `items` is present. */
  text: string;
  /** One line per element for an array of objects. */
  items?: string[];
}

const MAX_TEXT = 160;
const MAX_ITEMS = 20;

export function humanizeKey(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
}

function clip(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max - 3)}…` : text;
}

/** One value as text: strings as they are, objects as "key value" pairs, never JSON braces. */
export function shortValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return clip(value);
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== "object")) return clip(value.map((v) => shortValue(v)).join(", "));
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  if (typeof value === "object") {
    const pairs = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${humanizeKey(k)} ${shortValue(v)}`);
    return clip(pairs.join(", "));
  }
  return String(value);
}

/** The rows the card lists, in the input's own order; empty values are left out. */
export function approvalRows(input: Record<string, unknown>): ApprovalRow[] {
  const rows: ApprovalRow[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    const label = humanizeKey(key);
    if (Array.isArray(value) && value.length > 0 && value.some((v) => v !== null && typeof v === "object")) {
      const items = value.slice(0, MAX_ITEMS).map((v, i) => `${i + 1}. ${shortValue(v)}`);
      if (value.length > MAX_ITEMS) items.push(`and ${value.length - MAX_ITEMS} more`);
      rows.push({ label, text: shortValue(value), items });
      continue;
    }
    rows.push({ label, text: shortValue(value) });
  }
  return rows;
}
