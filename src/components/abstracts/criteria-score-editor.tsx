"use client";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { computeWeightedOverallScore, DEFAULT_REVIEW_SCORE_SCALE, type ReviewScoreScale } from "@/lib/abstract-score";

export interface CriteriaScoreItem {
  criterionId: string;
  name: string;
  weight: number;
  score: number;
}

interface ReviewCriterion {
  id: string;
  name: string;
  weight: number;
}

interface CriteriaScoreEditorProps {
  criteria: ReviewCriterion[];
  /** What each criterion is scored out of on this event: 5, 10 or 100. */
  scale?: ReviewScoreScale;
  value: CriteriaScoreItem[] | null;
  onChange: (value: CriteriaScoreItem[]) => void;
  // Fallback: plain 0-100 score when no criteria configured
  plainScore?: number | null;
  onPlainScoreChange?: (score: number | null) => void;
}

export function CriteriaScoreEditor({
  criteria,
  scale = DEFAULT_REVIEW_SCORE_SCALE,
  value,
  onChange,
  plainScore,
  onPlainScoreChange,
}: CriteriaScoreEditorProps) {
  if (criteria.length === 0) {
    // Fallback: legacy plain score input
    return (
      <div>
        <Label>Score (0–100)</Label>
        <Input
          type="number"
          min={0}
          max={100}
          value={plainScore ?? ""}
          onChange={(e) => {
            const v = e.target.value === "" ? null : Number(e.target.value);
            onPlainScoreChange?.(v);
          }}
          className="mt-1"
          placeholder="Optional"
        />
      </div>
    );
  }

  function getScore(criterionId: string): number | "" {
    return value?.find((s) => s.criterionId === criterionId)?.score ?? "";
  }

  // Each criterion is a whole number from 0 to the event's scale, as the server
  // requires. Blank means not scored yet, which is different from a score of 0.
  function handleChange(criterion: ReviewCriterion, rawScore: string) {
    const others = (value ?? []).filter((s) => s.criterionId !== criterion.id);
    if (rawScore === "") return onChange(others);
    const score = Math.min(scale, Math.max(0, Math.round(Number(rawScore))));
    if (!Number.isFinite(score)) return onChange(others);
    onChange([...others, { criterionId: criterion.id, name: criterion.name, weight: criterion.weight, score }]);
  }

  const computedScore = value && value.length > 0 ? computeWeightedOverallScore(value, scale) : null;

  return (
    <div className="space-y-3">
      {criteria.map((c) => (
        <div key={c.id} className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-medium truncate">{c.name}</span>
              <Badge variant="secondary" className="text-xs shrink-0">
                {c.weight}%
              </Badge>
            </div>
            <Input
              type="number"
              min={0}
              max={scale}
              value={getScore(c.id)}
              onChange={(e) => handleChange(c, e.target.value)}
              placeholder={`0 to ${scale}`}
              aria-label={`${c.name}: score from 0 to ${scale}`}
              className="h-8 text-sm"
            />
          </div>
        </div>
      ))}
      {computedScore !== null && (
        <div className="flex items-center justify-between pt-2 border-t text-sm">
          <span className="text-muted-foreground">Weighted Score</span>
          <span className="font-semibold">{computedScore} / 100</span>
        </div>
      )}
    </div>
  );
}
