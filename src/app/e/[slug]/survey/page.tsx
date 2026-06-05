"use client";

/**
 * Public survey form — tokenized post-event feedback collection.
 *
 *   /e/[slug]/survey?token=<raw>
 *
 * Lifecycle:
 *   1. On mount, GET /api/public/events/[slug]/survey?token=<raw>
 *      → validates token, returns { config, attendee, event } OR
 *        { alreadyCompleted: true } OR an error 4xx
 *   2. Render the question form with prefilled identity (read-only).
 *   3. On submit, POST to the same endpoint with { token, answers }.
 *   4. On success, render the thank-you panel.
 *
 * Failure modes surfaced to the user:
 *   - invalid / expired / wrong-slug token → error panel with the
 *     server's message + a link back to the event home
 *   - no survey configured → friendly "no survey" panel
 *   - already-completed → thank-you panel (idempotent re-arrival)
 *
 * Server validates everything again — this form is the friendly
 * skin around the API. Tampering with the DOM is rejected at submit.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { AlertCircle, CheckCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import type {
  SurveyConfig,
  SurveyQuestion,
} from "@/lib/survey/schema";
import { getTitleLabel } from "@/lib/utils";

// ── Loaded payload types ───────────────────────────────────────────────

interface LoadedPayload {
  alreadyCompleted: false;
  registration: { id: string };
  attendee: {
    firstName: string;
    lastName: string;
    email: string;
    title: string | null;
  };
  event: {
    id: string;
    name: string;
    slug: string;
    bannerImage: string | null;
  };
  config: SurveyConfig;
}

interface AlreadyCompletedPayload {
  alreadyCompleted: true;
  event: {
    name: string;
    slug: string;
    bannerImage: string | null;
  };
}

type ApiPayload = LoadedPayload | AlreadyCompletedPayload;

// ── Page shell ─────────────────────────────────────────────────────────

export default function PublicSurveyPage() {
  return (
    <Suspense fallback={<CenteredSpinner />}>
      <PublicSurveyClient />
    </Suspense>
  );
}

function CenteredSpinner() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}

// ── Main client ────────────────────────────────────────────────────────

function PublicSurveyClient() {
  const params = useParams<{ slug: string }>();
  const search = useSearchParams();
  const token = search.get("token") ?? "";
  const slug = params.slug;

  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ready"; payload: LoadedPayload }
    | { kind: "thank-you"; eventName: string; bannerImage: string | null }
  >({ kind: "loading" });

  // Per-question answer state: questionId → raw value (string from
  // selects + inputs, number stored as string for ratings — coerced
  // server-side per validateAnswers). Skipped optional questions:
  // empty string, which the server treats as absent.
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Set<string>>(new Set());

  // ── Load token + config ─────────────────────────────────────────────

  useEffect(() => {
    if (!token) {
      setState({
        kind: "error",
        message: "No survey token provided. Please use the link from your email.",
      });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/public/events/${encodeURIComponent(slug)}/survey?token=${encodeURIComponent(token)}`,
        );
        const data = (await res.json()) as ApiPayload | { error: string };
        if (cancelled) return;
        if (!res.ok || "error" in data) {
          const message =
            "error" in data && typeof data.error === "string"
              ? data.error
              : "We couldn't load the survey. Please try again.";
          setState({ kind: "error", message });
          return;
        }
        if (data.alreadyCompleted === true) {
          setState({
            kind: "thank-you",
            eventName: data.event.name,
            bannerImage: data.event.bannerImage,
          });
          return;
        }
        setState({ kind: "ready", payload: data });
      } catch (err) {
        if (cancelled) return;
        // Network error or JSON parse fail — distinct from server's
        // "we got your request and refused it" path. The user
        // experience is the same; the logged shape differs in
        // browser devtools.
        console.error("survey:load-failed", err);
        setState({
          kind: "error",
          message: "We couldn't reach the survey. Please check your connection and try again.",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, token]);

  // ── Submit ──────────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    async (loaded: LoadedPayload) => {
      // Client-side required check — server re-validates. Marking
      // failing fields lets the form highlight all of them at once
      // rather than the user playing whack-a-mole.
      const missing = new Set<string>();
      for (const q of loaded.config) {
        if (!q.required) continue;
        const v = answers[q.id];
        if (v === undefined || v === null || v === "") missing.add(q.id);
      }
      if (missing.size > 0) {
        setFieldErrors(missing);
        toast.error(`Please answer ${missing.size} required question${missing.size === 1 ? "" : "s"}.`);
        return;
      }
      setFieldErrors(new Set());

      setSubmitting(true);
      try {
        // Build the answers map for the server — drop empty strings
        // (server treats those as absent anyway, but keeping the
        // wire format tight makes logs easier to read).
        const payloadAnswers: Record<string, string> = {};
        for (const [k, v] of Object.entries(answers)) {
          if (v !== "") payloadAnswers[k] = v;
        }
        const res = await fetch(
          `/api/public/events/${encodeURIComponent(slug)}/survey`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token, answers: payloadAnswers }),
          },
        );
        const data: { ok?: boolean; alreadyCompleted?: boolean; error?: string; details?: { errors?: string[] } } =
          await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          // Surface the server's specific per-field errors if it sent any.
          if (data.details?.errors?.length) {
            toast.error(data.details.errors[0]);
          } else {
            toast.error(data.error ?? "We couldn't submit your survey. Please try again.");
          }
          return;
        }
        setState({
          kind: "thank-you",
          eventName: loaded.event.name,
          bannerImage: loaded.event.bannerImage,
        });
      } catch (err) {
        console.error("survey:submit-failed", err);
        toast.error("We couldn't submit your survey. Please check your connection and try again.");
      } finally {
        setSubmitting(false);
      }
    },
    [answers, slug, token],
  );

  // ── Render ──────────────────────────────────────────────────────────

  if (state.kind === "loading") return <CenteredSpinner />;
  if (state.kind === "error") return <ErrorPanel message={state.message} />;
  if (state.kind === "thank-you") {
    return (
      <ThankYouPanel eventName={state.eventName} bannerImage={state.bannerImage} />
    );
  }

  const { payload } = state;
  return (
    <div className="min-h-screen bg-muted/30">
      <SurveyHeader event={payload.event} attendee={payload.attendee} />
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="bg-white rounded-lg shadow-sm border p-6 sm:p-8">
          <h1 className="text-2xl font-bold mb-2">Post-Event Survey</h1>
          <p className="text-muted-foreground mb-6">
            Your feedback helps us improve future events. This should take about 2–3 minutes.
          </p>
          <div className="space-y-6">
            {payload.config.map((q) => (
              <QuestionField
                key={q.id}
                question={q}
                value={answers[q.id] ?? ""}
                onChange={(v) => {
                  setAnswers((prev) => ({ ...prev, [q.id]: v }));
                  if (fieldErrors.has(q.id)) {
                    setFieldErrors((prev) => {
                      const next = new Set(prev);
                      next.delete(q.id);
                      return next;
                    });
                  }
                }}
                hasError={fieldErrors.has(q.id)}
              />
            ))}
          </div>
          <div className="mt-8 pt-6 border-t flex justify-end">
            <Button
              onClick={() => void handleSubmit(payload)}
              disabled={submitting}
              size="lg"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Submitting…
                </>
              ) : (
                "Submit feedback"
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────

function SurveyHeader({
  event,
  attendee,
}: {
  event: LoadedPayload["event"];
  attendee: LoadedPayload["attendee"];
}) {
  const displayName = useMemo(() => {
    const title = attendee.title ? getTitleLabel(attendee.title) : "";
    const parts = [title, attendee.firstName, attendee.lastName].filter(Boolean);
    return parts.join(" ");
  }, [attendee]);
  return (
    <div className="bg-white border-b">
      {event.bannerImage ? (
        <div className="w-full max-h-48 overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={event.bannerImage}
            alt={event.name}
            className="w-full object-cover"
          />
        </div>
      ) : null}
      <div className="max-w-3xl mx-auto px-4 py-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          {event.name}
        </div>
        <div className="mt-1 text-sm">
          Submitting as <span className="font-medium">{displayName}</span>{" "}
          <span className="text-muted-foreground">· {attendee.email}</span>
        </div>
      </div>
    </div>
  );
}

function QuestionField({
  question,
  value,
  onChange,
  hasError,
}: {
  question: SurveyQuestion;
  value: string;
  onChange: (next: string) => void;
  hasError: boolean;
}) {
  const labelEl = (
    <Label
      htmlFor={question.id}
      className={`block mb-2 text-sm font-medium ${hasError ? "text-destructive" : ""}`}
    >
      {question.label}
      {question.required ? <span className="text-destructive ml-1">*</span> : null}
      {!question.required ? (
        <span className="text-muted-foreground font-normal ml-2 text-xs">
          (optional — skip if not applicable)
        </span>
      ) : null}
    </Label>
  );

  switch (question.type) {
    case "single_select":
      return (
        <div>
          {labelEl}
          <Select value={value} onValueChange={onChange}>
            <SelectTrigger
              id={question.id}
              className={hasError ? "border-destructive" : ""}
            >
              <SelectValue placeholder="Select an option" />
            </SelectTrigger>
            <SelectContent>
              {question.options.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      );
    case "rating_1_to_5":
      return (
        <div>
          {labelEl}
          <div
            className="flex gap-2"
            role="radiogroup"
            aria-label={question.label}
          >
            {[1, 2, 3, 4, 5].map((n) => {
              const selected = value === String(n);
              return (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => onChange(String(n))}
                  className={`flex-1 min-w-[44px] py-3 rounded-lg border text-lg font-semibold transition ${
                    selected
                      ? "bg-primary text-primary-foreground border-primary"
                      : hasError
                        ? "border-destructive text-destructive hover:bg-destructive/5"
                        : "border-input hover:bg-muted"
                  }`}
                >
                  {n}
                </button>
              );
            })}
          </div>
          <div className="flex justify-between mt-1 text-xs text-muted-foreground">
            <span>1 — Least satisfied</span>
            <span>5 — Most satisfied</span>
          </div>
        </div>
      );
    case "text":
      return (
        <div>
          {labelEl}
          {(question.maxLength ?? 0) > 200 ? (
            <Textarea
              id={question.id}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              maxLength={question.maxLength}
              rows={4}
              className={hasError ? "border-destructive" : ""}
            />
          ) : (
            <Input
              id={question.id}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              maxLength={question.maxLength}
              className={hasError ? "border-destructive" : ""}
            />
          )}
        </div>
      );
  }
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-lg shadow-sm border p-8 text-center">
        <div className="mx-auto h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
          <AlertCircle className="h-6 w-6 text-destructive" />
        </div>
        <h1 className="text-xl font-semibold mb-2">Survey unavailable</h1>
        <p className="text-muted-foreground mb-6">{message}</p>
        <Link href="/">
          <Button variant="outline">Return to home</Button>
        </Link>
      </div>
    </div>
  );
}

function ThankYouPanel({
  eventName,
  bannerImage,
}: {
  eventName: string;
  bannerImage: string | null;
}) {
  return (
    <div className="min-h-screen bg-muted/30">
      {bannerImage ? (
        <div className="w-full max-h-48 overflow-hidden bg-white border-b">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={bannerImage}
            alt={eventName}
            className="w-full object-cover"
          />
        </div>
      ) : null}
      <div className="max-w-2xl mx-auto px-4 py-16">
        <div className="bg-white rounded-lg shadow-sm border p-8 text-center">
          <div className="mx-auto h-14 w-14 rounded-full bg-emerald-100 flex items-center justify-center mb-4">
            <CheckCircle className="h-7 w-7 text-emerald-600" />
          </div>
          <h1 className="text-2xl font-bold mb-2">Thank you!</h1>
          <p className="text-muted-foreground">
            Your feedback for <span className="font-medium">{eventName}</span> has been recorded.
          </p>
        </div>
      </div>
    </div>
  );
}
