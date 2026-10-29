"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Building2, Gift, Loader2, Printer, QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * The desk's Walk-in QR (docs/ONSITE_DESK_PLAN.md §8.1): exhibitors and
 * complimentary guests scan it and register themselves on their phone. One
 * QR per event and kind, valid to the end of the event's last day and the
 * same every time it is shown, so it can be printed and put up (owner, Oct
 * 29). Exhibitors type their own sponsor's code on the form.
 */

type Kind = "exhibitor" | "complimentary";

interface Options {
  webinar: boolean;
  registrationClosed: boolean;
  eventEnded: boolean;
  /** The event's timezone: the QR runs to the end of its last day there. */
  timezone: string;
  exhibitor: { rateName: string; validUntil: string; hasSponsorCodes: boolean } | null;
  complimentary: { rateName: string } | null;
}

interface ShownQr {
  url: string;
  qr: string;
  expiresAt: string;
}

const TITLE: Record<Kind, string> = {
  exhibitor: "Exhibitor registration",
  complimentary: "Complimentary registration",
};

const INSTRUCTION: Record<Kind, string> = {
  exhibitor: "Scan with your phone camera, fill in your details and enter the code your sponsor gave you. Show the barcode you receive at the registration desk.",
  complimentary: "Scan with your phone camera and fill in your details. Show the barcode you receive at the registration desk.",
};

/** "the end of 1 Dec 2026": the QR runs to the end of the event's last day, in its timezone. */
function validUntilLabel(iso: string, timeZone: string): string {
  try {
    return `the end of ${new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium", timeZone })}`;
  } catch {
    return `the end of ${new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" })}`;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** An A4 sheet with the QR, in a window of its own, printed with the browser's dialog. */
function printSheet(kind: Kind, shown: ShownQr, eventName: string, timeZone: string) {
  const win = window.open("", "_blank", "width=800,height=1000");
  if (!win) {
    toast.error("The print window was blocked. Allow pop-ups for this site and try again.");
    return;
  }
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(TITLE[kind])}</title>
<style>
  @page { size: A4; margin: 18mm; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #0f172a; text-align: center; margin: 0; }
  .event { font-size: 16pt; color: #475569; margin: 12mm 0 4mm; }
  h1 { font-size: 30pt; margin: 0 0 10mm; }
  img { width: 120mm; height: 120mm; image-rendering: pixelated; }
  p { font-size: 14pt; max-width: 150mm; margin: 8mm auto 0; line-height: 1.4; }
  .until { font-size: 11pt; color: #64748b; margin-top: 10mm; }
</style></head><body>
  <div class="event">${escapeHtml(eventName)}</div>
  <h1>${escapeHtml(TITLE[kind])}</h1>
  <img src="${shown.qr}" alt="QR code">
  <p>${escapeHtml(INSTRUCTION[kind])}</p>
  <div class="until">Valid until ${escapeHtml(validUntilLabel(shown.expiresAt, timeZone))}</div>
</body></html>`);
  win.document.close();
  // Print once the QR image has loaded, or the sheet prints blank.
  const img = win.document.querySelector("img");
  const go = () => {
    win.focus();
    win.print();
  };
  if (img && !img.complete) {
    img.addEventListener("load", go, { once: true });
    // A QR that will not draw must not leave a sheet that never prints.
    img.addEventListener("error", () => {
      win.close();
      toast.error("The QR could not be drawn for printing. Try Print again.");
    }, { once: true });
  } else go();
}

export function WalkInQrDialog({
  eventId,
  eventName,
  open,
  onClose,
}: {
  eventId: string;
  eventName: string;
  open: boolean;
  onClose: () => void;
}) {
  const [options, setOptions] = useState<Options | null>(null);
  const [kind, setKind] = useState<Kind>("exhibitor");
  const [shown, setShown] = useState<ShownQr | null>(null);
  const [loading, setLoading] = useState(false);
  // Only the latest request may show its QR: switching tab quickly must not
  // leave the other kind's QR on screen.
  const requestRef = useRef(0);

  /** Loads the QR for a tab, when the event offers it. */
  const showQr = useCallback((which: Kind, opts: Options) => {
    if (opts.registrationClosed || opts.eventEnded || !opts[which]) return;
    const requestId = ++requestRef.current;
    setShown(null);
    setLoading(true);
    fetch(`/api/events/${eventId}/registrations/desk-qr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: which }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (requestId !== requestRef.current) return;
        if (!res.ok) {
          toast.error(data.error || "Could not make the QR");
          return;
        }
        setShown(data);
      })
      .catch((err) => {
        console.error("[desk] walk-in QR failed", err);
        if (requestId === requestRef.current) toast.error("Network error: no QR was made. Choose the tab again to retry.");
      })
      .finally(() => {
        if (requestId === requestRef.current) setLoading(false);
      });
  }, [eventId]);

  const chooseTab = (which: Kind) => {
    setKind(which);
    if (options) showQr(which, options);
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch(`/api/events/${eventId}/registrations/desk-qr`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          toast.error(data.error || "Could not load the walk-in QR options");
          return;
        }
        const first: Kind = data.exhibitor ? "exhibitor" : "complimentary";
        setOptions(data);
        setKind(first);
        showQr(first, data);
      })
      .catch((err) => {
        console.error("[desk] walk-in QR options failed", err);
        if (!cancelled) toast.error("Network error: could not load the walk-in QR options");
      });
    return () => {
      cancelled = true;
    };
  }, [open, eventId, showQr]);

  const close = () => {
    requestRef.current++;
    setLoading(false);
    setShown(null);
    setOptions(null);
    onClose();
  };

  const unavailable = options && !options[kind];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[95vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="h-5 w-5 text-primary" /> Walk-in QR
          </DialogTitle>
          <DialogDescription>
            Show it on this screen or print it. They scan, fill in their details on their phone and show you the barcode they get.
          </DialogDescription>
        </DialogHeader>

        {!options && (
          <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        )}
        {options?.registrationClosed && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            Registration is switched off for this event, so the walk-in QR is too. Turn it on in Settings → Registration.
          </p>
        )}
        {options && !options.registrationClosed && options.eventEnded && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            This event has ended, so it has no walk-in QR.
          </p>
        )}
        {options && !options.registrationClosed && !options.eventEnded && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-1 rounded-lg border p-1">
              <Button type="button" variant={kind === "exhibitor" ? "default" : "ghost"} className="gap-1.5" onClick={() => chooseTab("exhibitor")}>
                <Building2 className="h-4 w-4" /> Exhibitors
              </Button>
              <Button type="button" variant={kind === "complimentary" ? "default" : "ghost"} className="gap-1.5" onClick={() => chooseTab("complimentary")}>
                <Gift className="h-4 w-4" /> Complimentary
              </Button>
            </div>

            {kind === "exhibitor" && options.exhibitor && !options.exhibitor.hasSponsorCodes && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                No sponsor has a code that covers the fee for exhibitors, so every scan would be refused. Add one in Promo Codes, with &ldquo;Sponsor covers the fee&rdquo; on.
              </p>
            )}
            {unavailable && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                {kind === "exhibitor"
                  ? "This event has no Exhibitor registration type with a rate that needs no approval. Check Registration Types."
                  : "This event has no Complimentary rate that needs no approval. Check Registration Types."}
              </p>
            )}

            {loading && !shown && (
              <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            )}
            {shown && !unavailable && (
              <div className="flex flex-col items-center gap-3 rounded-xl border bg-white p-6 text-center">
                <p className="text-xl font-semibold">{TITLE[kind]}</p>
                {/* eslint-disable-next-line @next/next/no-img-element -- a data URL from the API */}
                <img src={shown.qr} alt={`Scan to register: ${TITLE[kind]}`} className="h-64 w-64 max-w-full sm:h-72 sm:w-72" />
                <p className="max-w-md text-sm">{INSTRUCTION[kind]}</p>
                <p className="text-xs text-muted-foreground">Valid until {validUntilLabel(shown.expiresAt, options.timezone)}. The same QR every time, so a printed one keeps working. If you change the event&rsquo;s dates, print it again.</p>
                <Button type="button" variant="outline" className="gap-1.5" onClick={() => printSheet(kind, shown, eventName, options.timezone)}>
                  <Printer className="h-4 w-4" /> Print
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
