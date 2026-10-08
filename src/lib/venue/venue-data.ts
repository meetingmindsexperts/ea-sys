/**
 * What the online venue may store, shaped on the server. The page builds both
 * documents itself (vendor/ehc-venue/src/team.js `saveNow()` and
 * `sendReport()`), so the server keeps only the fields it knows, with fixed
 * types and lengths, and NEVER takes identity from the body: the person comes
 * from the session.
 *
 * Client-safe: pure.
 */

const num = (v: unknown, max: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : 0);
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const KEY = /^[\w-]{1,80}$/;

/** A map of short keys (room or stand ids) to numbers, at most `limit` entries. */
function counts(v: unknown, max: number, limit = 100): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(obj(v)).slice(0, limit)) if (KEY.test(k)) out[k] = num(n, max);
  return out;
}

const DAY_SECONDS = 86_400 * 30;

/**
 * One person's activity summary. `uid` and `name` are the SERVER's: the uid is
 * the signed-in user, and the name is kept only when the page says the person
 * chose to share it.
 */
export function shapeActivity(raw: unknown, userId: string, displayName: string): Record<string, unknown> {
  const a = obj(raw);
  const named = a.named === true;
  const stands: Record<string, { visits: number; sec: number; opens: number }> = {};
  for (const [k, v] of Object.entries(obj(a.stands)).slice(0, 100)) {
    if (!KEY.test(k)) continue;
    const s = obj(v);
    stands[k] = { visits: num(s.visits, 10_000), sec: num(s.sec, DAY_SECONDS), opens: num(s.opens, 10_000) };
  }
  return {
    v: 1,
    uid: userId,
    named,
    name: named ? displayName.slice(0, 80) : "",
    sessions: num(a.sessions, 10_000),
    first: num(a.first, 1e14),
    last: Date.now(),
    speakerQs: num(a.speakerQs, 100_000),
    chats: num(a.chats, 100_000),
    photos: num(a.photos, 100_000),
    zones: counts(a.zones, DAY_SECONDS),
    questions: counts(a.questions, 100_000),
    stands,
  };
}

/** The page's report reasons, word for word (vendor/ehc-venue/src/shell.html, `rreason`). */
export const REPORT_REASONS = ["Harassment or bullying", "Offensive language", "Spam or selling", "Pretending to be someone", "Something else"] as const;

/** One safety report; `by` is the server's (the reporter is the signed-in user). */
export function shapeReport(raw: unknown, reporterId: string): Record<string, unknown> | null {
  const r = obj(raw);
  const reason = str(r.reason, 40);
  if (!(REPORT_REASONS as readonly string[]).includes(reason)) return null;
  const who = obj(r.who);
  return {
    at: Date.now(),
    reason,
    note: str(r.note, 600),
    who: { id: str(who.id, 80) || null, peer: str(who.peer, 80) || null, name: str(who.name, 80), guest: who.guest === true },
    said: (Array.isArray(r.said) ? r.said : []).slice(-5).map((s) => str(s, 300)),
    zone: str(r.zone, 60),
    by: reporterId,
  };
}

export const FILTER_MODES = ["mask", "hide"] as const;

/** The language filter settings the event team saves (team.js `config/filter`). */
export function shapeFilter(raw: unknown): { on: boolean; mode: string; extra: string[]; allow: string[] } {
  const f = obj(raw);
  const words = (v: unknown) => (Array.isArray(v) ? v : []).filter((w) => typeof w === "string" && w.trim()).slice(0, 200).map((w) => (w as string).trim().slice(0, 60));
  return { on: f.on !== false, mode: (FILTER_MODES as readonly string[]).includes(f.mode as string) ? (f.mode as string) : "mask", extra: words(f.extra), allow: words(f.allow) };
}
