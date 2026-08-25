"use client";

/**
 * Speaker profile — Travel Grant card.
 *
 * Shows where this author stands and lets the organizer act without leaving the
 * profile: email their personal link, copy it, or open the console.
 *
 * SELF-HIDES outside the travel-grant boundary (SUPER_ADMIN / ADMIN /
 * ORGANIZER, matching the console's denyReviewer gate), and self-hides entirely
 * when the feature is off for the event, so a card about a switched-off feature
 * never appears on a profile.
 *
 * The eligibility verdict is shown even when it is NEGATIVE, and that is the
 * point rather than clutter: routing is purely the country on this profile, and
 * an author wrongly recorded as UAE is otherwise invisible. Saying "UAE, not
 * eligible" right next to the country field is what lets an organizer notice
 * the field is wrong, fix it, and then send.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { Copy, ExternalLink, Loader2, Plane, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ResidencyBadge, GrantStatusLabel } from "@/components/travel-grant/travel-grant-badges";
import { canManageTravelGrants, publicTravelGrantUrl } from "@/lib/travel-grant/constants";
import { isTravelGrantEnabled } from "@/lib/travel-grant/settings";
import type { ResidencyClass } from "@/lib/travel-grant/eligibility";
import { useEvent } from "@/hooks/use-api";


interface Row {
  speakerId: string;
  name: string;
  email: string | null;
  country: string | null;
  residency: ResidencyClass;
  grant: {
    id: string;
    status: "PENDING" | "CONSENTED" | "DECLINED";
    token: string;
    invitedAt: string | null;
    submittedAt: string | null;
    signedName: string | null;
  } | null;
}

export function SpeakerTravelGrantCard({
  eventId,
  speakerId,
  speakerCountry,
}: {
  eventId: string;
  speakerId: string;
  /**
   * The country as the profile page currently holds it. Passed in ONLY so this
   * card refetches when it changes: eligibility is decided from that field, and
   * the card's own hint tells the organizer that correcting it enables the Send
   * button. Without this the badge, the hint and the disabled button all persist
   * until a full page reload, so the instruction reads as broken.
   */
  speakerCountry?: string | null;
}) {
  const { data: session } = useSession();
  const role = session?.user?.role;
  // From the SHARED React Query cache the speaker page already populates, so
  // this costs no request. Gating on it means a profile on an event with the
  // feature off — the overwhelming majority — issues no travel-grant call at
  // all, rather than a round-trip that runs auth + an event lookup + a join and
  // then renders null.
  const { data: event } = useEvent(eventId);
  const featureOn = isTravelGrantEnabled(
    (event as { settings?: unknown } | undefined)?.settings,
  );

  const [row, setRow] = useState<Row | null>(null);
  const [eventSlug, setEventSlug] = useState<string>("");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  /** Distinct from `enabled === false`: a failure must not look like "switched off". */
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/events/${eventId}/travel-grants?speakerId=${encodeURIComponent(speakerId)}`,
      );
      if (!res.ok) {
        // 403 is the role gate and 404 is a speaker on another event: both mean
        // "no card", not "something broke". Anything else IS a failure and must
        // say so, per the repo's log-every-failure-path rule.
        if (res.status !== 403 && res.status !== 404) {
          setLoadFailed(true);
          console.error("speaker-travel-grant-card:load-failed", res.status);
        }
        setEnabled(false);
        return;
      }
      const json = await res.json();
      setLoadFailed(false);
      setEnabled(Boolean(json.enabled));
      setEventSlug(json.eventSlug ?? "");
      setRow(json.row ?? null);
    } catch (err) {
      // Without this the card silently VANISHES after a successful send, because
      // the follow-up refetch failed and `!enabled` hides it. The organizer is
      // left unable to tell whether anything was recorded.
      setLoadFailed(true);
      setEnabled(false);
      console.error("speaker-travel-grant-card:load-failed", err);
    } finally {
      setLoading(false);
    }
  }, [eventId, speakerId]);

  useEffect(() => {
    if (!canManageTravelGrants(role) || !featureOn) {
      setLoading(false);
      return;
    }
    void load();
  }, [role, featureOn, load, speakerCountry]);

  const send = useCallback(async () => {
    setSending(true);
    try {
      const res = await fetch(`/api/events/${eventId}/travel-grants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speakerIds: [speakerId] }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || "Couldn't send the link.");
        return;
      }
      if (json.sent > 0) toast.success("Travel grant link sent");
      else if (json.failed) toast.error("The email could not be delivered. Check the address.");
      else if (json.skippedAlreadyAnswered)
        toast.info("They have already replied, so there is no link to resend.");
      else if (json.skippedNotEligible) toast.warning("Not eligible. Correct the country first.");
      else if (json.skippedNoEmail) toast.warning("This speaker has no email address.");
      else toast.info("Nothing was sent");
      await load();
    } catch {
      toast.error("Couldn't send the link.");
    } finally {
      setSending(false);
    }
  }, [eventId, speakerId, load]);

  const copy = useCallback(() => {
    if (!row?.grant || !eventSlug) return;
    void navigator.clipboard
      .writeText(publicTravelGrantUrl(window.location.origin, eventSlug, row.grant.token))
      .then(() => toast.success("Link copied"))
      .catch(() => toast.error("Couldn't copy the link"));
  }, [row, eventSlug]);

  if (!canManageTravelGrants(role) || !featureOn) return null;
  if (loading) return null;
  if (loadFailed) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Plane className="h-4 w-4 text-muted-foreground" />
            Travel Grant
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Couldn&rsquo;t load the travel grant status.
          </p>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }
  // Feature off for this event: no card at all, rather than a card explaining
  // that there is nothing to see.
  if (!enabled || !row) return null;

  const eligible = row.residency === "overseas";

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Plane className="h-4 w-4 text-primary" />
          Travel Grant
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">Eligibility</span>
          <ResidencyBadge residency={row.residency} />
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">Status</span>
          <span className="text-sm">
            <GrantStatusLabel status={row.grant?.status ?? null} />
          </span>
        </div>

        {row.grant?.signedName && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground">Signed</span>
            <span className="text-sm">{row.grant.signedName}</span>
          </div>
        )}

        {!eligible && (
          <p className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
            {row.residency === "uae"
              ? "Travel grants are for authors based outside the UAE. If the country above is wrong, correct it on this profile and the send button becomes available."
              : "No country is recorded for this author, so they were not invited. Add their country above, then send their link."}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={send} disabled={!eligible || !row.email || sending}>
            {sending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="mr-2 h-3.5 w-3.5" />
            )}
            {row.grant ? "Resend link" : "Send link"}
          </Button>
          {row.grant && (
            <Button size="sm" variant="outline" onClick={copy}>
              <Copy className="mr-2 h-3.5 w-3.5" />
              Copy link
            </Button>
          )}
          <Button size="sm" variant="ghost" asChild>
            <Link href={`/events/${eventId}/travel-grants`}>
              <ExternalLink className="mr-2 h-3.5 w-3.5" />
              Console
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
