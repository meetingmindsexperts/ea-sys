"use client";

/**
 * Public survey form — tokenized post-event feedback collection.
 *
 *   /e/[slug]/survey?token=<raw>        per-registration (prefilled)
 *   /e/[slug]/survey?share=<token>      shareable link (self-identify by email)
 *   /e/[slug]/survey?preview=1          builder preview (non-saving)
 *
 * Lifecycle:
 *   1. On mount, GET /api/public/events/[slug]/survey?<mode-qs>
 *      → validates, returns { config, attendee?, event } OR
 *        { alreadyCompleted: true } OR an error 4xx
 *   2. Render the question form (token mode prefills identity).
 *   3. On submit, POST to the same endpoint.
 *   4. On success, render the thank-you panel.
 *
 * Server validates everything again — this form is the friendly skin
 * around the API. Tampering with the DOM is rejected at submit.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { AlertCircle, Check, Loader2, Mail, Sparkles } from "lucide-react";
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
import type { SurveyConfig, SurveyQuestion } from "@/lib/survey/schema";
import { getTitleLabel } from "@/lib/utils";
import { sanitizeHtml } from "@/lib/sanitize";

// ── Loaded payload types ───────────────────────────────────────────────

type SurveyMode = "token" | "share" | "preview";

interface EventLite {
  id?: string;
  name: string;
  slug: string;
  bannerImage: string | null;
}

interface Attendee {
  firstName: string;
  lastName: string;
  email: string;
  title: string | null;
}

// Server response shapes across the three modes.
type ApiPayload =
  | {
      alreadyCompleted?: false;
      mode?: "share" | "preview";
      registration?: { id: string };
      attendee?: Attendee;
      event: EventLite;
      config: SurveyConfig;
      introHtml?: string | null;
    }
  | { alreadyCompleted: true; event: EventLite };

interface ReadyData {
  event: EventLite;
  config: SurveyConfig;
  attendee: Attendee | null; // token mode only
  introHtml: string | null; // organizer-authored rich-text intro
}

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
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-primary/[0.06] via-background to-muted/30">
      <Loader2 className="h-8 w-8 animate-spin text-primary/70" />
    </div>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Main client ────────────────────────────────────────────────────────

function PublicSurveyClient() {
  const params = useParams<{ slug: string }>();
  const search = useSearchParams();
  const token = search.get("token") ?? "";
  const shareToken = search.get("share") ?? "";
  const isPreview = search.get("preview") === "1";
  const slug = params.slug;

  const mode: SurveyMode = isPreview ? "preview" : shareToken ? "share" : "token";

  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ready"; data: ReadyData }
    | { kind: "thank-you"; eventName: string; bannerImage: string | null }
  >({ kind: "loading" });

  // questionId → raw value (string). Ratings stored as the string number;
  // skipped optionals are empty string (server treats as absent).
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [shareEmail, setShareEmail] = useState(""); // share mode self-identify
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Set<string>>(new Set());

  // ── Load config (token / share / preview) ───────────────────────────

  useEffect(() => {
    if (mode === "token" && !token) {
      setState({
        kind: "error",
        message: "No survey token provided. Please use the link from your email.",
      });
      return;
    }
    const qs =
      mode === "preview"
        ? "preview=1"
        : mode === "share"
          ? `share=${encodeURIComponent(shareToken)}`
          : `token=${encodeURIComponent(token)}`;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/public/events/${encodeURIComponent(slug)}/survey?${qs}`,
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
        setState({
          kind: "ready",
          data: {
            event: data.event,
            config: data.config,
            attendee: data.attendee ?? null,
            introHtml: data.introHtml ?? null,
          },
        });
      } catch (err) {
        if (cancelled) return;
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
  }, [slug, token, shareToken, mode]);

  // ── Submit ──────────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    async (loaded: ReadyData) => {
      if (mode === "preview") return; // preview never submits

      if (mode === "share" && !EMAIL_RE.test(shareEmail.trim())) {
        toast.error("Please enter the email address you registered with.");
        return;
      }

      // Client-side required check — server re-validates. Highlight all
      // failing fields at once rather than one-at-a-time.
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
        const payloadAnswers: Record<string, string> = {};
        for (const [k, v] of Object.entries(answers)) {
          if (v !== "") payloadAnswers[k] = v;
        }
        const body =
          mode === "share"
            ? { share: shareToken, email: shareEmail.trim(), answers: payloadAnswers }
            : { token, answers: payloadAnswers };
        const res = await fetch(
          `/api/public/events/${encodeURIComponent(slug)}/survey`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        const data: { ok?: boolean; alreadyCompleted?: boolean; error?: string; details?: { errors?: string[] } } =
          await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
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
    [answers, slug, token, shareToken, shareEmail, mode],
  );

  // ── Render ──────────────────────────────────────────────────────────

  if (state.kind === "loading") return <CenteredSpinner />;
  if (state.kind === "error") return <ErrorPanel message={state.message} />;
  if (state.kind === "thank-you") {
    return <ThankYouPanel eventName={state.eventName} bannerImage={state.bannerImage} />;
  }

  const { data } = state;
  const isPreviewMode = mode === "preview";
  const total = data.config.length;
  const answeredCount = data.config.filter((q) => (answers[q.id] ?? "") !== "").length;
  const pct = total === 0 ? 0 : Math.round((answeredCount / total) * 100);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Shared public-page header (banner + event info strip) */}
      <PublicHeader event={data.event} attendee={data.attendee} />

      {/* Body */}
      <div className="relative flex-1 overflow-hidden bg-gradient-to-b from-primary/[0.06] via-background to-muted/40">
        <div className="pointer-events-none absolute -top-24 -right-24 h-72 w-72 rounded-full bg-primary/15 blur-3xl" />
        <div className="pointer-events-none absolute top-1/3 -left-28 h-64 w-64 rounded-full bg-accent/20 blur-3xl" />

        <div className="relative mx-auto max-w-2xl px-4 pb-24 pt-8 sm:pt-10">
          {/* Intro */}
          <div className="animate-in fade-in slide-in-from-bottom-3 duration-500">
            <span className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">
              Post-event feedback
            </span>
            <h1 className="mt-1.5 text-3xl font-bold tracking-tight sm:text-[2.1rem]">
              How did we do?
            </h1>
            {data.introHtml ? (
              <div
                className="prose prose-slate mt-3 max-w-none text-muted-foreground [&_a]:text-primary [&>*:last-child]:mb-0 [&>*]:mb-3"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(data.introHtml) }}
              />
            ) : (
              <p className="mt-2 max-w-prose text-muted-foreground">
                Your feedback shapes our next event. It takes about 2–3 minutes — thank you for
                sharing.
              </p>
            )}
            {!isPreviewMode && total > 0 ? (
              <div className="mt-5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-primary">
                    {answeredCount} of {total} answered
                  </span>
                  <span className="text-muted-foreground">{pct}%</span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-primary/10">
                  <div
                    className="h-full rounded-full bg-gradient-primary-horizontal transition-[width] duration-500 ease-out"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            ) : null}
          </div>

          {isPreviewMode ? (
            <div className="mt-6 flex items-start gap-3 rounded-2xl border border-amber-300/70 bg-amber-50 px-4 py-3 text-sm text-amber-900 animate-in fade-in duration-500">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <p>
                <span className="font-semibold">Preview</span> — this is exactly how the survey
                looks to recipients. Responses are <span className="font-semibold">not saved</span>.
              </p>
            </div>
          ) : null}

          {mode === "share" ? (
            <ShareEmailStep value={shareEmail} onChange={setShareEmail} />
          ) : null}

          {/* Questions */}
          <div className="mt-6 space-y-4">
            {data.config.map((q, i) => (
              <QuestionCard
                key={q.id}
                index={i}
                question={q}
                value={answers[q.id] ?? ""}
                disabled={isPreviewMode}
                hasError={fieldErrors.has(q.id)}
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
              />
            ))}
          </div>

          {/* Submit */}
          <div className="mt-8 flex flex-col items-center gap-3 animate-in fade-in duration-700">
            <Button
              onClick={() => void handleSubmit(data)}
              disabled={submitting || isPreviewMode}
              className="btn-gradient h-12 w-full rounded-xl text-base font-semibold shadow-lg shadow-primary/20 disabled:opacity-60 disabled:shadow-none sm:w-auto sm:px-10"
            >
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  Submitting…
                </>
              ) : isPreviewMode ? (
                "Submit disabled in preview"
              ) : (
                "Submit feedback"
              )}
            </Button>
            {!isPreviewMode ? (
              <p className="text-xs text-muted-foreground">
                {answeredCount === total
                  ? "All set — submit when you're ready."
                  : `${total - answeredCount} more to go (optional ones can be skipped).`}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────

// Mirrors the header used across the public event pages (register /
// confirmation): full-width banner shown whole (w-full, natural height), or a
// thin gradient accent line when there's no banner, followed by a white
// event-info strip. Survey-specific: the strip carries the respondent's
// identity (token mode) on the right.
function PublicHeader({
  event,
  attendee,
}: {
  event: EventLite;
  attendee: Attendee | null;
}) {
  const displayName = useMemo(() => {
    if (!attendee) return "";
    const title = attendee.title ? getTitleLabel(attendee.title) : "";
    return [title, attendee.firstName, attendee.lastName].filter(Boolean).join(" ");
  }, [attendee]);

  return (
    <>
      {event.bannerImage ? (
        <div className="relative w-full bg-white">
          <div className="mx-auto max-w-[1400px]">
            {/* Full-width, whole image (no object-contain letterbox / height
                cap that was shrinking the banner so it didn't fill the width). */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={event.bannerImage}
              alt={event.name}
              className="block h-auto w-full"
            />
          </div>
        </div>
      ) : (
        <div className="border-b border-slate-100 bg-white">
          <div className="h-1 bg-gradient-primary" />
        </div>
      )}

      <div className="border-b border-slate-200/60 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 py-3">
            <h2 className="mr-auto text-base font-semibold text-slate-800">{event.name}</h2>
            {attendee ? (
              <div className="flex items-center gap-1.5 text-sm text-slate-500">
                <span className="font-medium text-slate-700">{displayName}</span>
                <span className="text-slate-400">· {attendee.email}</span>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}

function ShareEmailStep({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="mt-6 rounded-2xl border bg-card p-5 shadow-sm animate-in fade-in slide-in-from-bottom-3 duration-500 sm:p-6">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Mail className="h-4 w-4" />
        </div>
        <div>
          <Label htmlFor="share-email" className="text-sm font-semibold">
            Your registered email <span className="text-destructive">*</span>
          </Label>
          <p className="text-xs text-muted-foreground">
            We link your feedback to your registration.
          </p>
        </div>
      </div>
      <Input
        id="share-email"
        type="email"
        inputMode="email"
        autoComplete="email"
        placeholder="you@example.com"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-4 h-11 rounded-xl"
      />
    </div>
  );
}

function QuestionCard({
  index,
  question,
  value,
  onChange,
  hasError,
  disabled = false,
}: {
  index: number;
  question: SurveyQuestion;
  value: string;
  onChange: (next: string) => void;
  hasError: boolean;
  disabled?: boolean;
}) {
  const answered = value !== "";

  return (
    <div
      className={`group rounded-2xl border bg-card p-5 shadow-sm transition-colors animate-in fade-in slide-in-from-bottom-3 fill-mode-backwards sm:p-6 ${
        hasError ? "border-destructive/60 ring-1 ring-destructive/20" : "border-border hover:border-primary/30"
      }`}
      style={{ animationDelay: `${Math.min(index, 8) * 70}ms`, animationDuration: "500ms" }}
    >
      <div className="flex gap-3.5">
        {/* Number badge — fills with the brand gradient once answered */}
        <div
          className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-all ${
            answered
              ? "bg-gradient-primary text-white shadow-sm shadow-primary/30"
              : hasError
                ? "bg-destructive/10 text-destructive"
                : "bg-muted text-muted-foreground"
          }`}
          aria-hidden
        >
          {answered ? <Check className="h-3.5 w-3.5" /> : index + 1}
        </div>

        <div className="min-w-0 flex-1">
          <Label
            htmlFor={question.id}
            className={`block text-[0.95rem] font-medium leading-snug ${hasError ? "text-destructive" : ""}`}
          >
            {question.label}
            {question.required ? (
              <span className="ml-1 text-destructive">*</span>
            ) : (
              <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 align-middle text-[0.65rem] font-normal text-muted-foreground">
                Optional
              </span>
            )}
          </Label>

          <div className="mt-3">
            <QuestionInput
              question={question}
              value={value}
              onChange={onChange}
              hasError={hasError}
              disabled={disabled}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function QuestionInput({
  question,
  value,
  onChange,
  hasError,
  disabled,
}: {
  question: SurveyQuestion;
  value: string;
  onChange: (next: string) => void;
  hasError: boolean;
  disabled: boolean;
}) {
  switch (question.type) {
    case "single_select":
      return (
        <Select value={value} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger
            id={question.id}
            className={`h-11 rounded-xl ${hasError ? "border-destructive" : ""}`}
          >
            <SelectValue placeholder="Choose an option" />
          </SelectTrigger>
          <SelectContent>
            {question.options.map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );

    case "rating_1_to_5":
      return (
        <div>
          <div className="flex gap-2" role="radiogroup" aria-label={question.label}>
            {[1, 2, 3, 4, 5].map((n) => {
              const selected = value === String(n);
              return (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={String(n)}
                  disabled={disabled}
                  onClick={() => onChange(String(n))}
                  className={`flex h-12 flex-1 items-center justify-center rounded-xl text-lg font-semibold transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-60 ${
                    selected
                      ? "btn-gradient scale-[1.04] shadow-md shadow-primary/25"
                      : hasError
                        ? "border border-destructive/50 text-destructive hover:bg-destructive/5"
                        : "border border-input bg-background text-foreground hover:-translate-y-0.5 hover:border-primary/40 hover:text-primary"
                  }`}
                >
                  {n}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            <span>Least satisfied</span>
            <span>Most satisfied</span>
          </div>
        </div>
      );

    case "text":
      return (question.maxLength ?? 0) > 200 ? (
        <Textarea
          id={question.id}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          maxLength={question.maxLength}
          rows={4}
          placeholder="Type your answer…"
          className={`rounded-xl ${hasError ? "border-destructive" : ""}`}
        />
      ) : (
        <Input
          id={question.id}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          maxLength={question.maxLength}
          placeholder="Type your answer…"
          className={`h-11 rounded-xl ${hasError ? "border-destructive" : ""}`}
        />
      );
  }
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-primary/[0.06] via-background to-muted/30 px-4">
      <div className="w-full max-w-md rounded-2xl border bg-card p-8 text-center shadow-sm animate-in fade-in zoom-in-95 duration-500">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
          <AlertCircle className="h-6 w-6 text-destructive" />
        </div>
        <h1 className="mb-2 text-xl font-semibold">Survey unavailable</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link href="/">
          <Button variant="outline" className="rounded-xl">
            Return to home
          </Button>
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
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-b from-primary/[0.07] via-background to-muted/40 px-4">
      <div className="pointer-events-none absolute -top-24 right-0 h-72 w-72 rounded-full bg-primary/15 blur-3xl" />
      <div className="pointer-events-none absolute bottom-0 -left-20 h-64 w-64 rounded-full bg-accent/20 blur-3xl" />

      <div className="relative w-full max-w-md rounded-3xl border bg-card/90 p-8 text-center shadow-xl shadow-primary/10 backdrop-blur-sm animate-in fade-in zoom-in-95 duration-500 sm:p-10">
        {bannerImage ? (
          <div className="mx-auto mb-6 flex h-16 items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={bannerImage}
              alt={eventName}
              className="max-h-full w-auto max-w-[70%] object-contain"
            />
          </div>
        ) : null}

        <div className="relative mx-auto mb-5 flex h-16 w-16 items-center justify-center">
          <span className="absolute inset-0 rounded-full bg-gradient-primary opacity-20 blur-md" />
          <span className="relative flex h-16 w-16 items-center justify-center rounded-full bg-gradient-primary text-white shadow-lg shadow-primary/30 animate-in zoom-in-50 duration-700">
            <Check className="h-8 w-8" strokeWidth={2.5} />
          </span>
        </div>

        <h1 className="text-2xl font-bold tracking-tight">Thank you for completing the form!</h1>
        <p className="mt-3 text-muted-foreground">
          Your feedback for <span className="font-medium text-foreground">{eventName}</span> has
          been recorded.
        </p>
        <p className="mt-2 text-muted-foreground">
          Your attendance certificate will be received on your registered email&nbsp;ID.
        </p>
      </div>
    </div>
  );
}
