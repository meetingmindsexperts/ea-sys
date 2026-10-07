"use client";

/**
 * Survey builder: one survey's questions, intro and thank-you.
 *
 *   /events/[eventId]/survey/[surveyId]
 *     [surveyId] = a survey id, "new" (an extra survey, created on first save)
 *     or "certificate" (the reserved CME survey, created on first save when the
 *     event has none).
 *
 * An event runs several surveys (Oct 6, 2026; docs/MULTI_SURVEY_PLAN.md). The
 * certificate (CME) survey is reserved and locked: it saves through its own
 * route, can never be deleted or lose its flag, and is the only survey that
 * marks a registration complete for certificates. Extra surveys save through
 * /api/events/[eventId]/surveys and are never certificate surveys.
 *
 * Q1 the question `id` is generated via `newQuestionId()` exactly once at
 * create time and preserved across renames + reorders — this is the
 * answer-linkage key. NEVER re-derive from array index.
 * Q2 labels are short strings, not rich text.
 * Q3 drag-to-reorder is deferred; up/down arrow buttons.
 */

import { RESPONSE_MODE_LABEL, type SurveyResponseModeValue } from "@/lib/survey/response-mode";
import { duplicateSurveyRequest } from "@/lib/survey/duplicate-client";
import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useCan } from "@/hooks/use-can";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  BarChart3,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  Loader2,
  Lock,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  newQuestionId,
  surveyConfigSchema,
  type SurveyQuestion,
} from "@/lib/survey/schema";

// Lazy-load the WYSIWYG editor (heavy; client-only) — same pattern as the
// Content page and Email Templates.
const TiptapEditor = dynamic(
  () => import("@/components/ui/tiptap-editor").then((m) => ({ default: m.TiptapEditor })),
  {
    ssr: false,
    loading: () => <div className="h-[300px] animate-pulse rounded-md border bg-muted" />,
  },
);

const QUESTION_TYPE_LABELS: Record<SurveyQuestion["type"], string> = {
  single_select: "Single select",
  rating_1_to_5: "Rating (1–5)",
  text: "Free text",
};

// Tiptap emits "<p></p>" (and similar) for an empty document — treat that
// as empty so the public form falls back to its default copy. Used for both
// the intro and the thank-you message.
function richTextIsEmpty(html: string): boolean {
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim() === "";
}

function defaultQuestion(type: SurveyQuestion["type"]): SurveyQuestion {
  const id = newQuestionId();
  switch (type) {
    case "single_select":
      return { id, type, label: "", required: true, options: ["", ""] };
    case "rating_1_to_5":
      return { id, type, label: "", required: true };
    case "text":
      return { id, type, label: "", required: false };
  }
}

export default function SurveyBuilderPage() {
  const params = useParams();
  const router = useRouter();
  const eventId = params.eventId as string;
  const routeSurveyId = params.surveyId as string;
  const canEdit = useCan("surveys.manage", eventId) === "allowed";

  const [eventName, setEventName] = useState<string>("");
  const [eventSlug, setEventSlug] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [questions, setQuestions] = useState<SurveyQuestion[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [introHtml, setIntroHtml] = useState<string>("");
  const [thankYouHtml, setThankYouHtml] = useState<string>("");
  const [name, setName] = useState<string>("");
  const [isActive, setIsActive] = useState(true);
  // The saved survey's id once it exists; null while "new" / an unsaved
  // certificate slot.
  const [surveyId, setSurveyId] = useState<string | null>(null);
  const [isCertificate, setIsCertificate] = useState(routeSurveyId === "certificate");
  const [responseCount, setResponseCount] = useState(0);
  // Phase 4: how often one person may answer (extra surveys only).
  const [responseMode, setResponseMode] = useState<SurveyResponseModeValue>("ONCE");

  // ── Load ─────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    const adopt = (survey: {
      id: string; name: string; config: unknown; introHtml: string | null; thankYouHtml: string | null;
      isActive: boolean; gatesCertificates: boolean; responseCount: number; responseMode?: SurveyResponseModeValue;
    }) => {
      setSurveyId(survey.id);
      setName(survey.name);
      setIsActive(survey.isActive);
      setIsCertificate(survey.gatesCertificates);
      setResponseCount(survey.responseCount);
      setResponseMode(survey.responseMode ?? "ONCE");
      setIntroHtml(survey.introHtml ?? "");
      setThankYouHtml(survey.thankYouHtml ?? "");
      // Validate against the current Zod schema before adopting: an older
      // format would otherwise round-trip and crash the builder on Save.
      const parsed = surveyConfigSchema.safeParse(survey.config);
      if (parsed.success) {
        setQuestions(parsed.data);
      } else {
        console.warn("survey:stored-config-invalid", parsed.error.flatten());
        toast.error("The saved survey has an unrecognized format. Please rebuild it.");
        setQuestions([]);
      }
    };
    (async () => {
      setLoading(true);
      try {
        if (routeSurveyId === "new" || routeSurveyId === "certificate") {
          const res = await fetch(`/api/events/${eventId}/surveys`);
          if (!res.ok) {
            toast.error("Could not load the event.");
            return;
          }
          const data = await res.json();
          if (cancelled) return;
          setEventName(data.event?.name ?? "");
          setEventSlug(data.event?.slug ?? "");
          if (routeSurveyId === "certificate") {
            const cert = (data.surveys ?? []).find((s: { gatesCertificates: boolean }) => s.gatesCertificates);
            if (cert) adopt(cert);
            else setName("Post-event survey");
          }
          return;
        }
        const res = await fetch(`/api/events/${eventId}/surveys/${routeSurveyId}`);
        if (!res.ok) {
          toast.error(res.status === 404 ? "Survey not found." : "Could not load the survey.");
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        setEventName(data.event?.name ?? "");
        setEventSlug(data.event?.slug ?? "");
        adopt(data.survey);
      } catch (err) {
        console.error("survey:load-failed", err);
        toast.error("Failed to load the survey.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId, routeSurveyId]);

  // ── Mutations (immutable updates) ────────────────────────────────────

  const addQuestion = useCallback((type: SurveyQuestion["type"]) => {
    // Defensive try/catch — if defaultQuestion (which calls
    // newQuestionId → globalThis.crypto.randomUUID) ever throws,
    // surface the error in console + toast rather than letting
    // React's error boundary swallow it silently. This was the
    // "no logs" failure mode that blocked the builder before the
    // schema.ts fix removed the Node-only `crypto` import.
    try {
      const q = defaultQuestion(type);
      setQuestions((prev) => [...prev, q]);
      setExpanded((prev) => new Set(prev).add(q.id));
    } catch (err) {
      console.error("survey:add-question-failed", { type, err });
      toast.error(
        "Couldn't add the question — open the browser console for details.",
      );
    }
  }, []);

  const removeQuestion = useCallback((id: string) => {
    setQuestions((prev) => prev.filter((q) => q.id !== id));
  }, []);

  const moveQuestion = useCallback((id: string, dir: -1 | 1) => {
    setQuestions((prev) => {
      const i = prev.findIndex((q) => q.id === id);
      if (i < 0) return prev;
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }, []);

  const updateQuestion = useCallback(
    (id: string, patch: Partial<SurveyQuestion>) => {
      setQuestions((prev) =>
        prev.map((q) => {
          if (q.id !== id) return q;
          // Preserve discriminator — `type` changes go through a
          // separate path so we never produce an ill-typed mix.
          return { ...q, ...patch } as SurveyQuestion;
        }),
      );
    },
    [],
  );

  const changeQuestionType = useCallback(
    (id: string, type: SurveyQuestion["type"]) => {
      setQuestions((prev) =>
        prev.map((q) => {
          if (q.id !== id) return q;
          // Preserve id + label + required (label especially — an
          // admin who typo'd "type" doesn't want to lose their
          // wording). Drop type-specific fields by re-deriving
          // from defaultQuestion(type).
          const fresh = defaultQuestion(type);
          return { ...fresh, id: q.id, label: q.label, required: q.required };
        }),
      );
    },
    [],
  );

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ── Save ─────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    const parsed = surveyConfigSchema.safeParse(questions);
    if (!parsed.success) {
      // Every failing field to the console; the first to the toast.
      console.warn("survey:save-client-validation-failed", parsed.error.flatten());
      const first = parsed.error.issues[0];
      toast.error(first ? `${first.path.join(".") || "Survey"}: ${first.message}` : "Please fix the survey before saving.");
      return;
    }
    if (!isCertificate && name.trim() === "") {
      toast.error("Give the survey a name.");
      return;
    }
    setSaving(true);
    try {
      const body = {
        ...(name.trim() !== "" && { name: name.trim() }),
        config: questions,
        // Empty editor (only whitespace / empty <p>) saves as null so the
        // public form falls back to its default copy.
        introHtml: richTextIsEmpty(introHtml) ? null : introHtml,
        thankYouHtml: richTextIsEmpty(thankYouHtml) ? null : thankYouHtml,
        isActive,
        // The CME survey is answered once, always; its route takes no mode.
        ...(!isCertificate && { responseMode }),
      };
      const res = isCertificate
        ? await fetch(`/api/events/${eventId}/surveys/certificate`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        : surveyId
          ? await fetch(`/api/events/${eventId}/surveys/${surveyId}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            })
          : await fetch(`/api/events/${eventId}/surveys`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.warn("survey:save-failed", res.status, data);
        toast.error(typeof data.error === "string" ? data.error : "Failed to save the survey.");
        return;
      }
      toast.success("Survey saved.");
      if (!surveyId && data.id) {
        setSurveyId(data.id);
        if (!isCertificate) router.replace(`/events/${eventId}/survey/${data.id}`);
      }
    } catch (err) {
      console.error("survey:save-failed", err);
      toast.error("Failed to save the survey.");
    } finally {
      setSaving(false);
    }
  }, [eventId, questions, introHtml, thankYouHtml, name, isActive, isCertificate, surveyId, router, responseMode]);

  const handleDelete = useCallback(async () => {
    if (!surveyId || isCertificate) return;
    if (!window.confirm(`Delete the survey "${name}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/events/${eventId}/surveys/${surveyId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.warn("survey:delete-failed", res.status, data);
        toast.error(typeof data.error === "string" ? data.error : "Failed to delete the survey.");
        return;
      }
      toast.success("Survey deleted.");
      router.push(`/events/${eventId}/survey`);
    } catch (err) {
      console.error("survey:delete-failed", err);
      toast.error("Failed to delete the survey.");
    } finally {
      setDeleting(false);
    }
  }, [eventId, surveyId, isCertificate, name, router]);

  const dirtyCount = questions.length;
  const previewLink = useMemo(() => {
    if (!eventSlug || !surveyId) return null;
    return `/e/${encodeURIComponent(eventSlug)}/survey?preview=1&surveyId=${encodeURIComponent(surveyId)}`;
  }, [eventSlug, surveyId]);

  // ── Render ───────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="container py-8">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="w-full py-8">
      <div className="mb-6">
        <Link
          href={`/events/${eventId}/survey`}
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3 mr-1" />
          All surveys
        </Link>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
            {isCertificate ? "Certificate (CME) survey" : surveyId ? name || "Survey" : "New survey"}
            {isCertificate && (
              <Badge variant="secondary" className="gap-1 text-xs">
                <Lock className="h-3 w-3" />
                Reserved
              </Badge>
            )}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isCertificate
              ? "Completing this survey is what issues CME certificates. It is locked: it cannot be deleted or swapped for another survey."
              : "An extra survey. Its answers are recorded and exported, and it never affects certificates."}{" "}
            <span className="font-medium">{eventName}</span>
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {surveyId && (
            <Link href={`/events/${eventId}/survey/responses?surveyId=${encodeURIComponent(surveyId)}`}>
              <Button variant="outline" size="sm">
                <BarChart3 className="h-3.5 w-3.5 mr-1.5" />
                Responses ({responseCount})
              </Button>
            </Link>
          )}
          {canEdit && surveyId && (
            <Button
              variant="outline"
              size="sm"
              disabled={duplicating}
              title="Copies the saved survey into a new, closed survey (never the certificate survey). Save first if you have changes."
              onClick={async () => {
                setDuplicating(true);
                const id = await duplicateSurveyRequest(eventId, surveyId);
                setDuplicating(false);
                if (id) router.push(`/events/${eventId}/survey/${id}`);
              }}
            >
              {duplicating ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Copy className="h-3.5 w-3.5 mr-1.5" />
              )}
              Duplicate
            </Button>
          )}
          {previewLink ? (
            <Link
              href={previewLink}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button variant="outline" size="sm">
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                Preview
              </Button>
            </Link>
          ) : null}
          {canEdit && (
          <Button
            onClick={() => void handleSave()}
            disabled={saving || dirtyCount === 0}
            size="sm"
          >
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Save className="h-3.5 w-3.5 mr-1.5" />
                Save survey
              </>
            )}
          </Button>
          )}
        </div>
      </div>

      {/* Name and open/closed. A closed survey's link says so instead of
          showing the form; nothing is deleted. */}
      <Card className="mb-6">
        <CardContent className="grid gap-4 py-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <div>
            <Label htmlFor="survey-name" className="text-xs mb-1.5 block">
              Survey name {isCertificate && <span className="text-muted-foreground">(for your team; attendees see the event name)</span>}
            </Label>
            <Input
              id="survey-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Webinar feedback"
              maxLength={120}
              disabled={!canEdit}
            />
          </div>
          <div className="flex items-center gap-3">
            <Switch
              id="survey-active"
              checked={isActive}
              onCheckedChange={(next) => {
                // Closing the CME survey stops its invitations and certificate
                // issuing, so it is confirmed rather than one click.
                if (
                  !next &&
                  isCertificate &&
                  !window.confirm(
                    "Close the certificate (CME) survey? Its link will say the survey is closed, Survey Invitations cannot be sent, and no new CME certificates are issued from it until you open it again. Answers already given are kept.",
                  )
                ) {
                  return;
                }
                setIsActive(next);
              }}
              disabled={!canEdit}
            />
            <Label htmlFor="survey-active" className="text-sm">
              {isActive ? "Open for answers" : "Closed"}
            </Label>
          </div>
          {!isCertificate && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="survey-response-mode">Answers allowed</Label>
              <Select
                value={responseMode}
                onValueChange={(v) => setResponseMode(v as SurveyResponseModeValue)}
                disabled={!canEdit || responseCount > 0}
              >
                <SelectTrigger id="survey-response-mode" className="w-full sm:w-80">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ONCE">{RESPONSE_MODE_LABEL.ONCE}</SelectItem>
                  <SelectItem value="ONCE_PER_DAY">{RESPONSE_MODE_LABEL.ONCE_PER_DAY}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {responseCount > 0
                  ? "People have already answered, so this can no longer change."
                  : responseMode === "ONCE_PER_DAY"
                    ? "For daily feedback at a multi-day event: one answer per person per day (event timezone). Each person's link keeps working until it expires, so they use the same link every day. It never lets anyone change an answer already given."
                    : "Each person answers once; their link stops working after they submit."}
              </p>
            </div>
          )}
          <p className="text-xs text-muted-foreground sm:col-span-2">
            {isCertificate ? (
              <>
                Send it from{" "}
                <Link href={`/events/${eventId}/communications`} className="font-medium text-primary hover:underline">
                  Communications
                </Link>{" "}
                with the <span className="font-medium">Survey Invitation</span> email; each registrant gets a personal
                link. Completing it adds the <code className="text-xs">survey-completed</code> tag and can issue CME
                certificates.
              </>
            ) : (
              <>
                Send it from{" "}
                <Link href={`/events/${eventId}/communications`} className="font-medium text-primary hover:underline">
                  Communications
                </Link>{" "}
                with the <span className="font-medium">Survey Invitation</span> email and pick this survey; each
                registrant gets a personal link. Answers are recorded and exported, and never affect certificates.
              </>
            )}
          </p>
        </CardContent>
      </Card>

      {/* Intro + thank-you messages — organizer-authored rich text around the
          public form. Both optional; each falls back to default copy. Side by
          side on wide screens because they are the two ends of one page. */}
      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Intro message</CardTitle>
            <CardDescription className="text-xs">
              Shown at the top of the survey, above the questions: context or instructions.
              Leave blank to use the default intro.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TiptapEditor
              content={introHtml}
              onChange={setIntroHtml}
              placeholder="Your feedback helps us improve future events…"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Thank-you message</CardTitle>
            <CardDescription className="text-xs">
              Shown once someone submits the survey, and if they open a later invitation
              after already answering. Leave blank to use the default thank-you.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TiptapEditor
              content={thankYouHtml}
              onChange={setThankYouHtml}
              placeholder="Thank you for your feedback! Your certificate will follow by email…"
            />
          </CardContent>
        </Card>
        {canEdit && (
          <p className="text-xs text-muted-foreground lg:col-span-2">
            Both are saved with the survey when you click{" "}
            <span className="font-medium">Save survey</span>.
          </p>
        )}
      </div>

      {questions.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground mb-4">
              {canEdit ? "No questions yet. Add your first question to get started." : "No questions yet."}
            </p>
            {canEdit && (
            <div className="inline-flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => addQuestion("rating_1_to_5")}
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                Add rating
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => addQuestion("single_select")}
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                Add single select
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => addQuestion("text")}
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                Add free text
              </Button>
            </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {questions.map((q, idx) => (
            <QuestionCard
              key={q.id}
              question={q}
              index={idx}
              isFirst={idx === 0}
              isLast={idx === questions.length - 1}
              expanded={expanded.has(q.id)}
              onToggle={() => toggleExpanded(q.id)}
              onMove={(dir) => moveQuestion(q.id, dir)}
              onRemove={() => removeQuestion(q.id)}
              onUpdate={(patch) => updateQuestion(q.id, patch)}
              onChangeType={(type) => changeQuestionType(q.id, type)}
              canEdit={canEdit}
            />
          ))}

          {canEdit && (
          <div className="flex flex-wrap gap-2 pt-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => addQuestion("rating_1_to_5")}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Add rating
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => addQuestion("single_select")}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Add single select
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => addQuestion("text")}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Add free text
            </Button>
            <div className="flex-1" />
            {surveyId && !isCertificate && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleDelete()}
                disabled={deleting || responseCount > 0}
                title={responseCount > 0 ? "A survey with answers cannot be deleted. Close it instead." : undefined}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                Delete survey
              </Button>
            )}
          </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Per-question card ────────────────────────────────────────────────

interface QuestionCardProps {
  question: SurveyQuestion;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  expanded: boolean;
  onToggle: () => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onUpdate: (patch: Partial<SurveyQuestion>) => void;
  onChangeType: (type: SurveyQuestion["type"]) => void;
  canEdit: boolean;
}

function QuestionCard({
  question,
  index,
  isFirst,
  isLast,
  expanded,
  onToggle,
  onMove,
  onRemove,
  onUpdate,
  onChangeType,
  canEdit,
}: QuestionCardProps) {
  return (
    <Card>
      <CardHeader className="py-3 px-4">
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={onToggle}
            className="flex-1 min-w-0 text-left -m-1 p-1 rounded hover:bg-muted/50"
            aria-expanded={expanded}
          >
            <div className="flex items-start gap-2">
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {index + 1}.
              </span>
              <Badge variant="secondary" className="text-xs">
                {QUESTION_TYPE_LABELS[question.type]}
              </Badge>
              {question.required ? (
                <Badge variant="outline" className="text-xs">
                  Required
                </Badge>
              ) : (
                <Badge variant="outline" className="text-xs text-muted-foreground">
                  Optional
                </Badge>
              )}
              {/* min-w-0 + wrapping: a long question used to push the row
                  past the card's edge (truncate needs a shrinkable parent). */}
              <span className="flex-1 min-w-0 text-sm font-medium break-words line-clamp-2">
                {question.label || (
                  <span className="text-muted-foreground italic">Untitled question</span>
                )}
              </span>
              {expanded ? (
                <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
            </div>
          </button>
          {canEdit && (
          <div className="flex items-center gap-0.5 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={isFirst}
              onClick={() => onMove(-1)}
              aria-label="Move up"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={isLast}
              onClick={() => onMove(1)}
              aria-label="Move down"
            >
              <ArrowDown className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive hover:text-destructive"
              onClick={onRemove}
              aria-label="Delete question"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
          )}
        </div>
      </CardHeader>
      {expanded ? (
        <CardContent className="px-4 pb-4 pt-0 space-y-4 border-t">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr,200px] gap-3 pt-3">
            <div>
              <Label htmlFor={`q-${question.id}-label`} className="text-xs mb-1.5 block">
                Question text
              </Label>
              <Textarea
                id={`q-${question.id}-label`}
                value={question.label}
                onChange={(e) => onUpdate({ label: e.target.value })}
                placeholder="e.g. Please rate the overall conference experience."
                rows={2}
                maxLength={500}
              />
            </div>
            <div>
              <Label className="text-xs mb-1.5 block">Type</Label>
              <Select
                value={question.type}
                onValueChange={(value) =>
                  onChangeType(value as SurveyQuestion["type"])
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="rating_1_to_5">Rating (1–5)</SelectItem>
                  <SelectItem value="single_select">Single select</SelectItem>
                  <SelectItem value="text">Free text</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex items-center justify-between mt-3">
                <Label htmlFor={`q-${question.id}-required`} className="text-xs">
                  Required
                </Label>
                <Switch
                  id={`q-${question.id}-required`}
                  checked={question.required}
                  onCheckedChange={(checked) => onUpdate({ required: checked })}
                />
              </div>
            </div>
          </div>

          {question.type === "single_select" ? (
            <OptionsEditor
              options={question.options}
              onChange={(options) => onUpdate({ options })}
            />
          ) : null}

          {question.type === "text" ? (
            <div className="grid grid-cols-1 sm:grid-cols-[200px,1fr] gap-3 items-end">
              <div>
                <Label htmlFor={`q-${question.id}-maxlen`} className="text-xs mb-1.5 block">
                  Max length (optional)
                </Label>
                <Input
                  id={`q-${question.id}-maxlen`}
                  type="number"
                  min={1}
                  max={10000}
                  value={question.maxLength ?? ""}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "") {
                      onUpdate({ maxLength: undefined });
                      return;
                    }
                    const n = Number(raw);
                    if (Number.isInteger(n) && n >= 1 && n <= 10000) {
                      onUpdate({ maxLength: n });
                    }
                  }}
                  placeholder="2000"
                />
              </div>
              <div className="text-xs text-muted-foreground">
                {(question.maxLength ?? 0) > 200
                  ? "Renders as a multi-line textarea."
                  : "Renders as a single-line input."}
              </div>
            </div>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

function OptionsEditor({
  options,
  onChange,
}: {
  options: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div>
      <Label className="text-xs mb-1.5 block">
        Options{" "}
        <span className="text-muted-foreground">(2 minimum, 20 maximum)</span>
      </Label>
      <div className="space-y-2">
        {options.map((opt, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground tabular-nums w-6">
              {i + 1}.
            </span>
            <Input
              value={opt}
              onChange={(e) => {
                const next = options.slice();
                next[i] = e.target.value;
                onChange(next);
              }}
              placeholder={`Option ${i + 1}`}
              maxLength={200}
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive hover:text-destructive shrink-0"
              disabled={options.length <= 2}
              onClick={() => {
                onChange(options.filter((_, j) => j !== i));
              }}
              aria-label={`Remove option ${i + 1}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
      {options.length < 20 ? (
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => onChange([...options, ""])}
        >
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Add option
        </Button>
      ) : null}
    </div>
  );
}
