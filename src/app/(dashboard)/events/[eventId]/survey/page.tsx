"use client";

/**
 * Admin Survey Builder UI — per-event question editor.
 *
 *   /events/[eventId]/survey
 *
 * Each event has at most one survey, stored as ordered JSON on
 * `Event.surveyConfig`. The builder:
 *
 *   - lets the admin add / edit / reorder (up/down) / delete questions
 *   - per-question: type (single_select / rating_1_to_5 / text),
 *     label, required flag, options (single_select only), maxLength
 *     (text only)
 *   - saves via PUT /api/events/[eventId] with `{ surveyConfig: [...] }`
 *     or `{ surveyConfig: null }` to clear
 *
 * Q1 the question `id` is generated via `newQuestionId()` exactly once
 * at create time and preserved across renames + reorders — this is
 * the answer-linkage key. NEVER re-derive from array index.
 *
 * Q2 we don't use Tiptap here — labels are short strings, not rich
 * text. (Per the plan §"Per-event content editor UI conventions".)
 *
 * Q3 drag-to-reorder is explicitly deferred. Up/down arrow buttons.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
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

const QUESTION_TYPE_LABELS: Record<SurveyQuestion["type"], string> = {
  single_select: "Single select",
  rating_1_to_5: "Rating (1–5)",
  text: "Free text",
};

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
  const eventId = params.eventId as string;

  const [eventName, setEventName] = useState<string>("");
  const [eventSlug, setEventSlug] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [questions, setQuestions] = useState<SurveyQuestion[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // ── Load ─────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/events/${eventId}`);
        if (!res.ok) {
          toast.error("Could not load the event.");
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        setEventName(data.name ?? "");
        setEventSlug(data.slug ?? "");
        const stored = data.surveyConfig;
        if (Array.isArray(stored)) {
          // Validate against the current Zod schema before adopting —
          // an older format (e.g. pre-shape-change) would otherwise
          // round-trip and crash the builder when an admin clicked Save.
          const parsed = surveyConfigSchema.safeParse(stored);
          if (parsed.success) {
            setQuestions(parsed.data);
          } else {
            console.warn("survey:stored-config-invalid", parsed.error.flatten());
            toast.error(
              "The saved survey has an unrecognized format. Please rebuild it.",
            );
            setQuestions([]);
          }
        } else {
          setQuestions([]);
        }
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
  }, [eventId]);

  // ── Mutations (immutable updates) ────────────────────────────────────

  const addQuestion = useCallback((type: SurveyQuestion["type"]) => {
    const q = defaultQuestion(type);
    setQuestions((prev) => [...prev, q]);
    setExpanded((prev) => new Set(prev).add(q.id));
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

  const handleSave = useCallback(
    async (mode: "save" | "clear") => {
      if (mode === "save") {
        const parsed = surveyConfigSchema.safeParse(questions);
        if (!parsed.success) {
          const first = parsed.error.issues[0];
          toast.error(
            first ? `${first.path.join(".") || "Survey"}: ${first.message}` : "Please fix the survey before saving.",
          );
          return;
        }
      }
      setSaving(true);
      try {
        const res = await fetch(`/api/events/${eventId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            surveyConfig: mode === "clear" ? null : questions,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          toast.error(
            typeof data.error === "string"
              ? data.error
              : "Failed to save the survey.",
          );
          return;
        }
        toast.success(mode === "clear" ? "Survey cleared." : "Survey saved.");
        if (mode === "clear") setQuestions([]);
      } catch (err) {
        console.error("survey:save-failed", err);
        toast.error("Failed to save the survey.");
      } finally {
        setSaving(false);
      }
    },
    [eventId, questions],
  );

  const dirtyCount = questions.length;
  const previewLink = useMemo(() => {
    if (!eventSlug) return null;
    return `/e/${encodeURIComponent(eventSlug)}/survey`;
  }, [eventSlug]);

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
    <div className="container max-w-4xl py-8">
      <div className="mb-6">
        <Link
          href={`/events/${eventId}`}
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3 mr-1" />
          Back to event
        </Link>
      </div>

      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold">Survey</h1>
          <p className="text-muted-foreground mt-1">
            Post-event feedback questions for <span className="font-medium">{eventName}</span>.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {previewLink ? (
            <Link
              href={`${previewLink}?token=preview`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button variant="outline" size="sm">
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                Preview
              </Button>
            </Link>
          ) : null}
          <Button
            onClick={() => void handleSave("save")}
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
        </div>
      </div>

      {/* How it works — gated by a small disclosure so it doesn't shout */}
      <Card className="mb-6 border-dashed">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">How surveys work</CardTitle>
          <CardDescription className="text-xs">
            Send invitations from the Communications page after the event ends. Each registrant
            receives a unique link valid for 7 days. Completing the survey adds the{" "}
            <code className="text-xs">survey-completed</code> tag to their record — useful as
            a filter when issuing CME certificates.
          </CardDescription>
        </CardHeader>
      </Card>

      {questions.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground mb-4">
              No questions yet. Add your first question to get started.
            </p>
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
            />
          ))}

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
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleSave("clear")}
              disabled={saving}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
              Clear survey
            </Button>
          </div>
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
}: QuestionCardProps) {
  return (
    <Card>
      <CardHeader className="py-3 px-4">
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={onToggle}
            className="flex-1 text-left -m-1 p-1 rounded hover:bg-muted/50"
            aria-expanded={expanded}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground tabular-nums">
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
              <span className="flex-1 text-sm font-medium truncate">
                {question.label || (
                  <span className="text-muted-foreground italic">Untitled question</span>
                )}
              </span>
              {expanded ? (
                <ChevronUp className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              )}
            </div>
          </button>
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
