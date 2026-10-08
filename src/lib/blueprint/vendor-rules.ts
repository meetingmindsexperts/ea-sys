/**
 * The vendor's own Blueprint rules, run on the server: `sanitise()` (rebuild a
 * stored object field by field), `score()` (readiness and the NEEDED items) and
 * `parseWhen()` (read a free-text date). Generated from vendor/event-blueprint
 * by scripts/blueprint-build.mjs, so approval refuses exactly what the page
 * shows as missing, never a second opinion that drifts.
 *
 * Evaluated once per process in a `node:vm` context with nothing in it but the
 * language: the code is ours (vendored and reviewed), the DATA crosses in as a
 * JSON string and comes back as one, and a timeout bounds every call. Server only.
 */
import vm from "node:vm";
import rules from "./vendor-rules.generated.json";

interface VendorRules {
  run(json: string): string;
  when(text: string): string;
}

const TIMEOUT_MS = 1_000;

let compiled: VendorRules | null = null;

function vendor(): VendorRules {
  if (compiled) return compiled;
  const context = vm.createContext({});
  const api = new vm.Script(
    `${rules.source.replace(/\n;\(\{ sanitise, score, parseWhen \}\)$/, "")}
;({
  run: (json) => { const s = sanitise(JSON.parse(json)); const sc = score(s); return JSON.stringify({ pct: sc.pct, blocking: sc.blocking.map((x) => ({ sec: x.sec, label: x.label })), data: s }); },
  when: (text) => { const w = parseWhen(text); return JSON.stringify(w && w.date ? { y: w.date.getFullYear(), m: w.date.getMonth() + 1, d: w.date.getDate(), approx: !!w.approx, yearOnly: !!w.yearOnly } : { invalid: true }); },
})`,
  ).runInContext(context, { timeout: TIMEOUT_MS }) as VendorRules;
  compiled = api;
  return api;
}

export interface BlueprintScore {
  /** Readiness 0-100, the page's number recomputed here. */
  pct: number;
  /** The NEEDED items still open, in the page's words; empty means complete. */
  blocking: { sec: string; label: string }[];
  /** The stored object after the vendor's sanitise(): every field has its type. */
  data: Record<string, unknown>;
}

export function scoreBlueprint(data: unknown): BlueprintScore {
  return JSON.parse(vendor().run(JSON.stringify(data ?? {})));
}

/** A date the organiser wrote, as the page reads it; `approx` when no day was given. */
export type ReadDate = { y: number; m: number; d: number; approx: boolean; yearOnly: boolean } | { invalid: true };

export function readWhen(text: string): ReadDate {
  return JSON.parse(vendor().when(text));
}
