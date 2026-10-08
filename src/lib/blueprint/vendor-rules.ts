/**
 * The vendor's own Blueprint rules, run on the server: `sanitise()` (rebuild a
 * stored object field by field), `score()` (readiness and the NEEDED items) and
 * `parseWhen()` (read a free-text date). Generated from vendor/event-blueprint
 * by scripts/blueprint-build.mjs, so approval refuses exactly what the page
 * shows as missing, never a second opinion that drifts.
 *
 * Evaluated once per process in a `node:vm` context with nothing in it but the
 * language: the code is ours (vendored and reviewed), the DATA crosses in as a
 * JSON string and comes back as one, and every call runs under its own timeout.
 * Calls are synchronous, so the shared `__in` slot cannot interleave. Server only.
 */
import vm from "node:vm";
import rules from "./vendor-rules.generated.json";

const TIMEOUT_MS = 1_000;

let context: vm.Context | null = null;
const RUN = new vm.Script("__api.run(__in)");
const WHEN = new vm.Script("__api.when(__in)");

/**
 * The sandbox, built once. Each call then runs as its own script with its own
 * timeout (review L8): a plain call into the sandbox's functions would carry
 * no time limit at all.
 */
function sandbox(): vm.Context {
  if (context) return context;
  const ctx = vm.createContext({ __in: "" });
  new vm.Script(
    `${rules.source.replace(/\n;\(\{ sanitise, score, parseWhen \}\)$/, "")}
;globalThis.__api = {
  run: (json) => { const s = sanitise(JSON.parse(json)); const sc = score(s); return JSON.stringify({ pct: sc.pct, blocking: sc.blocking.map((x) => ({ sec: x.sec, label: x.label })), data: s }); },
  when: (text) => { const w = parseWhen(text); return JSON.stringify(w && w.date ? { y: w.date.getFullYear(), m: w.date.getMonth() + 1, d: w.date.getDate(), approx: !!w.approx, yearOnly: !!w.yearOnly } : { invalid: true }); },
};`,
  ).runInContext(ctx, { timeout: TIMEOUT_MS });
  context = ctx;
  return ctx;
}

function call(script: vm.Script, input: string): string {
  const ctx = sandbox();
  ctx.__in = input;
  return script.runInContext(ctx, { timeout: TIMEOUT_MS }) as string;
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
  return JSON.parse(call(RUN, JSON.stringify(data ?? {})));
}

/** A date the organiser wrote, as the page reads it; `approx` when no day was given. */
export type ReadDate = { y: number; m: number; d: number; approx: boolean; yearOnly: boolean } | { invalid: true };

export function readWhen(text: string): ReadDate {
  return JSON.parse(call(WHEN, text));
}
