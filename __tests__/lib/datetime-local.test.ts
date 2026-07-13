/**
 * datetime-local round-trip (Survey/RSVP review B2).
 *
 * A `<input type="datetime-local">` has NO timezone — the browser reads its
 * value as LOCAL wall-clock. The dinner console used `iso.slice(0, 16)` to fill
 * it, which drops the *UTC* wall-clock into an input the browser then reads as
 * *local*. Saving (`new Date(v).toISOString()`) therefore shifted the instant by
 * the UTC offset on every single save, compounding each time.
 *
 * These pin the invariant that actually matters: read-back then write-back must
 * be the IDENTITY.
 */
import { describe, it, expect } from "vitest";
import { toLocalDateTimeInput, fromLocalDateTimeInput } from "@/lib/datetime-local";

describe("datetime-local round-trip", () => {
  it("is lossless: instant → input → instant returns the SAME instant", () => {
    const original = new Date("2026-08-01T15:00:00.000Z").toISOString();

    const shown = toLocalDateTimeInput(original); // what the edit dialog displays
    const saved = fromLocalDateTimeInput(shown); // what Save sends back

    expect(saved).toBe(original); // ← the whole point: no drift
  });

  it("stays stable across repeated edit/save cycles (the compounding bug)", () => {
    let current = new Date("2026-08-01T15:00:00.000Z").toISOString();

    // Open the dialog and hit Save five times without touching the field.
    for (let i = 0; i < 5; i++) {
      current = fromLocalDateTimeInput(toLocalDateTimeInput(current))!;
    }

    // The old slice-based code moved the dinner by the UTC offset EACH time.
    expect(current).toBe("2026-08-01T15:00:00.000Z");
  });

  it("regression: the old `iso.slice(0,16)` approach is NOT the inverse of the save", () => {
    const original = "2026-08-01T15:00:00.000Z";

    const oldShown = original.slice(0, 16); // "2026-08-01T15:00" — the UTC wall-clock
    const oldSaved = new Date(oldShown).toISOString(); // browser parses it as LOCAL

    // In any timezone that isn't UTC, this silently moves the dinner.
    const offsetMinutes = new Date(original).getTimezoneOffset();
    if (offsetMinutes !== 0) {
      expect(oldSaved).not.toBe(original); // ← the bug, reproduced
    }
    // The new helper is correct in every timezone.
    expect(fromLocalDateTimeInput(toLocalDateTimeInput(original))).toBe(original);
  });

  it("renders a datetime-local-shaped string (YYYY-MM-DDTHH:mm)", () => {
    expect(toLocalDateTimeInput("2026-08-01T15:00:00.000Z")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("handles empty / invalid input without throwing", () => {
    expect(fromLocalDateTimeInput("")).toBeNull();
    expect(fromLocalDateTimeInput("not-a-date")).toBeNull();
    expect(toLocalDateTimeInput("not-a-date")).toBe("");
  });

  it("accepts a Date as well as an ISO string", () => {
    const d = new Date("2026-08-01T15:00:00.000Z");
    expect(toLocalDateTimeInput(d)).toBe(toLocalDateTimeInput(d.toISOString()));
  });
});
