"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, FileSignature, CheckCircle2, Send } from "lucide-react";
import { toast } from "sonner";

const MANAGER_ROLES = new Set(["ADMIN", "SUPER_ADMIN", "ORGANIZER"]);

/**
 * Sidebar card on the abstract edit page for the Presenter Agreement (the
 * abstract-flow parallel of the speaker agreement). Self-hides for anyone but
 * ADMIN / SUPER_ADMIN / ORGANIZER — the send route is denyReviewer-gated too.
 *
 * The agreement is PER-AUTHOR: sending from any of an author's abstracts mints
 * a token on the same author, and one acceptance covers all of their abstracts.
 */
export function PresenterAgreementCard({
  eventId,
  abstractId,
  authorName,
  authorEmail,
  acceptedAt,
}: {
  eventId: string;
  abstractId: string;
  authorName: string;
  authorEmail: string;
  acceptedAt: string | null;
}) {
  const { data: session } = useSession();
  const [sending, setSending] = useState(false);
  const [sentAt, setSentAt] = useState<string | null>(null);

  if (!MANAGER_ROLES.has(session?.user?.role ?? "")) return null;

  const send = async () => {
    if (sending) return;
    setSending(true);
    try {
      const res = await fetch(
        `/api/events/${eventId}/abstracts/${abstractId}/presenter-agreement/email`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) },
      );
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(result.error || "Failed to send agreement");
        return;
      }
      setSentAt(new Date().toISOString());
      toast.success(`Presenter agreement sent to ${authorEmail}`);
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setSending(false);
    }
  };

  const label = acceptedAt || sentAt ? "Resend Agreement" : "Send Presenter Agreement";

  return (
    <Card>
      <CardContent className="pt-5 space-y-3">
        <div className="flex items-center gap-2">
          <FileSignature className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Presenter Agreement</h3>
        </div>

        {acceptedAt ? (
          <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              Accepted by {authorName || "the presenter"} on{" "}
              {new Date(acceptedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}.
            </span>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground leading-relaxed">
            Not yet accepted. One acceptance by {authorName || "the presenter"} covers all of their abstracts for this event.
          </p>
        )}

        <Button variant="outline" size="sm" className="w-full" disabled={sending} onClick={send}>
          {sending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Sending…
            </>
          ) : (
            <>
              <Send className="mr-2 h-4 w-4" /> {label}
            </>
          )}
        </Button>

        {sentAt && !acceptedAt && (
          <p className="text-[11px] text-muted-foreground text-center">
            Sent — awaiting the presenter&apos;s acceptance.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
