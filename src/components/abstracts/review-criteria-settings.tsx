"use client";

import { useState } from "react";
import { Plus, Trash2, Pencil, Check, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  useReviewCriteria,
  useCreateReviewCriterion,
  useUpdateReviewCriterion,
  useDeleteReviewCriterion,
  useReviewScoreScale,
  useSetReviewScoreScale,
} from "@/hooks/use-api";
import { REVIEW_SCORE_SCALES, DEFAULT_REVIEW_SCORE_SCALE, type ReviewScoreScale } from "@/lib/abstract-score";

interface ReviewCriteriaSettingsProps {
  eventId: string;
}

interface Criterion {
  id: string;
  name: string;
  weight: number;
  sortOrder: number;
}

export function ReviewCriteriaSettings({ eventId }: ReviewCriteriaSettingsProps) {
  const { data: criteria = [], isLoading } = useReviewCriteria(eventId);
  const createCriterion = useCreateReviewCriterion(eventId);
  const updateCriterion = useUpdateReviewCriterion(eventId);
  const deleteCriterion = useDeleteReviewCriterion(eventId);

  const [newName, setNewName] = useState("");
  const [newWeight, setNewWeight] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingWeight, setEditingWeight] = useState("");

  // What each criterion is scored out of (abstract-score.ts). Fixed by the
  // server once the first review is in; the card says so instead of offering it.
  const scaleQuery = useReviewScoreScale(eventId);
  const setScale = useSetReviewScoreScale(eventId);
  const scale = scaleQuery.data?.scale ?? DEFAULT_REVIEW_SCORE_SCALE;
  const scaleLocked = scaleQuery.data?.locked ?? false;

  async function handleScale(next: ReviewScoreScale) {
    if (next === scale) return;
    try {
      const saved = await setScale.mutateAsync(next);
      toast.success(`Reviewers now score each criterion from 0 to ${saved.scale}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save the scoring scale");
    }
  }

  const totalWeight = (criteria as Criterion[]).reduce((s, c) => s + c.weight, 0);
  const isBalanced = totalWeight === 100;

  async function handleCreate() {
    const name = newName.trim();
    const weight = Number(newWeight);
    if (!name || !weight || weight < 1 || weight > 100) {
      toast.error("Provide a name and a weight between 1 and 100");
      return;
    }
    try {
      await createCriterion.mutateAsync({ name, weight });
      setNewName("");
      setNewWeight("");
      toast.success(`Criterion "${name}" (${weight}%) created`);
    } catch {
      toast.error("Failed to create criterion");
    }
  }

  async function handleUpdate(criterionId: string) {
    const name = editingName.trim();
    const weight = Number(editingWeight);
    if (!name || !weight || weight < 1 || weight > 100) {
      toast.error("Provide a name and a weight between 1 and 100");
      return;
    }
    try {
      await updateCriterion.mutateAsync({ criterionId, name, weight });
      setEditingId(null);
      toast.success("Criterion updated");
    } catch {
      toast.error("Failed to update criterion");
    }
  }

  async function handleDelete(criterion: Criterion) {
    try {
      await deleteCriterion.mutateAsync(criterion.id);
      toast.success(`Criterion "${criterion.name}" deleted`);
    } catch {
      toast.error("Failed to delete criterion");
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Define weighted scoring criteria for abstract reviews. Weights should sum to 100%.
        Reviewers will score each criterion separately and a weighted average will be computed automatically.
      </p>

      {/* Scoring scale */}
      <div className="space-y-2 rounded-lg border p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Scoring scale</p>
            <p className="text-xs text-muted-foreground">What a reviewer scores each criterion out of.</p>
          </div>
          <div className="flex gap-1 rounded-lg border p-0.5" role="radiogroup" aria-label="Scoring scale">
            {REVIEW_SCORE_SCALES.map((option) => (
              <Button
                key={option}
                type="button"
                role="radio"
                aria-checked={scale === option}
                variant={scale === option ? "secondary" : "ghost"}
                size="sm"
                className="h-7 px-3 text-xs"
                disabled={!scaleQuery.data || setScale.isPending || (scaleLocked && scale !== option)}
                onClick={() => handleScale(option)}
              >
                0 to {option}
              </Button>
            ))}
          </div>
        </div>
        {/* Not yet known is not "0 to 10 and free to change": nothing is offered until the answer is in. */}
        {scaleQuery.isError && (
          <p className="text-xs text-destructive">
            The scoring scale could not be loaded.{" "}
            <button type="button" className="underline underline-offset-2" onClick={() => void scaleQuery.refetch()}>
              Retry
            </button>
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {scaleLocked
            ? `Fixed at 0 to ${scale}: ${scaleQuery.data?.reviewCount ?? 0} review${scaleQuery.data?.reviewCount === 1 ? " has" : "s have"} been submitted on it.`
            : "The overall score is still a weighted figure out of 100, whatever the scale. Choose before reviewing starts: the scale is fixed once the first review is submitted."}
        </p>
      </div>

      {/* Weight total indicator */}
      {(criteria as Criterion[]).length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Total weight:</span>
          <Badge
            variant="outline"
            className={cn(
              "font-mono",
              isBalanced
                ? "border-green-500 text-green-700 bg-green-50"
                : "border-red-400 text-red-700 bg-red-50"
            )}
          >
            {totalWeight}%
          </Badge>
          {!isBalanced && (
            <span className="text-xs text-red-600">
              {totalWeight < 100 ? `${100 - totalWeight}% short` : `${totalWeight - 100}% over`} — weights should total 100%
            </span>
          )}
        </div>
      )}

      {isLoading && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {!isLoading && ((criteria as Criterion[]).length === 0 ? (
        <p className="text-sm text-muted-foreground italic">
          No review criteria configured. Add criteria below to enable structured scoring.
          Without criteria, reviewers use a single 0–100 score.
        </p>
      ) : (
        <ul className="space-y-2">
          {(criteria as Criterion[]).map((c) => (
            <li key={c.id} className="flex items-center gap-2 p-2 rounded-lg border bg-card">
              {editingId === c.id ? (
                <>
                  <Input
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleUpdate(c.id);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    className="h-7 text-sm flex-1"
                    autoFocus
                    placeholder="Criterion name"
                  />
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    value={editingWeight}
                    onChange={(e) => setEditingWeight(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleUpdate(c.id); }}
                    className="h-7 text-sm w-20 shrink-0"
                    placeholder="%"
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0"
                    onClick={() => handleUpdate(c.id)}
                    disabled={updateCriterion.isPending}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0"
                    onClick={() => setEditingId(null)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </>
              ) : (
                <>
                  <span className="flex-1 text-sm">{c.name}</span>
                  <Badge variant="secondary" className="font-mono text-xs shrink-0">
                    {c.weight}%
                  </Badge>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0"
                    onClick={() => {
                      setEditingId(c.id);
                      setEditingName(c.name);
                      setEditingWeight(String(c.weight));
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0 text-destructive hover:text-destructive"
                    onClick={() => handleDelete(c)}
                    disabled={deleteCriterion.isPending}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      ))}

      {/* Add new criterion */}
      <div className="flex gap-2">
        <Input
          placeholder="Criterion name (e.g. Scientific Quality)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
          className="flex-1"
        />
        <Input
          type="number"
          min={1}
          max={100}
          placeholder="%"
          value={newWeight}
          onChange={(e) => setNewWeight(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
          className="w-20 shrink-0"
        />
        <Button
          onClick={handleCreate}
          disabled={!newName.trim() || !newWeight || createCriterion.isPending}
          size="sm"
        >
          <Plus className="h-4 w-4 mr-1" />
          Add
        </Button>
      </div>
    </div>
  );
}
