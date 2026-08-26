/**
 * Kiosk keyboard containment (Aug 26, 2026).
 *
 * THE HOLE THIS CLOSES, found by driving the kiosk in a browser rather than by
 * reading it. The kiosk renders inside the `(dashboard)` route group, so the
 * sidebar sits in the DOM behind the full-screen overlay with its links still
 * focusable. Fifteen Tabs from the scan screen put focus on `/dashboard` and
 * `/events/{id}/registrations`; Enter follows. The full delegate list, with
 * payment status and entry barcodes, one keypress from an attendee.
 *
 * It bypasses the exit PIN rather than defeating it: the PIN guards the
 * five-tap corner gesture and this route never goes near it. And the kiosk has
 * a keyboard attached BY DESIGN, because the barcode scanner is a keyboard
 * wedge — the hardware is already plugged in and facing the attendee.
 *
 * Pinned as a predicate because the regression is SILENT. Reopen the hole and
 * the kiosk still looks and behaves exactly the same; only the reachable
 * surface changes.
 */
import { describe, it, expect } from "vitest";
import { shouldTrapKioskTab } from "@/lib/kiosk-focus";

describe("shouldTrapKioskTab", () => {
  it("swallows Tab while the kiosk is scanning", () => {
    expect(shouldTrapKioskTab({ key: "Tab", exitPadOpen: false })).toBe(true);
  });

  it("lets Tab through once the staff exit PIN pad is open", () => {
    // The pad is a real form and needs Tab. It is also the one surface where
    // staff have already proven they are in control, by knowing the gesture.
    expect(shouldTrapKioskTab({ key: "Tab", exitPadOpen: true })).toBe(false);
  });

  it("leaves every other key alone, so the scanner still works", () => {
    // A keyboard-wedge scanner types the code then Enter. Trapping anything
    // beyond Tab would break the one thing the kiosk exists to do.
    for (const key of ["Enter", "a", "1", "-", "Escape", "Shift", "Backspace"]) {
      expect(shouldTrapKioskTab({ key, exitPadOpen: false })).toBe(false);
    }
  });

  it("covers Shift+Tab, which reports the same key", () => {
    // Backwards tabbing reaches the sidebar just as well as forwards. The
    // browser reports `key: "Tab"` either way, so one check covers both — but
    // only as long as nobody narrows this to a shiftKey-aware comparison.
    expect(shouldTrapKioskTab({ key: "Tab", exitPadOpen: false })).toBe(true);
  });
});
