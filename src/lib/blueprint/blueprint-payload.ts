/**
 * The Event Blueprint page's saved object, as the server accepts and returns it.
 *
 * THE SERVER DOES NOT RE-IMPLEMENT THE PAGE'S `sanitise()`. That function
 * rebuilds ~40 fields across 13 sections from catalogues that live only in the
 * vendor code (vendor/event-blueprint/src/app.js); a TypeScript copy would be a
 * second source of truth that drifts on the vendor's next change. Instead:
 *
 *   - the server checks STRUCTURE here: a plain object, at most
 *     MAX_BLUEPRINT_BYTES, at most MAX_DEPTH levels deep, a valid id;
 *   - it strips the fields the SERVER owns (status, ref, history, approvals)
 *     and the listing fields the page adds on save;
 *   - every server consumer validates the specific fields it reads, where it
 *     reads them (the title here; dates, rooms, programme at approval);
 *   - the page passes everything it loads through `sanitise()` and renders
 *     text through textContent (its test_security suite), and the dashboard is
 *     React, so stored text cannot execute on either side.
 *
 * Client-safe: pure, no imports beyond Prisma's enum type.
 */
import type { BlueprintStatus } from "@prisma/client";

export const MAX_BLUEPRINT_BYTES = 256 * 1024;
export const MAX_DEPTH = 8;
export const MAX_TITLE = 200;
export const MAX_TEMPLATE_NAME = 80;

/** The page mints `bp_<base36>` / `tp_<base36>`; sanitise() allows [\w-] up to 60. */
export const BLUEPRINT_ID_RE = /^bp_[A-Za-z0-9_-]{4,57}$/;
export const TEMPLATE_ID_RE = /^tp_[A-Za-z0-9_-]{4,57}$/;

/**
 * Owned by the server (plan §4.4): the page may send them, the server ignores
 * them and merges its own back on read. `baseline` stays with the page until
 * the workflow step makes submission server-side.
 */
const SERVER_OWNED = ["status", "ref", "submissions", "statusLog", "approvals"] as const;
/** Listing fields the page adds to every save; the server keeps its own copies in columns. */
const LISTING_FIELDS = ["ownerId", "title", "readiness", "blocking", "pendingChanges"] as const;

export type PayloadError = "NOT_AN_OBJECT" | "TOO_LARGE" | "TOO_DEEP" | "ID_MISMATCH";

export type ParsedBlueprint =
  | { ok: true; data: Record<string, unknown>; title: string; type: string | null; readiness: number }
  | { ok: false; code: PayloadError };

const byteLength = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function depthOf(v: unknown, level = 0): number {
  if (level > MAX_DEPTH) return level;
  if (Array.isArray(v)) return Math.max(level, ...v.map((x) => depthOf(x, level + 1)));
  if (isPlainObject(v)) return Math.max(level, ...Object.values(v).map((x) => depthOf(x, level + 1)));
  return level;
}

/** Checks the structure of a body the page PUTs; never trusts the page's listing fields. */
export function parseBlueprintPayload(raw: unknown, id: string): ParsedBlueprint {
  if (!isPlainObject(raw)) return { ok: false, code: "NOT_AN_OBJECT" };
  if (raw.id !== undefined && raw.id !== id) return { ok: false, code: "ID_MISMATCH" };
  if (byteLength(raw) > MAX_BLUEPRINT_BYTES) return { ok: false, code: "TOO_LARGE" };
  if (depthOf(raw) > MAX_DEPTH) return { ok: false, code: "TOO_DEEP" };

  const data: Record<string, unknown> = { ...raw, id };
  for (const k of [...SERVER_OWNED, ...LISTING_FIELDS]) delete data[k];

  const basics = isPlainObject(raw.basics) ? raw.basics : {};
  const title = typeof basics.title === "string" && basics.title.trim() ? basics.title.trim().slice(0, MAX_TITLE) : "Untitled event";
  const type = typeof raw.type === "string" && raw.type ? raw.type.slice(0, 60) : null;
  // The page's own score, kept for the list; approval recomputes on the server.
  const readiness = typeof raw.readiness === "number" && Number.isFinite(raw.readiness) ? Math.min(100, Math.max(0, Math.round(raw.readiness))) : 0;
  return { ok: true, data, title, type, readiness };
}

export type ParsedTemplate =
  | { ok: true; name: string; type: string | null; state: Record<string, unknown> }
  | { ok: false; code: PayloadError };

/** A template the page PUTs: `{ id, name, type, state }`. */
export function parseTemplatePayload(raw: unknown, id: string): ParsedTemplate {
  if (!isPlainObject(raw) || !isPlainObject(raw.state)) return { ok: false, code: "NOT_AN_OBJECT" };
  if (raw.id !== undefined && raw.id !== id) return { ok: false, code: "ID_MISMATCH" };
  if (byteLength(raw) > MAX_BLUEPRINT_BYTES) return { ok: false, code: "TOO_LARGE" };
  if (depthOf(raw.state) > MAX_DEPTH) return { ok: false, code: "TOO_DEEP" };
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, MAX_TEMPLATE_NAME) : "Untitled template";
  const type = typeof raw.type === "string" && raw.type ? raw.type.slice(0, 60) : null;
  return { ok: true, name, type, state: raw.state };
}

/** Column enum ↔ the page's lowercase stage ids (`STATUSES` in app.js). */
export function toPageStatus(status: BlueprintStatus): string {
  return status.toLowerCase();
}

export interface StatusLogEntry {
  kind: string;
  toStatus: BlueprintStatus | null;
  readiness: number | null;
  detail: unknown;
  createdAt: Date;
}

export interface BlueprintRowForPage {
  id: string;
  status: BlueprintStatus;
  ref: string | null;
  data: unknown;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The object the page expects back: its own data with the server-owned fields
 * merged in, in the page's shapes (times in epoch ms).
 */
export function mergeForPage(row: BlueprintRowForPage, log: readonly StatusLogEntry[]): Record<string, unknown> {
  const data = isPlainObject(row.data) ? row.data : {};
  const submissions = log
    .filter((l) => l.kind === "SUBMITTED" || l.kind === "UPDATE")
    .map((l, i) => {
      const detail = isPlainObject(l.detail) ? l.detail : {};
      return {
        kind: l.kind === "UPDATE" ? "update" : "submission",
        n: l.kind === "UPDATE" ? i : 0,
        at: l.createdAt.getTime(),
        readiness: l.readiness,
        count: typeof detail.count === "number" ? detail.count : null,
        open: Array.isArray(detail.open) ? detail.open : [],
        changes: Array.isArray(detail.changes) ? detail.changes : [],
      };
    });
  const statusLog = log
    .filter((l) => l.toStatus)
    .map((l) => ({ status: toPageStatus(l.toStatus as BlueprintStatus), at: l.createdAt.getTime() }));
  return {
    ...data,
    id: row.id,
    status: toPageStatus(row.status),
    ref: row.ref ?? "",
    submissions,
    statusLog,
    approvals: { plan: null, preview: null },
    created: typeof data.created === "number" ? data.created : row.createdAt.getTime(),
    updated: row.updatedAt.getTime(),
  };
}
