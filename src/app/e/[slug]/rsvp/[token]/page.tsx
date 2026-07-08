"use client";

/**
 * Public Dinner RSVP form — one personalized link covers all the event's
 * dinners. The invitee sees their name/email pre-filled (read-only),
 * ticks the dinners they'll attend (with a guest count each), adds a
 * dietary note, and submits. Re-editable until each dinner's deadline.
 *
 * Server (`/api/public/events/[slug]/rsvp/[token]`) re-validates
 * everything — this is the friendly skin around that API.
 * Docs: docs/DINNER_RSVP.md.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { AlertCircle, Check, Loader2, UtensilsCrossed, CalendarDays, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { EventBanner } from "@/components/public/event-banner";
import { toast } from "sonner";

interface DinnerRow {
  id: string;
  name: string;
  dinnerAt: string;
  location: string | null;
  description: string | null;
  rsvpDeadline: string | null;
  closed: boolean;
  attending: boolean;
  guestCount: number;
}
interface RsvpData {
  event: {
    slug: string;
    name: string;
    bannerImage: string | null;
    bannerImageMobile: string | null;
    startDate: string;
    endDate: string;
  };
  invitee: { name: string; email: string; dietary: string };
  status: string;
  dinners: DinnerRow[];
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function RsvpPage() {
  const { slug, token } = useParams<{ slug: string; token: string }>();
  const [data, setData] = useState<RsvpData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dinners, setDinners] = useState<DinnerRow[]>([]);
  const [dietary, setDietary] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/public/events/${slug}/rsvp/${token}`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error || "This RSVP link is invalid.");
          return;
        }
        setData(json);
        setDinners(json.dinners);
        setDietary(json.invitee.dietary || "");
      } catch {
        if (!cancelled) setError("Couldn't load your RSVP. Please try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, token]);

  const setDinner = useCallback((id: string, patch: Partial<DinnerRow>) => {
    setDinners((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }, []);

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/public/events/${slug}/rsvp/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dietary,
          dinners: dinners.map((d) => ({
            dinnerId: d.id,
            attending: d.attending,
            guestCount: d.attending ? d.guestCount : 0,
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to submit RSVP");
        return;
      }
      setDone(true);
    } catch {
      toast.error("Failed to submit RSVP. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }, [slug, token, dietary, dinners]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <AlertCircle className="h-10 w-10 text-red-500 mx-auto mb-3" />
          <h1 className="text-xl font-bold text-slate-900 mb-1">RSVP link problem</h1>
          <p className="text-slate-500">{error}</p>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="min-h-screen bg-slate-50">
        <EventBanner
          banner={data.event.bannerImage}
          bannerMobile={data.event.bannerImageMobile}
          name={data.event.name}
          className="w-full h-40 sm:h-56 object-cover"
        />
        <div className="max-w-2xl mx-auto px-4 py-12 text-center">
          <div className="h-14 w-14 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-4">
            <Check className="h-7 w-7 text-emerald-600" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 mb-2">Thank you, {data.invitee.name}!</h1>
          <p className="text-slate-500">
            Your dinner RSVP for {data.event.name} has been recorded. You can revisit this link to
            change your response any time before the deadline.
          </p>
        </div>
      </div>
    );
  }

  const allClosed = dinners.every((d) => d.closed);

  return (
    <div className="min-h-screen bg-slate-50">
      <EventBanner
        banner={data.event.bannerImage}
        bannerMobile={data.event.bannerImageMobile}
        name={data.event.name}
        className="w-full h-40 sm:h-56 object-cover"
      />
      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-6 sm:px-8 py-6 border-b border-slate-100">
            <div className="flex items-center gap-2 text-primary mb-1">
              <UtensilsCrossed className="h-5 w-5" />
              <span className="text-sm font-semibold uppercase tracking-wide">Dinner RSVP</span>
            </div>
            <h1 className="text-2xl font-bold text-slate-900">{data.event.name}</h1>
            <p className="text-slate-500 mt-1">
              Hello <strong>{data.invitee.name}</strong> — please let us know which dinners you&rsquo;ll
              join.
            </p>
          </div>

          <div className="px-6 sm:px-8 py-6 space-y-5">
            {/* Read-only identity */}
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <Label className="text-xs text-slate-500">Name</Label>
                <Input value={data.invitee.name} readOnly disabled className="mt-1" />
              </div>
              <div>
                <Label className="text-xs text-slate-500">Email</Label>
                <Input value={data.invitee.email} readOnly disabled className="mt-1" />
              </div>
            </div>

            {/* Dinners */}
            <div>
              <Label className="text-sm font-semibold text-slate-800">Which dinners will you attend?</Label>
              {allClosed && (
                <p className="text-sm text-amber-600 mt-1">RSVP is now closed for this event.</p>
              )}
              <div className="mt-3 space-y-3">
                {dinners.map((d) => (
                  <div
                    key={d.id}
                    className={`rounded-lg border p-4 ${
                      d.attending ? "border-primary/40 bg-primary/5" : "border-slate-200"
                    } ${d.closed ? "opacity-60" : ""}`}
                  >
                    <div className="flex items-start gap-3">
                      <Checkbox
                        checked={d.attending}
                        disabled={d.closed}
                        onCheckedChange={(v) => setDinner(d.id, { attending: v === true })}
                        className="mt-1"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-slate-900">{d.name}</div>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-500 mt-0.5">
                          <span className="inline-flex items-center gap-1">
                            <CalendarDays className="h-3.5 w-3.5" /> {fmtDate(d.dinnerAt)}
                          </span>
                          {d.location && (
                            <span className="inline-flex items-center gap-1">
                              <MapPin className="h-3.5 w-3.5" /> {d.location}
                            </span>
                          )}
                        </div>
                        {d.description && <p className="text-sm text-slate-500 mt-1">{d.description}</p>}
                        {d.closed && <p className="text-xs text-amber-600 mt-1">RSVP closed for this dinner.</p>}
                        {d.attending && !d.closed && (
                          <div className="flex items-center gap-2 mt-3">
                            <Label className="text-xs text-slate-500">Guests (besides you)</Label>
                            <Input
                              type="number"
                              min={0}
                              max={20}
                              value={d.guestCount}
                              onChange={(e) =>
                                setDinner(d.id, {
                                  guestCount: Math.max(0, Math.min(20, Number(e.target.value) || 0)),
                                })
                              }
                              className="w-20 h-8"
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                {dinners.length === 0 && (
                  <p className="text-sm text-slate-400">No dinners have been set up yet.</p>
                )}
              </div>
            </div>

            {/* Dietary */}
            <div>
              <Label htmlFor="dietary" className="text-sm font-semibold text-slate-800">
                Dietary requirements (optional)
              </Label>
              <Textarea
                id="dietary"
                value={dietary}
                onChange={(e) => setDietary(e.target.value)}
                placeholder="Vegetarian, allergies, etc."
                className="mt-1"
                rows={2}
                maxLength={1000}
              />
            </div>

            <Button
              onClick={handleSubmit}
              disabled={submitting || allClosed}
              className="btn-gradient w-full h-11 font-semibold"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Submit RSVP"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
