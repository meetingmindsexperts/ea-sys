/**
 * Keyboard containment for the self-service check-in kiosk.
 *
 * The kiosk page renders INSIDE the `(dashboard)` route group, so the sidebar
 * is still in the DOM behind the full-screen overlay. It is invisible, but its
 * links are focusable: Tab a few times from the kiosk and focus lands on
 * `/dashboard` or `/events/{id}/registrations`, and Enter follows it. An
 * attendee is then looking at the full delegate list with payment status and
 * entry barcodes.
 *
 * That is not a way AROUND the exit PIN, it is a way PAST it. The PIN guards
 * the on-screen five-tap gesture and this route never touches it. And it
 * matters here specifically because the kiosk has a keyboard attached BY
 * DESIGN — the barcode scanner is a keyboard wedge — so the hardware needed to
 * do it is already plugged in and pointed at the attendee.
 *
 * The decision lives here rather than inline in the page because it is a
 * security control, and its regression is silent: nothing looks broken when
 * the hole reopens.
 */

/**
 * Should this keystroke be swallowed to keep focus inside the kiosk?
 *
 * The exit PIN pad is deliberately exempt. It is a real form that needs Tab to
 * work, and it is the one surface where staff are already in control — they
 * have proven that by knowing the gesture and the PIN.
 */
export function shouldTrapKioskTab(args: {
  key: string;
  /** True while the staff exit PIN pad is showing. */
  exitPadOpen: boolean;
}): boolean {
  if (args.exitPadOpen) return false;
  // Shift+Tab reports the same `key`, so this covers both directions.
  return args.key === "Tab";
}

/** What a keystroke means to the staff exit PIN pad. */
export type KioskPinAction =
  | { action: "digit"; digit: string }
  | { action: "ok" }
  | { action: "back" }
  | { action: "close" };

/**
 * Map a keystroke onto a PIN-pad action, or null for "not ours".
 *
 * The pad shipped as buttons with an onClick and nothing else — no text input,
 * no key handler — so a staff member could stand there typing their PIN into a
 * pad that could not hear them. It looked completely normal, which is why it
 * went unnoticed for four weeks and why the mapping is pinned here rather than
 * left inline.
 *
 * It does not widen the exit (review H1). Tab is already exempt while the pad
 * is open, so Tab-to-a-digit-then-Enter always worked; keyboard entry was
 * possible, just laborious. The control is the PIN itself, never the input
 * device — which is the only defensible position on a machine whose barcode
 * scanner is a keyboard wedge.
 */
export function kioskPinKeyAction(key: string): KioskPinAction | null {
  // Escape CLOSES the pad here. Elsewhere it opens it; it never leaves the
  // kiosk, in either direction.
  if (key === "Escape") return { action: "close" };
  if (key === "Enter") return { action: "ok" };
  if (key === "Backspace") return { action: "back" };
  // ASCII digits only. A PIN is set from a plain text field on the Check-In
  // page and compared as a string, so accepting other numeral forms here would
  // let a key match a pad button that could never produce the same character.
  if (/^[0-9]$/.test(key)) return { action: "digit", digit: key };
  return null;
}
