"use client";

/**
 * The end-of-webinar survey on the attendee page (step 4 of several surveys,
 * Oct 6, 2026; docs/MULTI_SURVEY_PLAN.md §13 W1-W2).
 *
 * When the webinar ends (the host ends it in Zoom, or the room closes) the
 * survey the producer chose pops up. "Later" closes it and leaves a banner;
 * it opens again on the next visit until the attendee answers. Never shown to
 * someone who already answered, nor while the webinar is still running.
 * Answers go to …/sessions/[sessionId]/end-survey, which submits through the
 * one shared survey submit.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardList, Loader2, PartyPopper } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { QuestionCard } from "@/components/survey/survey-question";
import { sanitizeHtml } from "@/lib/sanitize";
import type { SurveyConfig } from "@/lib/survey/schema";

interface EndSurvey {
  id: string | null;
  introHtml: string | null;
  thankYouHtml: string | null;
  config: SurveyConfig;
}

export function EndOfWebinarSurvey({
  slug,
  sessionId,
  ended,
}: {
  slug: string;
  sessionId: string;
  /** The webinar has ended for this viewer (host ended it, or the room closed). */
  ended: boolean;
}) {
  const [survey, setSurvey] = useState<EndSurvey | null>(null);
  const [answered, setAnswered] = useState(false);
  const [open, setOpen] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [thanked, setThanked] = useState(false);
  const autoOpened = useRef(false);
  const base = `/api/public/events/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/end-survey`;

  // Load once the webinar has ended (and on a later visit, where `ended` is
  // true from the first render).
  useEffect(() => {
    if (!ended) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(base);
        if (!res.ok) {
          console.warn("end-survey:load-failed", res.status);
          return;
        }
        const data = (await res.json()) as { survey: EndSurvey | null; answered?: boolean };
        if (cancelled) return;
        setSurvey(data.survey);
        setAnswered(Boolean(data.answered));
      } catch (err) {
        console.warn("end-survey:load-failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ended, base]);

  // Open by itself once per visit; "Later" leaves the banner.
  useEffect(() => {
    if (!ended || !survey || answered || autoOpened.current) return;
    autoOpened.current = true;
    setOpen(true);
  }, [ended, survey, answered]);

  const submit = useCallback(async () => {
    if (!survey) return;
    const needed = new Set(survey.config.filter((q) => q.required && !answers[q.id]).map((q) => q.id));
    if (needed.size > 0) {
      setMissing(needed);
      toast.error(`Please answer ${needed.size} required question${needed.size === 1 ? "" : "s"}.`);
      return;
    }
    setMissing(new Set());
    setSubmitting(true);
    try {
      const payload: Record<string, string> = {};
      for (const [k, v] of Object.entries(answers)) if (v !== "") payload[k] = v;
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: payload }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; details?: { errors?: string[] } };
      if (!res.ok || !data.ok) {
        console.warn("end-survey:submit-failed", res.status, data);
        toast.error(data.details?.errors?.[0] ?? data.error ?? "We couldn't submit your answers. Please try again.");
        return;
      }
      setAnswered(true);
      setThanked(true);
    } catch (err) {
      console.error("end-survey:submit-failed", err);
      toast.error("We couldn't submit your answers. Please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }, [answers, base, survey]);

  if (!ended || !survey || (answered && !thanked)) return null;

  return (
    <>
      {!answered && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3">
          <div className="flex items-center gap-3">
            <ClipboardList className="h-5 w-5 shrink-0 text-primary" />
            <p className="text-sm font-medium">The webinar has ended. Tell us what you thought: it takes a minute.</p>
          </div>
          <Button size="sm" onClick={() => setOpen(true)}>
            Take the survey
          </Button>
        </div>
      )}

      <Dialog open={open} onOpenChange={(next) => !submitting && setOpen(next)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          {thanked ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <PartyPopper className="h-5 w-5 text-primary" />
                  Thank you
                </DialogTitle>
              </DialogHeader>
              {survey.thankYouHtml ? (
                <div
                  className="prose prose-sm max-w-none"
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(survey.thankYouHtml) }}
                />
              ) : (
                <p className="text-sm text-muted-foreground">Your feedback has been recorded.</p>
              )}
              <DialogFooter>
                <Button onClick={() => setOpen(false)}>Close</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Your feedback</DialogTitle>
                <DialogDescription>The webinar has ended. A few quick questions.</DialogDescription>
              </DialogHeader>
              {survey.introHtml && (
                <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: sanitizeHtml(survey.introHtml) }} />
              )}
              <div className="space-y-4">
                {survey.config.map((q, i) => (
                  <QuestionCard
                    key={q.id}
                    index={i}
                    question={q}
                    value={answers[q.id] ?? ""}
                    onChange={(v) => setAnswers((prev) => ({ ...prev, [q.id]: v }))}
                    hasError={missing.has(q.id)}
                    disabled={submitting}
                  />
                ))}
              </div>
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
                  Later
                </Button>
                <Button onClick={() => void submit()} disabled={submitting}>
                  {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Submit feedback
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
