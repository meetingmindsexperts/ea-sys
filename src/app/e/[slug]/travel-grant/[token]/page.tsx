"use client";

/**
 * Public travel-grant consent form.
 *
 * One personalized token link per author. Deliberately the smallest useful
 * page in the system: read the terms, tick one box, type your name, submit.
 * There is nothing to collect here beyond eligibility and intent (decision D1),
 * because amounts, flights, passports and bank details live in Speaker
 * Reimbursement and duplicating any of them would create two places to look for
 * one person's money.
 *
 * The server at `/api/public/events/[slug]/travel-grant/[token]` re-validates
 * everything; this page mirrors the checks only for friendly inline feedback.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { AlertCircle, CalendarDays, Check, Loader2, MapPin, Plane } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { EventBanner } from "@/components/public/event-banner";

interface LoadedGrant {
  status: "PENDING" | "CONSENTED" | "DECLINED";
  signedName: string | null;
  submittedAt: string | null;
  recipientName: string;
  termsHtml: string;
  event: {
    name: string;
    slug: string;
    bannerImage: string | null;
    bannerImageMobile: string | null;
    startDate: string;
    endDate: string;
    timezone: string | null;
    venue: string | null;
    city: string | null;
    organizationName: string | null;
  };
}

export default function TravelGrantPage() {
  const params = useParams<{ slug: string; token: string }>();
  const slug = params?.slug;
  const token = params?.token;

  const [data, setData] = useState<LoadedGrant | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [confirmed, setConfirmed] = useState(false);
  const [signedName, setSignedName] = useState("");
  const [submitting, setSubmitting] = useState<"consent" | "decline" | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState<"CONSENTED" | "DECLINED" | null>(null);

  useEffect(() => {
    if (!slug || !token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/public/events/${slug}/travel-grant/${token}`);
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(json.error || "This travel grant link is invalid.");
        } else {
          setData(json as LoadedGrant);
          if (json.signedName) setSignedName(json.signedName);
        }
      } catch {
        // A failed fetch must not render as "your link is invalid" — that sends
        // the author to the organizer over a network blip.
        if (!cancelled) setLoadError("We couldn't load this page. Please try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, token]);

  const submit = useCallback(
    async (decision: "consent" | "decline") => {
      if (!slug || !token) return;
      setSubmitError(null);
      setSubmitting(decision);
      try {
        const res = await fetch(`/api/public/events/${slug}/travel-grant/${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision,
            confirmedNotUaeResident: decision === "consent" ? confirmed : undefined,
            signedName: decision === "consent" ? signedName.trim() : undefined,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          setSubmitError(json.error || "We couldn't record your response. Please try again.");
          return;
        }
        setDone(json.status);
      } catch {
        setSubmitError("We couldn't record your response. Please try again.");
      } finally {
        setSubmitting(null);
      }
    },
    [slug, token, confirmed, signedName],
  );

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md rounded-lg border bg-card p-8 text-center">
          <AlertCircle className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <h1 className="mb-2 text-lg font-semibold">{loadError}</h1>
          <p className="text-sm text-muted-foreground">
            If you believe this is a mistake, reply to the email you received and the organising
            team will help.
          </p>
        </div>
      </div>
    );
  }

  const already = done ?? (data.status === "PENDING" ? null : data.status);
  const dateLine = formatEventDates(data.event.startDate, data.event.endDate);

  return (
    <div className="min-h-screen bg-muted/30">
      <EventBanner
        banner={data.event.bannerImage}
        bannerMobile={data.event.bannerImageMobile}
        name={data.event.name}
        className="w-full"
        priority
      />

      <div className="mx-auto max-w-[1120px] px-4 py-8">
        <div className="mb-6 rounded-lg border bg-card p-5">
          <h1 className="text-xl font-semibold">{data.event.name}</h1>
          <div className="mt-2 flex flex-wrap gap-4 text-sm text-muted-foreground">
            {dateLine && (
              <span className="flex items-center gap-1.5">
                <CalendarDays className="h-4 w-4" />
                {dateLine}
              </span>
            )}
            {(data.event.venue || data.event.city) && (
              <span className="flex items-center gap-1.5">
                <MapPin className="h-4 w-4" />
                {[data.event.venue, data.event.city].filter(Boolean).join(", ")}
              </span>
            )}
          </div>
        </div>

        <div className="rounded-lg border bg-card p-6">
          <div className="mb-5 flex items-start gap-3">
            <div className="rounded-md bg-primary/10 p-2">
              <Plane className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Travel Grant</h2>
              <p className="text-sm text-muted-foreground">
                For {data.recipientName}
              </p>
            </div>
          </div>

          {already === "CONSENTED" && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
              <p className="flex items-center gap-2 font-medium">
                <Check className="h-4 w-4" />
                Your travel grant request has been recorded.
              </p>
              <p className="mt-1">
                The organising team will be in touch about the outcome. There is nothing else you
                need to do.
              </p>
            </div>
          )}

          {already === "DECLINED" && (
            <div className="rounded-md border bg-muted/50 p-4 text-sm">
              <p className="font-medium">Thank you — we have recorded that you do not need a travel grant.</p>
              <p className="mt-1 text-muted-foreground">
                If that changes, reply to the email you received and the organising team can help.
              </p>
            </div>
          )}

          {!already && (
            <>
              <div
                className="prose prose-sm max-w-none [&>*]:mb-4"
                dangerouslySetInnerHTML={{ __html: data.termsHtml }}
              />

              <div className="mt-6 space-y-5 border-t pt-6">
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="confirm"
                    checked={confirmed}
                    onCheckedChange={(v) => setConfirmed(v === true)}
                    className="mt-0.5"
                  />
                  <Label htmlFor="confirm" className="text-sm font-normal leading-relaxed">
                    {/* ONE child on purpose. `Label` is `flex items-center gap-2`, so
                        separate text nodes and a <strong> become separate FLEX ITEMS
                        with an 8px gap between each — which renders as
                        "Emirates , and" with a stray space before the comma. Wrapping
                        the sentence in a span makes it a single flex item and inline
                        formatting behaves normally. Same class as needing `min-w-0`
                        for `truncate` to work inside a flex row. */}
                    <span>
                      I confirm that I am{" "}
                      <strong>not a resident of the United Arab Emirates</strong>, and I
                      would like to be considered for a travel grant.
                    </span>
                  </Label>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="signedName">
                    Your full name, as a signature <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="signedName"
                    value={signedName}
                    onChange={(e) => setSignedName(e.target.value)}
                    placeholder={data.recipientName}
                    autoComplete="name"
                  />
                </div>

                {submitError && (
                  <p className="flex items-center gap-2 text-sm text-destructive">
                    <AlertCircle className="h-4 w-4" />
                    {submitError}
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    onClick={() => submit("consent")}
                    disabled={!confirmed || signedName.trim().length < 2 || submitting !== null}
                  >
                    {submitting === "consent" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Confirm my travel grant request
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => submit("decline")}
                    disabled={submitting !== null}
                  >
                    {submitting === "decline" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    I don&rsquo;t need a travel grant
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Confirming does not award you a grant. It records that you are eligible and
                  interested.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Short, unambiguous, and collapsed when the event is a single day. */
function formatEventDates(start: string, end: string): string {
  try {
    const s = new Date(start);
    const e = new Date(end);
    const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric" };
    const sameDay = s.toDateString() === e.toDateString();
    return sameDay
      ? s.toLocaleDateString("en-GB", opts)
      : `${s.toLocaleDateString("en-GB", { day: "numeric", month: "long" })} – ${e.toLocaleDateString("en-GB", opts)}`;
  } catch {
    return "";
  }
}
