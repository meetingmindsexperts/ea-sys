"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Building2, Gift, Loader2, QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCountdown } from "./desk-onsite";

/**
 * The desk's Walk-in QR (docs/ONSITE_DESK_PLAN.md §8.1): a QR on the desk
 * screen that exhibitors and complimentary guests scan to register themselves.
 * Each QR works for 30 minutes and is renewed every 15 while this stays open,
 * so the one on screen always has at least 15 minutes left. Screen only:
 * printing is deferred (§8.7).
 */

type Kind = "exhibitor" | "complimentary";

interface SponsorOption {
  promoCodeId: string;
  code: string;
  sponsorName: string;
  placesLeft: number | null;
}

interface Options {
  webinar: boolean;
  exhibitor: { rateName: string; sponsors: SponsorOption[] } | null;
  complimentary: { rateName: string } | null;
}

interface ShownQr {
  url: string;
  qr: string;
  expiresAt: string;
}

const RENEW_AFTER_MS = 15 * 60_000;

function sponsorLabel(s: SponsorOption): string {
  const places = s.placesLeft === null ? "" : ` · ${s.placesLeft} place${s.placesLeft === 1 ? "" : "s"} left`;
  return `${s.sponsorName} (${s.code})${places}`;
}

export function WalkInQrDialog({ eventId, open, onClose }: { eventId: string; open: boolean; onClose: () => void }) {
  const [options, setOptions] = useState<Options | null>(null);
  const [kind, setKind] = useState<Kind>("exhibitor");
  const [promoCodeId, setPromoCodeId] = useState<string>("");
  const [shown, setShown] = useState<ShownQr | null>(null);
  const [loading, setLoading] = useState(false);
  // Only the latest request may show its QR: switching tab or sponsor quickly
  // must not leave an older sponsor's QR on screen.
  const requestRef = useRef(0);
  const countdown = useCountdown(shown?.expiresAt ?? null);

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
        setOptions(data);
        setKind(data.exhibitor ? "exhibitor" : "complimentary");
      })
      .catch((err) => {
        console.error("[desk] walk-in QR options failed", err);
        if (!cancelled) toast.error("Network error: could not load the walk-in QR options");
      });
    return () => {
      cancelled = true;
    };
  }, [open, eventId]);

  const showQr = useCallback(async (which: Kind, codeId: string) => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/events/${eventId}/registrations/desk-qr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(which === "exhibitor" ? { kind: which, promoCodeId: codeId } : { kind: which }),
      });
      const data = await res.json().catch(() => ({}));
      if (requestId !== requestRef.current) return;
      if (!res.ok) {
        toast.error(data.error || "Could not make the QR");
        setShown(null);
        return;
      }
      setShown(data);
    } catch (err) {
      console.error("[desk] walk-in QR failed", err);
      if (requestId === requestRef.current) toast.error("Network error: no QR was made");
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [eventId]);

  // A QR for the current choice: complimentary at once, exhibitors once a sponsor is picked.
  useEffect(() => {
    if (!open || !options) return;
    setShown(null);
    if (kind === "complimentary" && options.complimentary) void showQr("complimentary", "");
    if (kind === "exhibitor" && promoCodeId) void showQr("exhibitor", promoCodeId);
  }, [open, options, kind, promoCodeId, showQr]);

  // Renewed while it is on screen, so it never runs out in front of the queue.
  useEffect(() => {
    if (!open || !shown) return;
    const timer = setTimeout(() => void showQr(kind, promoCodeId), RENEW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [open, shown, kind, promoCodeId, showQr]);

  const close = () => {
    requestRef.current++;
    setShown(null);
    setPromoCodeId("");
    setOptions(null);
    onClose();
  };

  const exhibitor = options?.exhibitor ?? null;
  const complimentary = options?.complimentary ?? null;
  const title = kind === "exhibitor" ? "Exhibitor registration" : "Complimentary registration";
  const sponsor = exhibitor?.sponsors.find((s) => s.promoCodeId === promoCodeId);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[95vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="h-5 w-5 text-primary" /> Walk-in QR
          </DialogTitle>
          <DialogDescription>
            Turn this screen to the queue. They scan, fill in their details on their phone and show you the barcode they get.
          </DialogDescription>
        </DialogHeader>

        {!options ? (
          <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-1 rounded-lg border p-1">
              <Button type="button" variant={kind === "exhibitor" ? "default" : "ghost"} className="gap-1.5" onClick={() => setKind("exhibitor")}>
                <Building2 className="h-4 w-4" /> Exhibitors
              </Button>
              <Button type="button" variant={kind === "complimentary" ? "default" : "ghost"} className="gap-1.5" onClick={() => setKind("complimentary")}>
                <Gift className="h-4 w-4" /> Complimentary
              </Button>
            </div>

            {kind === "exhibitor" && !exhibitor && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                This event has no Exhibitor registration type with a rate. Add one in Registration Types first.
              </p>
            )}
            {kind === "exhibitor" && exhibitor && exhibitor.sponsors.length === 0 && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                No sponsor has a code that covers the fee for exhibitors. Add one in Promo Codes, with &ldquo;Sponsor covers the fee&rdquo; on.
              </p>
            )}
            {kind === "exhibitor" && exhibitor && exhibitor.sponsors.length > 0 && (
              <div className="space-y-1.5">
                <Label>Sponsor</Label>
                <Select value={promoCodeId} onValueChange={(v) => v && setPromoCodeId(v)}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="Choose the sponsor" /></SelectTrigger>
                  <SelectContent>
                    {exhibitor.sponsors.map((s) => (
                      <SelectItem key={s.promoCodeId} value={s.promoCodeId} disabled={s.placesLeft === 0}>
                        {sponsorLabel(s)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {kind === "complimentary" && !complimentary && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                This event has no rate named Complimentary. Add one to its registration types first.
              </p>
            )}

            {loading && !shown && (
              <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            )}
            {shown && (
              <div className="flex flex-col items-center gap-3 rounded-xl border bg-white p-6 text-center">
                <p className="text-xl font-semibold">{title}</p>
                {kind === "exhibitor" && sponsor && <p className="-mt-2 text-sm text-muted-foreground">{sponsor.sponsorName}</p>}
                {/* eslint-disable-next-line @next/next/no-img-element -- a data URL from the API */}
                <img src={shown.qr} alt={`Scan to register: ${title}`} className="h-64 w-64 max-w-full sm:h-72 sm:w-72" />
                <p className="text-sm">Point your phone camera at the code.</p>
                <p className="text-xs text-muted-foreground">
                  This QR works for {countdown.label} more and renews itself while this window is open.
                </p>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
