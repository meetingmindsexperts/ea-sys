/**
 * Kiosk exit-PIN storage (review H1). The self-service check-in kiosk runs
 * full-screen under a staff (ONSITE) session, so LEAVING kiosk view must
 * prove staff presence — otherwise 5 taps hands an attendee the desk surface.
 *
 * The PIN is deliberately MACHINE-LOCAL (localStorage), not event data:
 * it is a device lock for the physical kiosk machine, and ONSITE staff (who
 * run kiosks) can't write event settings anyway. Set from the staff Check-In
 * page's "Kiosk mode" dialog; read by the kiosk page's exit PIN pad.
 */
export const KIOSK_EXIT_PIN_STORAGE_KEY = "ea-sys:kiosk-exit-pin";

export function readKioskExitPin(): string {
  try {
    return localStorage.getItem(KIOSK_EXIT_PIN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function writeKioskExitPin(pin: string): void {
  try {
    if (pin) localStorage.setItem(KIOSK_EXIT_PIN_STORAGE_KEY, pin);
    else localStorage.removeItem(KIOSK_EXIT_PIN_STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode) — the kiosk page treats "no PIN" as
    // exit-by-closing-the-window, which is the safe default.
  }
}
