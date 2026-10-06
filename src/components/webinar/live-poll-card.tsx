"use client";

/**
 * The live poll on the attendee page (Oct 6, 2026;
 * docs/WEBINAR_INTERACTION_PLAN.md §5), above the Q&A box. It arrives with the
 * Q&A refresh, so a launched poll appears within one refresh. One answer,
 * final; the results show only when the producer shows them.
 */

import { useState } from "react";
import { BarChart3, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { percentOf, type LivePollOption, type PollTally } from "@/lib/webinar/live-polls";

export interface ViewerPollData {
  id: string;
  question: string;
  options: LivePollOption[];
  allowMultiple: boolean;
  status: "OPEN" | "CLOSED";
  myChoices: string[] | null;
  results: PollTally | null;
}

export function LivePollCard({
  slug,
  sessionId,
  poll,
  canAnswer,
  onAnswered,
}: {
  slug: string;
  sessionId: string;
  poll: ViewerPollData;
  /** Registrants only; staff testing the page see the poll but cannot answer. */
  canAnswer: boolean;
  onAnswered: (pollId: string, choices: string[]) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answered = poll.myChoices !== null;
  const open = poll.status === "OPEN";

  const toggle = (id: string) =>
    setPicked((prev) => (poll.allowMultiple ? (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]) : [id]));

  const submit = async () => {
    if (picked.length === 0) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/public/events/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/polls/${encodeURIComponent(poll.id)}/vote`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choices: picked }) },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (!res.ok && data.code !== "ALREADY_ANSWERED") {
        console.warn("live-poll:vote-failed", res.status, data);
        setError(data.error || "Your answer could not be sent. Please try again.");
        return;
      }
      onAnswered(poll.id, picked);
    } catch (err) {
      console.warn("live-poll:vote-failed", err);
      setError("Your answer could not be sent. Please check your connection.");
    } finally {
      setSending(false);
    }
  };

  return (
    <Card className="border-primary/40 py-4">
      <CardContent className="space-y-3 px-4 py-2">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" />
          <p className="text-sm font-semibold">{open ? "Live poll" : "Poll results"}</p>
        </div>
        <p className="text-sm font-medium whitespace-pre-wrap break-words">{poll.question}</p>

        {poll.results ? (
          <ul className="space-y-2">
            {poll.options.map((o) => {
              const pct = percentOf(poll.results!.counts[o.id] ?? 0, poll.results!.voters);
              const mine = poll.myChoices?.includes(o.id);
              return (
                <li key={o.id} className="space-y-1">
                  <div className="flex justify-between gap-2 text-xs">
                    <span className={mine ? "font-semibold text-primary" : ""}>
                      {o.label}
                      {mine ? " (your answer)" : ""}
                    </span>
                    <span className="tabular-nums text-muted-foreground">{pct}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                  </div>
                </li>
              );
            })}
            <li className="text-xs text-muted-foreground">
              {poll.results.voters} {poll.results.voters === 1 ? "answer" : "answers"}
            </li>
          </ul>
        ) : answered ? (
          <p className="flex items-center gap-2 text-sm text-green-700">
            <CheckCircle2 className="h-4 w-4" />
            Thanks, your answer was recorded.
          </p>
        ) : open && canAnswer ? (
          <div className="space-y-2">
            {poll.allowMultiple && <p className="text-xs text-muted-foreground">Choose all that apply.</p>}
            <div className="space-y-1.5" role={poll.allowMultiple ? "group" : "radiogroup"} aria-label={poll.question}>
              {poll.options.map((o) => {
                const on = picked.includes(o.id);
                return (
                  <button
                    key={o.id}
                    type="button"
                    role={poll.allowMultiple ? "checkbox" : "radio"}
                    aria-checked={on}
                    onClick={() => toggle(o.id)}
                    disabled={sending}
                    className={`w-full rounded-md border px-3 py-2 text-left text-sm transition-colors ${on ? "border-primary bg-primary/10 font-medium" : "hover:bg-muted"}`}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
            <Button size="sm" className="w-full" onClick={() => void submit()} disabled={sending || picked.length === 0}>
              {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Submit answer
            </Button>
            {error && <p className="text-xs text-red-600">{error}</p>}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {open ? "Registered attendees can answer this poll." : "This poll has closed."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
