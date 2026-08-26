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
