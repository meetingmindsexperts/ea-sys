"use client";

/**
 * Self-service check-in kiosk (Aug 3, 2026, organizer request).
 *
 * Attendee-facing full-screen page: the attendee scans the barcode from their
 * confirmation email (or a printed badge, or a DTCM code — the check-in PUT
 * matches all forms), the platform checks them in and SILENTLY prints their
 * badge via Chrome's kiosk-printing integration.
 *
 * Deployment model (documented in the user guide):
 *  - The kiosk machine's DEFAULT printer is the badge printer.
 *  - Chrome is launched with `--kiosk --kiosk-printing <this page's URL>` —
 *    `--kiosk-printing` makes `window.print()` go straight to the default
 *    printer with no dialog. Without the flag a print DIALOG opens and
 *    modally eats every keystroke (the kiosk detects this and shows a staff
 *    note — see printBadge's dialogSuspected).
 *  - The browser is signed into an ONSITE (registration-desk) account before
 *    doors open — the page reuses the existing desk-permission APIs
 *    (check-in PUT + badges POST), so there is NO new auth surface.
 *
 * Policy decisions (owner, Aug 3 2026):
 *  - Already-checked-in scans REPRINT the badge (lost-badge self-service),
 *    soft-capped at KIOSK_REPRINT_CAP per registration per hour (review M3 —
 *    bounds badge farming from a photographed barcode; the cap is kiosk-local
 *    and resets on reload, which staff supervision covers).
 *  - The kiosk NEVER overrides payment/cancelled gates — those attendees are
 *    referred to the registration desk (overrides stay a deliberate, audited
 *    staff action on the desk surfaces).
 *  - Leaving kiosk view requires the machine's exit PIN (review H1 — the
 *    kiosk runs under a staff session, so the exit path must prove staff
 *    presence). The PIN is MACHINE-LOCAL (localStorage, set from the staff
 *    Check-In page's Kiosk mode dialog) because it is a device lock, not
 *    event data — and ONSITE staff can't write event settings anyway. With
 *    no PIN set, the only exit is closing the kiosk window.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ScanBarcode,
  CheckCircle2,
  AlertTriangle,
  Printer,
  Loader2,
  ShieldAlert,
  Delete,
} from "lucide-react";
import { useEvent, useOrgBranding } from "@/hooks/use-api";
import { readBadgePolicy } from "@/lib/badge-layout";
import { formatPersonName } from "@/lib/utils";
import { playBeep } from "@/lib/scan-feedback";
import { readKioskExitPin } from "@/lib/kiosk-exit-pin";
import { shouldTrapKioskTab } from "@/lib/kiosk-focus";

/** Max self-service badge REPRINTS per registration per rolling hour. */
const KIOSK_REPRINT_CAP = 3;

type KioskState =
  | { kind: "idle" }
  | { kind: "processing" }
  | {
      kind: "success";
      name: string;
      /** true = already-checked-in rescan → badge reprint, not a new check-in */
      reprint: boolean;
      /** false when the badge PDF fetch/print failed after a committed check-in */
      printed: boolean;
      /** staff hint: a print dialog opened ⇒ --kiosk-printing is missing */
      dialogSuspected: boolean;
    }
  | { kind: "denied"; title: string; detail: string }
  /** Persistent staff-attention state (session expired / forbidden) — never
   *  auto-resets; every attendee would otherwise be told their code is bad
   *  (review H3: the 24h JWT WILL expire on day 2 of a multi-day event). */
  | { kind: "staff-needed"; detail: string };

interface PrintResult {
  ok: boolean;
  /** print() blocked >1.5s ⇒ a print DIALOG opened ⇒ Chrome was launched
   *  WITHOUT --kiosk-printing. The dialog modally eats every keystroke, so
   *  the kiosk looks dead to the next scanner — surface it to staff. */
  dialogSuspected: boolean;
}

/**
 * Fetch the single-registration badge PDF and print it silently via a hidden
 * iframe. Under `chrome --kiosk-printing` the print() goes straight to the
 * default printer; without the flag (dev/testing) Chrome shows the dialog.
 * Resolves once print() has been CALLED (not when paper comes out — the
 * spooler owns that); iframe/blob cleanup is detached on a long timer so the
 * PDF stays alive while Chrome hands it to the spooler.
 *
 * NEVER throws (review H2): a network error here happens AFTER the check-in
 * committed, so it must surface as "checked in, badge didn't print" — not as
 * the outer catch's "you were NOT checked in".
 */
async function printBadge(eventId: string, registrationId: string): Promise<PrintResult> {
  try {
    const res = await fetch(`/api/events/${eventId}/registrations/badges`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registrationIds: [registrationId] }),
    });
    if (!res.ok) {
      console.error("[kiosk] badge fetch failed", res.status);
      return { ok: false, dialogSuspected: false };
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);

    return await new Promise<PrintResult>((resolve) => {
      const iframe = document.createElement("iframe");
      iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
      iframe.src = url;
      // A PDF that never fires onload (corrupt/blocked) must not wedge the kiosk.
      const failSafe = setTimeout(() => {
        console.error("[kiosk] badge iframe never loaded");
        iframe.remove();
        URL.revokeObjectURL(url);
        resolve({ ok: false, dialogSuspected: false });
      }, 10000);
      iframe.onload = () => {
        clearTimeout(failSafe);
        try {
          // NO contentWindow.focus() here — it invites keyboard focus into the
          // PDF iframe, so the NEXT attendee's scan (keyboard-wedge burst)
          // could land in the iframe instead of the scan input. print() works
          // without focus.
          const t0 = Date.now();
          iframe.contentWindow?.print();
          // Under --kiosk-printing print() returns immediately (silent print);
          // a real dialog blocks synchronously until someone dismisses it.
          const dialogSuspected = Date.now() - t0 > 1500;
          if (dialogSuspected) {
            console.warn(
              "[kiosk] print dialog detected — relaunch Chrome with --kiosk-printing for silent badge printing",
            );
          }
          resolve({ ok: true, dialogSuspected });
        } catch (err) {
          console.error("[kiosk] print() failed", err);
          resolve({ ok: false, dialogSuspected: false });
        }
        // Detached cleanup — keep the document alive for the spooler handoff.
        setTimeout(() => {
          iframe.remove();
          URL.revokeObjectURL(url);
        }, 20000);
      };
      document.body.appendChild(iframe);
    });
  } catch (err) {
    console.error("[kiosk] badge print failed", err);
    return { ok: false, dialogSuspected: false };
  }
}

const RESET_MS = { success: 8000, denied: 10000 } as const;

const PIN_PAD_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "ok"] as const;

export default function KioskCheckInPage() {
  const params = useParams();
  const router = useRouter();
  const eventId = params.eventId as string;
  const { data: event } = useEvent(eventId);
  // Organiser branding. The kiosk is the most public-facing screen in the whole
  // dashboard — it stands in a hotel lobby facing a queue — and it was the one
  // surface still hardcoded to EA-SYS's own cerulean, so a customer's event ran
  // under our colours. `useOrgBranding` is the same source the sidebar and the
  // public event pages read, so the three cannot show different marks.
  const { data: branding } = useOrgBranding();
  // Reprint is OFF unless the organiser switched it on for this event
  // (Settings -> Registration -> Badge). Read through the shared reader so the
  // kiosk and the settings form cannot disagree about what the blob means.
  const allowReprint = readBadgePolicy(event?.settings).allowKioskReprint;
  // Read through a ref so the scan handler is not re-created (and its debounce
  // state reset) every time the event query refetches.
  const allowReprintRef = useRef(allowReprint);
  allowReprintRef.current = allowReprint;

  const [state, setState] = useState<KioskState>({ kind: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState("");
  const lastScanRef = useRef("");
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);
  // Staff exit: 5 rapid taps on the (invisible) corner target open a PIN pad.
  const exitTapsRef = useRef<number[]>([]);
  const [exitOpen, setExitOpen] = useState(false);
  const exitOpenRef = useRef(false);
  const [pinValue, setPinValue] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const exitCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // M3: kiosk-local reprint log — registrationId → print timestamps (last hour).
  const reprintLogRef = useRef<Map<string, number[]>>(new Map());

  /**
   * Reclaim keyboard focus for the scan input. Chrome's PDF viewer steals
   * BROWSER-LEVEL frame focus when the hidden print iframe loads — and a
   * plain `focus()` on an element that is already the document's
   * activeElement is a no-op, so it never wins focus back from the iframe.
   * A blur→focus cycle forces a real focus claim. Called at every known
   * steal point (after a badge print, on reset); the 1s interval below uses
   * the cheap path for ordinary drift.
   */
  const reclaimFocus = useCallback(() => {
    if (exitOpenRef.current) return;
    const el = inputRef.current;
    if (!el) return;
    if (document.activeElement === el) el.blur();
    el.focus();
  }, []);

  const scheduleReset = useCallback(
    (ms: number) => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(() => {
        setState((cur) => (cur.kind === "staff-needed" ? cur : { kind: "idle" }));
        reclaimFocus();
      }, ms);
    },
    [reclaimFocus],
  );

  // The scanner is a keyboard-wedge device — the hidden input must ALWAYS hold
  // focus or scans silently vanish (the #1 real-world kiosk failure).
  useEffect(() => {
    inputRef.current?.focus();
    const refocus = () => {
      if (!exitOpenRef.current) inputRef.current?.focus();
    };
    document.addEventListener("click", refocus);
    // Tab must not leave the kiosk.
    //
    // This page renders INSIDE the (dashboard) route group, so the sidebar is
    // still in the DOM behind the full-screen overlay — invisible, but its
    // links are focusable. Tab a few times and focus lands on /dashboard or
    // /events/{id}/registrations; Enter follows it, and an attendee is looking
    // at the full delegate list with payment status and entry barcodes.
    //
    // That is not a way around the exit PIN, it is a way past it: the PIN
    // guards the on-screen 5-tap gesture, and this route never touches it. It
    // matters here specifically BECAUSE the kiosk has a keyboard attached by
    // design — the barcode scanner is a keyboard wedge, so the hardware needed
    // to do it is already plugged in and pointed at the attendee.
    //
    // Capture phase, so it runs before anything else can act on the key. The
    // 1s reclaim below already pulls focus back, but a second is far longer
    // than Tab-then-Enter takes.
    const trapTab = (event: KeyboardEvent) => {
      if (!shouldTrapKioskTab({ key: event.key, exitPadOpen: exitOpenRef.current })) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", trapTab, true);
    // 1s belt-and-braces: if ANYTHING steals focus the window where a scan
    // silently vanishes stays under a second. Uses the forced blur→focus
    // cycle (frame-focus reclaim), but ONLY while the input is empty — never
    // mid-scanner-burst (a burst finishes in ~150ms and fills the input).
    const interval = setInterval(() => {
      if (exitOpenRef.current) return;
      const el = inputRef.current;
      if (!el) return;
      if (el.value === "") {
        if (document.activeElement === el) el.blur();
        el.focus();
      } else if (document.activeElement !== el) {
        el.focus();
      }
    }, 1000);
    return () => {
      document.removeEventListener("click", refocus);
      document.removeEventListener("keydown", trapTab, true);
      clearInterval(interval);
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      if (exitCloseTimerRef.current) clearTimeout(exitCloseTimerRef.current);
    };
  }, []);

  /** M3: record a reprint for this registration and report whether the
   *  rolling-hour cap is exhausted. */
  const reprintCapExceeded = useCallback((registrationId: string): boolean => {
    const now = Date.now();
    const log = (reprintLogRef.current.get(registrationId) ?? []).filter(
      (t) => now - t < 60 * 60 * 1000,
    );
    if (log.length >= KIOSK_REPRINT_CAP) {
      reprintLogRef.current.set(registrationId, log);
      return true;
    }
    log.push(now);
    reprintLogRef.current.set(registrationId, log);
    return false;
  }, []);

  const handleScan = useCallback(
    async (code: string) => {
      const trimmed = code.trim();
      // M1: clear the input on EVERY path — a debounced/busy early-return must
      // not leave residue that concatenates into the next attendee's scan.
      setInput("");
      if (!trimmed) return;
      if (state.kind === "staff-needed") return;
      if (busyRef.current) {
        // M2: a scan during the busy window must not vanish silently.
        console.warn("[kiosk] scan ignored — previous scan still processing");
        playBeep(false);
        return;
      }

      // Debounce the same code for 3s — scanners often fire twice per pull.
      if (trimmed === lastScanRef.current) return;
      lastScanRef.current = trimmed;
      setTimeout(() => {
        if (lastScanRef.current === trimmed) lastScanRef.current = "";
      }, 3000);

      busyRef.current = true;
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      setState({ kind: "processing" });

      try {
        const res = await fetch(`/api/events/${eventId}/registrations/_/check-in`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ qrCode: trimmed, kiosk: true }),
        });

        // H3: auth/server failures must NOT masquerade as "code not
        // recognised" — a kiosk session WILL expire on day 2, and blaming
        // every attendee's badge with no staff signal is the worst outcome.
        if (res.status === 401 || res.status === 403) {
          console.error("[kiosk] kiosk session rejected", res.status);
          playBeep(false);
          setState({
            kind: "staff-needed",
            detail:
              "The kiosk has been signed out. Staff: close this window and relaunch the kiosk after signing in again.",
          });
          return;
        }
        if (res.status === 429 || res.status >= 500) {
          console.error("[kiosk] server error on scan", res.status);
          playBeep(false);
          setState({
            kind: "denied",
            title: "The system is busy",
            detail: "Please try scanning again in a moment.",
          });
          scheduleReset(RESET_MS.denied);
          return;
        }

        const data = await res.json();

        if (res.ok) {
          const name = formatPersonName(
            data.attendee?.title,
            data.attendee?.firstName || "",
            data.attendee?.lastName || "",
          );
          playBeep(true);
          const print = await printBadge(eventId, data.id);
          setState({
            kind: "success",
            name,
            reprint: false,
            printed: print.ok,
            dialogSuspected: print.dialogSuspected,
          });
          scheduleReset(RESET_MS.success);
          return;
        }

        if (data.code === "ALREADY_CHECKED_IN") {
          // Reprint is opt-in per event (owner, Aug 25 2026). Off by default:
          // an attendee prints once, and a second copy is a staffed action.
          // When it IS on, the original lost-badge self-service applies, still
          // soft-capped (M3) so a photographed barcode cannot farm badges.
          if (!allowReprintRef.current) {
            playBeep(false);
            setState({
              kind: "denied",
              title: "Already checked in",
              detail: "You're already checked in. For a badge reprint, please visit the registration desk.",
            });
            scheduleReset(RESET_MS.denied);
            return;
          }
          if (!data.registration) {
            // L1: a shape regression upstream must not read as "bad code".
            playBeep(false);
            setState({
              kind: "denied",
              title: "Already checked in",
              detail: "You're already checked in. For a badge reprint, please visit the registration desk.",
            });
            scheduleReset(RESET_MS.denied);
            return;
          }
          if (reprintCapExceeded(data.registration.id)) {
            console.warn("[kiosk] reprint cap reached", data.registration.id);
            playBeep(false);
            setState({
              kind: "denied",
              title: "Badge already printed",
              detail: "This badge has been reprinted several times. For another copy, please visit the registration desk.",
            });
            scheduleReset(RESET_MS.denied);
            return;
          }
          const name = formatPersonName(
            data.registration.attendee?.title,
            data.registration.attendee?.firstName || "",
            data.registration.attendee?.lastName || "",
          );
          playBeep(true);
          const print = await printBadge(eventId, data.registration.id);
          setState({
            kind: "success",
            name,
            reprint: true,
            printed: print.ok,
            dialogSuspected: print.dialogSuspected,
          });
          scheduleReset(RESET_MS.success);
          return;
        }

        playBeep(false);
        const denial: Record<string, { title: string; detail: string }> = {
          PAYMENT_REQUIRED: {
            title: "Payment pending",
            detail: "There's a payment pending on your registration.",
          },
          CANCELLED: {
            title: "Registration cancelled",
            detail: "This registration has been cancelled.",
          },
        };
        const d = denial[data.code as string] ?? {
          title: "Code not recognised",
          detail: "We couldn't find this code for this event.",
        };
        setState({ kind: "denied", ...d });
        scheduleReset(RESET_MS.denied);
      } catch (err) {
        console.error("[kiosk] scan failed", err);
        playBeep(false);
        // Let an immediate retry of the same badge through after a network blip.
        lastScanRef.current = "";
        setState({
          kind: "denied",
          title: "Connection problem",
          detail: "You were NOT checked in. Please try again in a moment.",
        });
        scheduleReset(RESET_MS.denied);
      } finally {
        busyRef.current = false;
        setInput("");
        // Forced reclaim — after a badge print the PDF iframe holds frame
        // focus and a plain focus() is a no-op (see reclaimFocus).
        reclaimFocus();
      }
    },
    [eventId, scheduleReset, reclaimFocus, reprintCapExceeded, state.kind],
  );

  // ── Staff exit (H1): 5 rapid taps open a PIN pad; the PIN is machine-local.
  const closeExitPad = useCallback(() => {
    setExitOpen(false);
    exitOpenRef.current = false;
    setPinValue("");
    setPinError(null);
    if (exitCloseTimerRef.current) clearTimeout(exitCloseTimerRef.current);
    inputRef.current?.focus();
  }, []);

  const armExitAutoClose = useCallback(() => {
    if (exitCloseTimerRef.current) clearTimeout(exitCloseTimerRef.current);
    exitCloseTimerRef.current = setTimeout(closeExitPad, 20000);
  }, [closeExitPad]);

  const handleExitTap = () => {
    const now = Date.now();
    exitTapsRef.current = [...exitTapsRef.current.filter((t) => now - t < 3000), now];
    if (exitTapsRef.current.length >= 5) {
      exitTapsRef.current = [];
      setExitOpen(true);
      exitOpenRef.current = true;
      setPinValue("");
      setPinError(null);
      armExitAutoClose();
    }
  };

  const handlePinKey = (key: (typeof PIN_PAD_KEYS)[number]) => {
    armExitAutoClose();
    if (key === "clear") {
      setPinValue("");
      setPinError(null);
      return;
    }
    if (key === "ok") {
      if (pinValue.length > 0 && pinValue === readKioskExitPin()) {
        router.push(`/events/${eventId}/check-in`);
        return;
      }
      console.warn("[kiosk] wrong exit PIN entered");
      setPinError("Wrong PIN");
      setPinValue("");
      return;
    }
    setPinError(null);
    setPinValue((v) => (v.length >= 8 ? v : v + key));
  };

  const pinConfigured = exitOpen && readKioskExitPin().length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center text-white select-none"
      /* Derived from --primary, which OrgTheme has already set to the
         organisation's brand colour further up the tree. An org that has set no
         colour keeps the app default, so this reproduces the previous cerulean
         exactly rather than changing it for everyone. Inline rather than a
         Tailwind class because the stops are computed from a CSS variable. */
      style={{
        backgroundImage: [
          "linear-gradient(to bottom right,",
          "var(--primary),",
          "color-mix(in oklch, var(--primary) 82%, black),",
          "color-mix(in oklch, var(--primary) 58%, black))",
        ].join(" "),
      }}
    >
      {/* Keyboard-wedge target — visually hidden, always focused */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleScan(input);
        }}
        className="absolute h-0 w-0 overflow-hidden"
      >
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          autoFocus
          aria-label="Barcode scan input"
        />
      </form>

      {/* Organiser mark + event name */}
      <div className="absolute top-8 inset-x-0 flex flex-col items-center gap-3 px-8">
        {branding?.logo && (
          /* On a white chip, not bare: a logo is supplied on the assumption of
             a light background, and a dark mark laid straight onto the brand
             gradient disappears. eslint-disable for the same reason the sidebar
             does — these are organiser-uploaded paths, not build-time assets. */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={branding.logo}
            alt={branding.name ?? "Organiser"}
            className="h-16 w-auto max-w-[320px] rounded-2xl bg-white/95 object-contain px-5 py-3 shadow-lg"
          />
        )}
        <p className="text-2xl font-semibold text-white/90 truncate max-w-full">
          {event?.name ?? ""}
        </p>
      </div>

      {state.kind === "idle" && (
        <div className="flex flex-col items-center text-center px-8">
          <div className="mb-10 rounded-full bg-white/15 p-10 animate-pulse">
            <ScanBarcode className="h-28 w-28" />
          </div>
          <h1 className="text-5xl font-bold mb-4">Welcome!</h1>
          <p className="text-2xl text-white/90 max-w-xl">
            Scan the barcode from your confirmation email to check in and print your badge.
          </p>
        </div>
      )}

      {state.kind === "processing" && (
        <div className="flex flex-col items-center text-center px-8">
          <Loader2 className="h-24 w-24 animate-spin mb-8" />
          <h1 className="text-4xl font-bold">One moment…</h1>
        </div>
      )}

      {state.kind === "success" && (
        <div className="flex flex-col items-center text-center px-8">
          <div className="mb-8 rounded-full bg-emerald-400/25 p-8">
            <CheckCircle2 className="h-28 w-28 text-emerald-300" />
          </div>
          <h1 className="text-5xl font-bold mb-4">
            {state.reprint ? "You're already checked in" : `Welcome, ${state.name}!`}
          </h1>
          {state.reprint && <p className="text-3xl mb-4">{state.name}</p>}
          {state.printed ? (
            <p className="flex items-center gap-3 text-2xl text-white/90">
              <Printer className="h-7 w-7" />
              {state.reprint ? "Printing your badge again…" : "Your badge is printing…"}
            </p>
          ) : (
            <p className="text-2xl text-amber-200 max-w-xl">
              {state.reprint
                ? "We couldn't print your badge — please visit the registration desk."
                : "You're checked in, but the badge didn't print — please visit the registration desk."}
            </p>
          )}
          {state.dialogSuspected && (
            <p className="mt-8 text-sm text-amber-200/90 max-w-xl">
              Staff note: a print dialog opened — relaunch Chrome with{" "}
              <code className="font-mono">--kiosk-printing</code> for silent badge printing.
            </p>
          )}
        </div>
      )}

      {state.kind === "denied" && (
        <div className="flex flex-col items-center text-center px-8">
          <div className="mb-8 rounded-full bg-amber-400/25 p-8">
            <AlertTriangle className="h-28 w-28 text-amber-300" />
          </div>
          <h1 className="text-5xl font-bold mb-4">{state.title}</h1>
          <p className="text-2xl text-white/90 max-w-xl mb-6">{state.detail}</p>
          <p className="text-2xl font-semibold">
            Please visit the registration desk — our team will help you.
          </p>
        </div>
      )}

      {state.kind === "staff-needed" && (
        <div className="flex flex-col items-center text-center px-8">
          <div className="mb-8 rounded-full bg-red-400/25 p-8">
            <ShieldAlert className="h-28 w-28 text-red-300" />
          </div>
          <h1 className="text-5xl font-bold mb-4">Kiosk needs attention</h1>
          <p className="text-2xl text-white/90 max-w-xl">{state.detail}</p>
          <p className="mt-6 text-2xl font-semibold">
            Please check in at the registration desk.
          </p>
        </div>
      )}

      {/* Staff exit PIN pad (H1) */}
      {exitOpen && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60">
          <div className="rounded-2xl bg-white text-slate-900 p-8 w-[340px] shadow-2xl">
            {pinConfigured ? (
              <>
                <p className="text-center font-semibold mb-1">Staff exit</p>
                <p className="text-center text-sm text-slate-500 mb-4">Enter this kiosk&apos;s exit PIN</p>
                <div className="h-10 mb-2 flex items-center justify-center text-2xl tracking-[0.5em] font-mono">
                  {"•".repeat(pinValue.length)}
                </div>
                {pinError && <p className="text-center text-sm text-red-600 mb-2">{pinError}</p>}
                <div className="grid grid-cols-3 gap-2">
                  {PIN_PAD_KEYS.map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => handlePinKey(k)}
                      className={`h-14 rounded-lg text-xl font-semibold flex items-center justify-center ${
                        k === "ok"
                          ? "bg-[#00aade] text-white"
                          : "bg-slate-100 hover:bg-slate-200"
                      }`}
                    >
                      {k === "clear" ? <Delete className="h-5 w-5" /> : k === "ok" ? "OK" : k}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <p className="text-center font-semibold mb-2">Staff exit</p>
                <p className="text-sm text-slate-600">
                  No exit PIN is set on this machine. To leave kiosk view, close the kiosk window
                  (Alt+F4 / Cmd+Q). You can set a PIN from the Check-In page&apos;s{" "}
                  <strong>Kiosk mode</strong> button next time.
                </p>
              </>
            )}
            <button
              type="button"
              onClick={closeExitPad}
              className="mt-4 w-full h-11 rounded-lg bg-slate-100 hover:bg-slate-200 text-sm font-medium"
            >
              Back to check-in
            </button>
          </div>
        </div>
      )}

      {/* Staff exit target: invisible; 5 rapid taps open the PIN pad */}
      <button
        type="button"
        onClick={handleExitTap}
        aria-label="Staff exit"
        className="absolute bottom-0 right-0 h-16 w-16 bg-transparent"
      />
    </div>
  );
}
