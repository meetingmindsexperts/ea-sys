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
import { kioskPinKeyAction, shouldTrapKioskTab } from "@/lib/kiosk-focus";

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

describe("kioskPinKeyAction", () => {
  /**
   * The pad shipped with an onClick and no key handler, so typing a PIN into it
   * did nothing at all — no error, no feedback, just a pad that ignored you.
   * Nothing about the screen looked wrong, which is why it survived four weeks.
   */
  it("reads every digit off the keyboard", () => {
    for (const d of "0123456789") {
      expect(kioskPinKeyAction(d)).toEqual({ action: "digit", digit: d });
    }
  });

  it("submits on Enter and deletes one digit on Backspace", () => {
    expect(kioskPinKeyAction("Enter")).toEqual({ action: "ok" });
    expect(kioskPinKeyAction("Backspace")).toEqual({ action: "back" });
  });

  /** Escape closes the pad here; the same key OPENS it from the scan screen.
   *  Neither direction leaves the kiosk — that still costs the PIN. */
  it("closes the pad on Escape", () => {
    expect(kioskPinKeyAction("Escape")).toEqual({ action: "close" });
  });

  it("ignores everything that is not a pad key", () => {
    for (const k of ["a", "Z", "Tab", " ", "F5", "ArrowLeft", "Shift", "-", ".", ""]) {
      expect(kioskPinKeyAction(k), `${k} should not reach the pad`).toBeNull();
    }
  });

  /**
   * ASCII digits only. The PIN is typed into a plain text field on the Check-In
   * page and compared as a string, and the pad's own buttons emit ASCII, so a
   * key that produced "١" could never match what a button can produce. Better
   * an unrecognised key than an entry that can never succeed.
   */
  it("does not accept non-ASCII numerals", () => {
    expect(kioskPinKeyAction("١")).toBeNull();
    expect(kioskPinKeyAction("٢")).toBeNull();
    expect(kioskPinKeyAction("１")).toBeNull();
  });

  /** A digit is a digit even while the scanner is idle — the guard that decides
   *  WHEN the pad listens is the pad's open state, not this function. */
  it("is a pure mapping with no notion of pad state", () => {
    expect(kioskPinKeyAction("7")).toEqual({ action: "digit", digit: "7" });
  });
});
