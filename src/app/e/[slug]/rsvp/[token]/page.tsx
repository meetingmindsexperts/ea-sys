"use client";

/**
 * Public RSVP form — one personalized link covers all the items in ONE
 * campaign. The invitee sees their name/email pre-filled (read-only), picks
 * the items they'll attend (a checkbox each in MULTI mode, a radio in SINGLE),
 * optionally a guest count and a dietary note, and submits. Re-editable until
 * each item's deadline.
 *
 * The campaign drives the shape: `selectionMode` decides checkbox vs radio,
 * `allowGuests` and `collectDietary` decide whether those fields render at all.
 * Server (`/api/public/events/[slug]/rsvp/[token]`) re-validates every one of
 * those — this is the friendly skin around that API, not the enforcement.
 *
 * Docs: docs/RSVP.md.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { AlertCircle, Check, Loader2, CalendarCheck, CalendarDays, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { EventBanner } from "@/components/public/event-banner";
import { resolveTimezone, tzLabel } from "@/lib/event-time";
import { toast } from "sonner";

interface ItemRow {
  id: string;
  name: string;
  startsAt: string;
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
    timezone: string | null;
  };
  campaign: {
    id: string;
    name: string;
    description: string | null;
    selectionMode: "SINGLE" | "MULTI";
    allowGuests: boolean;
    collectDietary: boolean;
    isActive: boolean;
  };
  invitee: { name: string; email: string; dietary: string };
  status: string;
  items: ItemRow[];
}

// Item times render in the EVENT's timezone with a label — an invitee abroad
// must not read the start time in their home clock (review M10).
function fmtDate(iso: string, timezone: string | null | undefined): string {
  const tz = resolveTimezone(timezone);
  const d = new Date(iso);
  const formatted = d.toLocaleString("en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  });
  return `${formatted} ${tzLabel(d, tz)}`;
}

export default function RsvpPage() {
  const { slug, token } = useParams<{ slug: string; token: string }>();
  const [data, setData] = useState<RsvpData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [dietary, setDietary] = useState("");
  const [notAttending, setNotAttending] = useState(false);
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
          console.error("rsvp-form:load-failed", res.status, json?.error);
          setError(json.error || "This RSVP link is invalid.");
          return;
        }
        setData(json);
        setItems(json.items);
        setDietary(json.invitee.dietary || "");
        // Reflect a prior "declined all" response so it re-opens ticked.
        if (json.status === "RESPONDED" && !json.items.some((d: ItemRow) => d.attending)) {
          setNotAttending(true);
        }
      } catch (err) {
        console.error("rsvp-form:load-error", err);
        if (!cancelled) setError("Couldn't load your RSVP. Please try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, token]);

  const setItem = useCallback((id: string, patch: Partial<ItemRow>) => {
    setItems((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }, []);

  /**
   * SINGLE mode: picking one un-picks the rest. The server rejects a
   * two-item payload outright (400 SINGLE_SELECTION_ONLY), so this is the
   * affordance, not the rule.
   */
  const pickItem = useCallback(
    (id: string, on: boolean, single: boolean) => {
      setItems((prev) =>
        prev.map((d) => {
          if (d.id === id) return { ...d, attending: on, guestCount: on ? d.guestCount : 0 };
          if (single && on && !d.closed) return { ...d, attending: false, guestCount: 0 };
          return d;
        }),
      );
      if (on) setNotAttending(false);
    },
    [],
  );

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/public/events/${slug}/rsvp/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dietary,
          items: items.map((d) => ({
            itemId: d.id,
            attending: d.attending,
            guestCount: d.attending ? d.guestCount : 0,
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        console.error("rsvp-form:submit-failed", res.status, json?.error);
        if (json?.code === "STALE_FORM") {
          // The items changed since this form was loaded — reload so the
          // invitee answers against the current list (review R2 M3).
          toast.error(json.error);
          window.location.reload();
          return;
        }
        toast.error(json.error || "Failed to submit RSVP");
        return;
      }
      // An item that closed while the form was open is NOT recorded — say so
      // instead of a false full success (review R2 M2).
      const ignored: string[] = Array.isArray(json?.ignoredItemIds) ? json.ignoredItemIds : [];
      if (ignored.length > 0) {
        const names = items.filter((d) => ignored.includes(d.id) && d.attending).map((d) => d.name);
        if (names.length > 0) {
          toast.warning(
            `RSVP for ${names.join(", ")} closed before you submitted and was not recorded. Please contact the organizer.`,
            { duration: 12000 },
          );
        }
      }
      setDone(true);
    } catch (err) {
      console.error("rsvp-form:submit-error", err);
      toast.error("Failed to submit RSVP. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }, [slug, token, dietary, items]);

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
          className="block w-full h-auto"
        />
        <div className="max-w-2xl mx-auto px-4 py-12 text-center">
          <div className="h-14 w-14 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-4">
            <Check className="h-7 w-7 text-emerald-600" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 mb-2">Thank you, {data.invitee.name}!</h1>
          <p className="text-slate-500">
            Your response to {data.campaign.name} has been recorded. You can revisit this link to
            change it any time before the deadline.
          </p>
        </div>
      </div>
    );
  }

  const single = data.campaign.selectionMode === "SINGLE";
  const allClosed = items.every((d) => d.closed);
  const manyItems = items.length > 1;
  // Require an explicit choice: at least one item picked, or "I won't attend".
  const hasChoice = notAttending || items.some((d) => d.attending);

  const question = !manyItems
    ? "Will you be attending?"
    : single
      ? "Which one will you attend?"
      : "Which of these will you attend?";
  const helper = !manyItems
    ? "Tick the box if you’ll join, or choose “I won’t be able to attend” below."
    : single
      ? "Choose one option, or select “I won’t be able to attend” below."
      : "Tick everything you’ll join, or choose “I won’t be able to attend” below.";
  const declineLabel = manyItems
    ? "I won’t be able to attend any of these"
    : "I won’t be able to attend";

  return (
    <div className="min-h-screen bg-slate-50">
      <EventBanner
        banner={data.event.bannerImage}
        bannerMobile={data.event.bannerImageMobile}
        name={data.event.name}
        className="block w-full h-auto"
      />
      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-6 sm:px-8 py-6 border-b border-slate-100">
            <div className="flex items-center gap-2 text-primary mb-1">
              <CalendarCheck className="h-5 w-5" />
              <span className="text-sm font-semibold uppercase tracking-wide">
                {data.campaign.name}
              </span>
            </div>
            <h1 className="text-2xl font-bold text-slate-900">{data.event.name}</h1>
            <p className="text-slate-500 mt-1">
              Hello <strong>{data.invitee.name}</strong> — please let us know your plans.
            </p>
            {data.campaign.description && (
              <p className="text-sm text-slate-500 mt-2">{data.campaign.description}</p>
            )}
          </div>

          <div className="px-6 sm:px-8 py-6 space-y-5">
            {/* Read-only identity */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label className="text-xs text-slate-500">Name</Label>
                <Input value={data.invitee.name} readOnly disabled className="mt-1" />
              </div>
              <div>
                <Label className="text-xs text-slate-500">Email</Label>
                <Input value={data.invitee.email} readOnly disabled className="mt-1" />
              </div>
            </div>

            {/* Items */}
            <div>
              <Label className="text-sm font-semibold text-slate-800">{question}</Label>
              <p className="text-xs text-slate-500 mt-0.5">{helper}</p>
              {allClosed && (
                <p className="text-sm text-amber-600 mt-1">RSVP is now closed for this event.</p>
              )}
              <div className="mt-3 space-y-3" role={single ? "radiogroup" : undefined}>
                {items.map((d) => (
                  <div
                    key={d.id}
                    className={`rounded-lg border p-4 ${
                      d.attending ? "border-primary/40 bg-primary/5" : "border-slate-200"
                    } ${d.closed ? "opacity-60" : ""}`}
                  >
                    <div className="flex items-start gap-3">
                      {single ? (
                        <input
                          type="radio"
                          name="rsvp-item"
                          checked={d.attending}
                          disabled={d.closed || notAttending}
                          onChange={(e) => pickItem(d.id, e.target.checked, true)}
                          className="mt-1.5 h-4 w-4 accent-[var(--primary)]"
                          aria-label={d.name}
                        />
                      ) : (
                        <Checkbox
                          checked={d.attending}
                          disabled={d.closed || notAttending}
                          onCheckedChange={(v) => pickItem(d.id, v === true, false)}
                          className="mt-1"
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-slate-900">{d.name}</div>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-500 mt-0.5">
                          <span className="inline-flex items-center gap-1">
                            <CalendarDays className="h-3.5 w-3.5" />{" "}
                            {fmtDate(d.startsAt, data?.event.timezone)}
                          </span>
                          {d.location && (
                            <span className="inline-flex items-center gap-1">
                              <MapPin className="h-3.5 w-3.5" /> {d.location}
                            </span>
                          )}
                        </div>
                        {d.description && <p className="text-sm text-slate-500 mt-1">{d.description}</p>}
                        {d.closed && <p className="text-xs text-amber-600 mt-1">RSVP closed for this one.</p>}
                        {/* Guests only when this RSVP actually asks for them. */}
                        {data.campaign.allowGuests && d.attending && !d.closed && (
                          <div className="flex items-center gap-2 mt-3">
                            <Label className="text-xs text-slate-500">Guests (besides you)</Label>
                            <Input
                              type="number"
                              min={0}
                              max={20}
                              value={d.guestCount}
                              onChange={(e) =>
                                setItem(d.id, {
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
                {items.length === 0 && (
                  <p className="text-sm text-slate-400">Nothing has been set up yet.</p>
                )}
              </div>

              {/* Explicit decline — valid in BOTH modes; "none of these" must
                  stay expressible or a SINGLE-mode RSVP forces a false pick. */}
              {items.length > 0 && !allClosed && (
                <label
                  className={`mt-3 flex items-center gap-3 rounded-lg border p-3 cursor-pointer ${
                    notAttending ? "border-slate-300 bg-slate-50" : "border-slate-200"
                  }`}
                >
                  <Checkbox
                    checked={notAttending}
                    onCheckedChange={(v) => {
                      const decline = v === true;
                      setNotAttending(decline);
                      if (decline) {
                        setItems((prev) => prev.map((d) => ({ ...d, attending: false, guestCount: 0 })));
                      }
                    }}
                  />
                  <span className="text-sm font-medium text-slate-700">{declineLabel}</span>
                </label>
              )}
            </div>

            {/* Dietary — only when this RSVP collects it. */}
            {data.campaign.collectDietary && (
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
            )}

            <Button
              onClick={handleSubmit}
              disabled={submitting || allClosed || !hasChoice}
              className="btn-gradient w-full h-11 font-semibold"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Submit RSVP"}
            </Button>
            {!hasChoice && !allClosed && (
              <p className="text-xs text-slate-400 text-center -mt-2">
                {manyItems
                  ? single
                    ? "Choose one, or select “I won’t be able to attend”."
                    : "Pick at least one, or select “I won’t be able to attend”."
                  : "Tick the box, or select “I won’t be able to attend”."}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
