/**
 * Shared CSV parsing utility.
 * Extracted from contacts import route for reuse across all CSV import endpoints.
 */

/** Parse a single CSV line handling quoted fields (RFC 4180) */
export function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

/** Parse header row → normalized lowercase keys (spaces removed) */
export function parseCSVHeaders(headerLine: string): string[] {
  return parseCSVLine(headerLine).map((h) => h.toLowerCase().replace(/\s+/g, ""));
}

/** Build a column index map from headers for a set of expected field names */
export function buildColumnIndex<T extends string>(
  headers: string[],
  fieldNames: readonly T[]
): Record<T, number> {
  const idx = {} as Record<T, number>;
  for (const name of fieldNames) {
    idx[name] = headers.indexOf(name.toLowerCase());
  }
  return idx;
}

/** Get a trimmed field value from a parsed row, or undefined if missing/empty */
export function getField(fields: string[], index: number): string | undefined {
  if (index < 0) return undefined;
  const val = fields[index]?.trim();
  return val || undefined;
}

/** Parse a comma-separated tags field into a string array */
export function parseTags(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

const MAX_ROWS = 5000;

/** Parse a full CSV text into headers + rows, with validation */
export function parseCSV(text: string): {
  headers: string[];
  rows: string[][];
  error?: string;
} {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());

  if (lines.length < 2) {
    return { headers: [], rows: [], error: "CSV must have a header row and at least one data row" };
  }

  if (lines.length - 1 > MAX_ROWS) {
    return {
      headers: [],
      rows: [],
      error: `CSV exceeds maximum of ${MAX_ROWS} rows. Please split into smaller files.`,
    };
  }

  const headers = parseCSVHeaders(lines[0]);
  const rows: string[][] = [];

  for (let i = 1; i < lines.length; i++) {
    rows.push(parseCSVLine(lines[i]));
  }

  return { headers, rows };
}
