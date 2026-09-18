"use client";

/**
 * Public survey form — tokenized post-event feedback collection.
 *
 *   /e/[slug]/survey?token=<raw>        personal link from the Survey Invitation
 *                                        email; name + email shown locked
 *   /e/[slug]/survey?preview=1          builder preview (non-saving)
 *   /e/[slug]/survey?share=<token>      RETIRED Sep 17, 2026 — the API answers
 *                                        410 and the page shows its message
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

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { AlertCircle, Check, Loader2, Lock, Sparkles } from "lucide-react";
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
import { EventBannerBand } from "@/components/public/event-banner";
import { sanitizeHtml } from "@/lib/sanitize";

// ── Loaded payload types ───────────────────────────────────────────────

type SurveyMode = "token" | "preview";

interface EventLite {
  id?: string;
  name: string;
  slug: string;
  bannerImage: string | null;
  bannerImageMobile?: string | null;
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
      mode?: "preview";
      registration?: { id: string };
      attendee?: Attendee;
      event: EventLite;
      config: SurveyConfig;
      introHtml?: string | null;
      thankYouHtml?: string | null;
    }
  | { alreadyCompleted: true; event: EventLite; thankYouHtml?: string | null };

interface ReadyData {
  event: EventLite;
  config: SurveyConfig;
  attendee: Attendee | null; // token mode only
  introHtml: string | null; // organizer-authored rich-text intro
  thankYouHtml: string | null; // organizer-authored rich-text thank-you
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

// ── Main client ────────────────────────────────────────────────────────

function PublicSurveyClient() {
  const params = useParams<{ slug: string }>();
  const search = useSearchParams();
  const token = search.get("token") ?? "";
  // A retired shareable link. Still sent to the API so the server logs it and
  // answers with the one "use your personal link" message.
  const retiredShareToken = search.get("share") ?? "";
  const isPreview = search.get("preview") === "1";
  const slug = params.slug;

  const mode: SurveyMode = isPreview ? "preview" : "token";

  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ready"; data: ReadyData }
    | {
        kind: "thank-you";
        event: EventLite;
        thankYouHtml: string | null;
      }
  >({ kind: "loading" });

  // questionId → raw value (string). Ratings stored as the string number;
  // skipped optionals are empty string (server treats as absent).
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Set<string>>(new Set());

  // ── Load config (token / preview) ───────────────────────────

  useEffect(() => {
    if (mode === "token" && !token && !retiredShareToken) {
      setState({
        kind: "error",
        message: "No survey token provided. Please use the link from your email.",
      });
      return;
    }
    const qs =
      mode === "preview"
        ? "preview=1"
        : token
          ? `token=${encodeURIComponent(token)}`
          : `share=${encodeURIComponent(retiredShareToken)}`;
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
            event: data.event,
            thankYouHtml: data.thankYouHtml ?? null,
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
            thankYouHtml: data.thankYouHtml ?? null,
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
  }, [slug, token, retiredShareToken, mode]);

  // ── Submit ──────────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    async (loaded: ReadyData) => {
      if (mode === "preview") return; // preview never submits

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
        const body = { token, answers: payloadAnswers };
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
          event: loaded.event,
          thankYouHtml: loaded.thankYouHtml,
        });
      } catch (err) {
        console.error("survey:submit-failed", err);
        toast.error("We couldn't submit your survey. Please check your connection and try again.");
      } finally {
        setSubmitting(false);
      }
    },
    [answers, slug, token, mode],
  );

  // ── Render ──────────────────────────────────────────────────────────

  if (state.kind === "loading") return <CenteredSpinner />;
  if (state.kind === "error") return <ErrorPanel message={state.message} />;
  if (state.kind === "thank-you") {
    return (
      <ThankYouPanel event={state.event} thankYouHtml={state.thankYouHtml} />
    );
  }

  const { data } = state;
  const isPreviewMode = mode === "preview";
  const total = data.config.length;
  const answeredCount = data.config.filter((q) => (answers[q.id] ?? "") !== "").length;
  const pct = total === 0 ? 0 : Math.round((answeredCount / total) * 100);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Shared public-page header (banner + event info strip) */}
      <PublicHeader event={data.event} />

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
              <div>
                <p>
                  <span className="font-semibold">Preview</span> — this is exactly how the survey
                  looks to recipients. Responses are <span className="font-semibold">not saved</span>.
                </p>
                <button
                  type="button"
                  onClick={() =>
                    setState({
                      kind: "thank-you",
                      event: data.event,
                      thankYouHtml: data.thankYouHtml,
                    })
                  }
                  className="mt-1 font-semibold text-amber-900 underline underline-offset-2 hover:text-amber-700"
                >
                  Show the thank-you page
                </button>
              </div>
            </div>
          ) : null}

          {/* Personal link: who is answering, locked. The identity comes from
              the token, so there is nothing for the respondent to type. */}
          {data.attendee ? <RespondingAsCard attendee={data.attendee} /> : null}

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
// confirmation): the banner band, or a thin gradient accent line when there's
// no banner, followed by a white event-info strip.
function PublicHeader({ event }: { event: EventLite }) {
  return (
    <>
      {event.bannerImage ? (
        <EventBannerBand banner={event.bannerImage} bannerMobile={event.bannerImageMobile} name={event.name} />
      ) : (
        <div className="border-b border-slate-100 bg-white">
          <div className="h-1 bg-gradient-primary" />
        </div>
      )}
      <div className="border-b border-slate-200/60 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          <div className="py-3">
            <h2 className="text-base font-semibold text-slate-800">{event.name}</h2>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Who this personal link belongs to. Read-only by design (Sep 17, 2026 owner
 * decision): the survey is tied to the registration the link was minted for,
 * so the name and email are shown for reassurance and cannot be changed.
 */
function RespondingAsCard({ attendee }: { attendee: Attendee }) {
  const displayName = [
    attendee.title ? getTitleLabel(attendee.title) : "",
    attendee.firstName,
    attendee.lastName,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="mt-6 rounded-2xl border bg-card p-5 shadow-sm animate-in fade-in slide-in-from-bottom-3 duration-500 sm:p-6">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        <Lock className="h-3.5 w-3.5" />
        Responding as
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="survey-respondent-name" className="text-xs text-muted-foreground">
            Name
          </Label>
          <Input
            id="survey-respondent-name"
            value={displayName}
            readOnly
            tabIndex={-1}
            className="mt-1 h-11 cursor-default rounded-xl bg-muted/50 focus-visible:ring-0"
          />
        </div>
        <div>
          <Label htmlFor="survey-respondent-email" className="text-xs text-muted-foreground">
            Email
          </Label>
          <Input
            id="survey-respondent-email"
            type="email"
            value={attendee.email}
            readOnly
            tabIndex={-1}
            className="mt-1 h-11 cursor-default rounded-xl bg-muted/50 focus-visible:ring-0"
          />
        </div>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        This survey link is personal to your registration.
      </p>
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

/**
 * The terminal state: shown after a submit, and again when a used link is
 * reopened.
 *
 * The header is the SAME `PublicHeader` the form uses: the banner band at its
 * natural aspect, then the event-name strip. It used to be a hand-rolled
 * `<img>` inside the card, which squeezed the full-width event banner into a
 * box 64px tall and about 270px wide (70% of a max-w-md card's content box),
 * so the logo lockup and the date badge came out illegible and the
 * art-directed mobile banner was dropped entirely. Sharing the header also
 * keeps the page's identity across the submit (same banner, same column, only
 * the card changes) and puts this page back on the one banner rule that
 * `EventBannerBand` owns, which the inline image sat outside of.
 */
function ThankYouPanel({
  event,
  thankYouHtml,
}: {
  event: EventLite;
  /** The organizer's own message; null or blank shows the default copy. */
  thankYouHtml: string | null;
}) {
  const customHtml =
    thankYouHtml && thankYouHtml.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim() !== ""
      ? thankYouHtml
      : null;
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <PublicHeader event={event} />

      <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-gradient-to-b from-primary/[0.06] via-background to-muted/40">
        <div className="pointer-events-none absolute -top-24 -right-24 h-72 w-72 rounded-full bg-primary/15 blur-3xl" />
        <div className="pointer-events-none absolute top-1/3 -left-28 h-64 w-64 rounded-full bg-accent/20 blur-3xl" />

        {/* Same column the questions sat in, so the page doesn't jump on submit,
            centred in whatever room the header leaves. */}
        <div className="relative mx-auto w-full max-w-2xl px-4 py-12 sm:py-16">
          <div className="rounded-3xl border bg-card/90 p-8 text-center shadow-xl shadow-primary/10 backdrop-blur-sm animate-in fade-in slide-in-from-bottom-3 duration-500 sm:p-12">
            <div className="relative mx-auto flex h-16 w-16 items-center justify-center">
              <span className="absolute inset-0 rounded-full bg-gradient-primary opacity-20 blur-md" />
              <span className="relative flex h-16 w-16 items-center justify-center rounded-full bg-gradient-primary text-white shadow-lg shadow-primary/30 animate-in zoom-in-50 duration-700">
                <Check className="h-8 w-8" strokeWidth={2.5} />
              </span>
            </div>

            {/* States the outcome whatever the organizer's own wording says. */}
            <p className="mt-5 text-xs font-semibold uppercase tracking-[0.14em] text-primary">
              Response recorded
            </p>

            {customHtml ? (
              /* The organizer's words, untouched. Their first paragraph is
                 promoted to heading size, because the editor's usual output is
                 two plain paragraphs and those rendered as one flat grey block
                 with no hierarchy. A message that opens with a real heading
                 never matches the selector and is styled by prose as before. */
              <div
                className="prose prose-slate mx-auto mt-3 max-w-[46ch] text-muted-foreground [&_a]:text-primary [&>*:last-child]:mb-0 [&>*]:mb-3 [&>p:first-child]:mb-2 [&>p:first-child]:text-xl [&>p:first-child]:font-bold [&>p:first-child]:tracking-tight [&>p:first-child]:text-foreground sm:[&>p:first-child]:text-2xl"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(customHtml) }}
              />
            ) : (
              <>
                <h1 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
                  Thank you for completing the form!
                </h1>
                <p className="mx-auto mt-3 max-w-[46ch] text-muted-foreground">
                  Your feedback for{" "}
                  <span className="font-medium text-foreground">{event.name}</span> has been
                  recorded.
                </p>
                <p className="mx-auto mt-2 max-w-[46ch] text-muted-foreground">
                  Your attendance certificate will be received on your registered email&nbsp;ID.
                </p>
              </>
            )}
          </div>

          {/* Nothing follows this page, so say so rather than leave a dead end. */}
          <p className="mt-6 text-center text-xs text-muted-foreground">
            You can close this page.
          </p>
        </div>
      </div>
    </div>
  );
}
