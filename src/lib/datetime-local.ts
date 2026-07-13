/**
 * Lossless round-trip between a UTC ISO instant and an `<input type="datetime-local">`.
 *
 * WHY THIS EXISTS (Survey/RSVP review, B2): a `datetime-local` input has NO
 * timezone — the browser reads whatever string you give it as LOCAL wall-clock
 * time. So the two directions are NOT symmetric, and you cannot fake either one
 * with string slicing:
 *
 *   ❌ WRONG (the dinner console did this):
 *        input.value = isoString.slice(0, 16)
 *      That drops the *UTC* wall-clock into an input the browser then interprets
 *      as *local*. Saving with `new Date(value).toISOString()` shifts the instant
 *      backwards by the UTC offset — EVERY TIME IT'S SAVED. A 19:00 Dubai dinner
 *      opened showing 15:00; saving moved it to 15:00; saving again → 11:00.
 *
 *   ✅ RIGHT: convert the instant to local wall-clock components on the way IN
 *      (below), and let `new Date(localString).toISOString()` convert back on the
 *      way OUT. That pair is lossless.
 *
 * The write direction is just `new Date(form.value).toISOString()` — no helper
 * needed, because the browser already parses a datetime-local string as local.
 *
 * NOTE (deliberate, and a known limitation): this works in the *browser's* local
 * timezone, not the EVENT's timezone. An organizer in London editing a Dubai
 * event enters London wall-clock. That matches how these forms already behave
 * elsewhere in the app, so this helper preserves existing semantics rather than
 * silently changing them; unifying on the event timezone is the separate
 * program/agenda M7/M8 workstream (see docs/ROADMAP.md).
 */

/** UTC ISO instant → the `YYYY-MM-DDTHH:mm` string a datetime-local input expects (local wall-clock). */
export function toLocalDateTimeInput(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The value of a datetime-local input → a UTC ISO instant. Empty/invalid → null. */
export function fromLocalDateTimeInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value); // parsed as LOCAL by the platform — that's the point
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
