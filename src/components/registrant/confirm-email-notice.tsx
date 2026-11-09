"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MailCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * "Confirm your email to see registrations made earlier under it" (Nov 5,
 * 2026; src/lib/registrant-access.ts). Deliberately says nothing about
 * whether such registrations exist: the account has not proven the address,
 * so it must not learn the address's history.
 *
 * Given `email`, the caller already knows the account is unconfirmed (My
 * events, a server page). Without it, it asks the API and renders nothing for
 * a confirmed account (the event's own registration page).
 */
function noticeText(address: string | undefined, sent: boolean, forReviews: boolean): string {
  if (forReviews) {
    return sent
      ? `Check ${address} and click the link. The abstracts you were asked to review will then show here.`
      : `You were asked to review abstracts. Confirm ${address} to open them.`;
  }
  return sent
    ? `Check ${address} and click the link. Registrations made earlier under it will then show here.`
    : `Confirm ${address} to see registrations made earlier under it, including any certificates.`;
}

export function ConfirmEmailNotice({ email, forReviews = false }: { email?: string; forReviews?: boolean }) {
  const status = useQuery({
    queryKey: ["registrant", "confirm-email"],
    queryFn: async () => {
      const res = await fetch("/api/registrant/confirm-email");
      if (!res.ok) throw new Error(`Failed to check the email (${res.status})`);
      return (await res.json()) as { confirmed: boolean; email: string };
    },
    enabled: !email,
  });
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const address = email ?? status.data?.email;
  if (!email && (!status.data || status.data.confirmed)) return null;

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
        <p className="font-medium">{forReviews ? "Confirm your email to start reviewing" : "Registered before with this email?"}</p>
        <p className="text-sky-900/80">
          {noticeText(address, sent, forReviews)}
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
