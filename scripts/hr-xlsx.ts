/**
 * Minimal .xlsx reader for the HR import. An xlsx is a zip of XML, so this needs
 * no dependency: adding one to read a file we import exactly once would be a
 * permanent cost for a one-off.
 *
 * It reads FORMULAS as well as cached values, which is not incidental. Reading
 * the v5.1 workbook's numbers told us what it computed; reading its formulas
 * told us the leave year is the calendar year and that its comp-off rule is not
 * the rule we were given. The numbers alone were internally consistent with a
 * rule that turns out to be wrong.
 */
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

export interface Cell {
  v: string | null;
  f: string | null;
}
export type Row = Record<string, Cell>;

/** Excel's day zero. Excel wrongly treats 1900 as a leap year; the 1899-12-30 epoch absorbs it. */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

export function excelSerialToDate(serial: number): string {
  return new Date(EXCEL_EPOCH + serial * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Extract one entry from a zip, in pure Node.
 *
 * This shelled out to `unzip` first, which works on macOS and FAILS in the
 * worker container: the image is slim Debian with openssl, curl and
 * ca-certificates, and nothing else. A script that has to run inside a container
 * we do not control should not depend on what that container happens to have
 * installed, and `node:zlib` already has the only hard part.
 *
 * Read via the CENTRAL DIRECTORY rather than by walking local headers. A local
 * header may carry zero sizes when the entry uses a trailing data descriptor
 * (bit 3 of the flags), and the central directory always has the real ones.
 */
function unzip(path: string, entry: string): string {
  const buf = readFileSync(path);

  // End of central directory: scan back from the tail for its signature. The
  // trailing comment is at most 64 KB, which bounds the scan.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error(`Not a zip archive: ${path}`);

  const entryCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");

    if (name === entry) {
      // The LOCAL header's name and extra lengths can differ from the central
      // directory's, so the data offset is computed from the local header.
      const localNameLen = buf.readUInt16LE(localOffset + 26);
      const localExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      const raw = buf.subarray(start, start + compressedSize);
      if (method === 0) return raw.toString("utf8");
      if (method === 8) return inflateRawSync(raw).toString("utf8");
      throw new Error(`Unsupported zip compression method ${method} for ${entry}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`Entry not found in archive: ${entry}`);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");
}

function textOf(xml: string): string {
  const parts = [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]);
  return decodeEntities(parts.join(""));
}

export class Workbook {
  private shared: string[] = [];
  constructor(private path: string) {
    readFileSync(path); // fail fast with a clear error if the file is unreadable
    let ss = "";
    try {
      ss = unzip(path, "xl/sharedStrings.xml");
    } catch {
      ss = "";
    }
    if (ss) {
      this.shared = [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
    }
  }

  /** Sheet names in workbook order, so a caller can look one up by name. */
  sheetNames(): string[] {
    const wb = unzip(this.path, "xl/workbook.xml");
    return [...wb.matchAll(/<sheet[^>]*name="([^"]+)"/g)].map((m) => decodeEntities(m[1]));
  }

  /** Rows of the Nth sheet (1-based), as { A: {v,f}, B: {...} }. */
  rows(sheetNumber: number): Row[] {
    const xml = unzip(this.path, `xl/worksheets/sheet${sheetNumber}.xml`);
    const out: Row[] = [];
    for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const row: Row = {};
      for (const c of rowMatch[1].matchAll(/<c\s([^>]*)>([\s\S]*?)<\/c>|<c\s([^>]*)\/>/g)) {
        const attrs = c[1] ?? c[3] ?? "";
        const inner = c[2] ?? "";
        const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
        if (!ref) continue;
        const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? null;
        const f = /<f[^>]*>([\s\S]*?)<\/f>/.exec(inner)?.[1] ?? null;
        let v: string | null = /<v[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? null;
        if (type === "s" && v !== null) v = this.shared[Number(v)] ?? null;
        else if (type === "inlineStr") v = textOf(inner);
        else if (v !== null) v = decodeEntities(v);
        row[ref] = { v, f: f ? decodeEntities(f) : null };
      }
      out.push(row);
    }
    return out;
  }
}

export function cell(row: Row | undefined, col: string): string | null {
  const value = row?.[col]?.v ?? null;
  return value === null || value === "" ? null : value;
}
