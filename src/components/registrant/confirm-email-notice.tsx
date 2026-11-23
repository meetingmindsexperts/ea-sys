"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { MailCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { NEW_CONFIRMATION_WATCH, watchConfirmation } from "@/lib/confirm-email-watch";

/**
 * "Confirm your email to see registrations made earlier under it" (Nov 5,
 * 2026; src/lib/registrant-access.ts). Deliberately says nothing about
 * whether such registrations exist: the account has not proven the address,
 * so it must not learn the address's history.
 *
 * Given `email`, the caller already knows the account is unconfirmed (My
 * events, a server page). Without it, it asks the API and renders nothing for
 * a confirmed account (the event's own registration page).
 *
 * `forWebinar` (Nov 23, 2026) is the webinar page's copy, shown where a
 * signed-in person is told they are not registered: a registration made with
 * their address while signed out is not in the account until the address is
 * confirmed, and a webinar is watched from the account. It is shown to every
 * unconfirmed account there, registered or not, for the reason above. Once the
 * link is sent it keeps asking whether the address is confirmed and calls
 * `onConfirmed` when it is (the link is usually opened in another tab, or on
 * a phone), so the page can let the person in without a reload by hand.
 */
type NoticeKind = "registrations" | "reviews" | "webinar";

const NOTICE_TITLE: Record<NoticeKind, string> = {
  registrations: "Registered before with this email?",
  reviews: "Confirm your email to start reviewing",
  webinar: "Already registered for this webinar?",
};

function noticeText(address: string | undefined, sent: boolean, kind: NoticeKind): string {
  if (kind === "reviews") {
    return sent
      ? `Check ${address} and click the link. The abstracts you were asked to review will then show here.`
      : `You were asked to review abstracts. Confirm ${address} to open them.`;
  }
  if (kind === "webinar") {
    return sent
      ? `Check ${address} and click the link. This page lets you in as soon as the address is confirmed.`
      : `If you registered with ${address} without signing in, confirm the address to join from this account.`;
  }
  return sent
    ? `Check ${address} and click the link. Registrations made earlier under it will then show here.`
    : `Confirm ${address} to see registrations made earlier under it, including any certificates.`;
}

function noticeKind(forReviews: boolean, forWebinar: boolean): NoticeKind {
  if (forReviews) return "reviews";
  return forWebinar ? "webinar" : "registrations";
}

/** How often the webinar page asks whether the address is confirmed, once the link is sent. */
const CONFIRMED_POLL_MS = 8000;

export function ConfirmEmailNotice({
  email,
  forReviews = false,
  forWebinar = false,
  onConfirmed,
}: {
  email?: string;
  forReviews?: boolean;
  forWebinar?: boolean;
  /** The address became confirmed while this notice was showing (only without `email`). */
  onConfirmed?: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const status = useQuery({
    queryKey: ["registrant", "confirm-email"],
    queryFn: async () => {
      const res = await fetch("/api/registrant/confirm-email");
      if (!res.ok) throw new Error(`Failed to check the email (${res.status})`);
      return (await res.json()) as { confirmed: boolean; email: string };
    },
    enabled: !email,
    // Only while someone waits on the link, and only in a tab that is open.
    refetchInterval: sent && onConfirmed ? CONFIRMED_POLL_MS : false,
  });
  const router = useRouter();

  // Only a CHANGE to confirmed counts, and once (confirm-email-watch.ts).
  const confirmed = status.data?.confirmed;
  const watch = useRef(NEW_CONFIRMATION_WATCH);
  useEffect(() => {
    const next = watchConfirmation(watch.current, confirmed);
    watch.current = next.watch;
    if (next.tell) onConfirmed?.();
  }, [confirmed, onConfirmed]);

  const address = email ?? status.data?.email;
  if (!email && (!status.data || status.data.confirmed)) return null;
  const kind = noticeKind(forReviews, forWebinar);

  const send = async () => {
    setSending(true);
    try {
      const res = await fetch("/api/registrant/confirm-email", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error("registrant:confirm-email-send-failed", res.status, body);
        toast.error(body.error ?? "Couldn't send the link. Please try again.");
        return;
      }
      // Already confirmed (in another tab, or the session is a few minutes
      // behind): no link was sent, so do not ask them to check their inbox.
      if (body.confirmed) {
        toast.success("Your email is already confirmed");
        if (!email) void status.refetch();
        router.refresh();
        return;
      }
      setSent(true);
      toast.success(`Link sent to ${address}`);
    } catch (err) {
      console.error("registrant:confirm-email-send-failed", err);
      toast.error("Couldn't send the link. Please try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-sky-200 bg-sky-50 p-4 text-left sm:flex-row sm:items-center">
      <MailCheck className="hidden h-6 w-6 shrink-0 text-sky-700 sm:block" />
      <div className="flex-1 text-sm text-sky-950">
        <p className="font-medium">{NOTICE_TITLE[kind]}</p>
        <p className="text-sky-900/80">
          {noticeText(address, sent, kind)}
        </p>
      </div>
      {!sent && (
        <Button onClick={send} disabled={sending} variant="outline" className="h-11 w-full border-sky-300 bg-white sm:h-9 sm:w-auto">
          {sending ? "Sending..." : "Send confirmation link"}
        </Button>
      )}
    </div>
  );
}
