"use client";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
  value: CriteriaScoreItem[] | null;
  onChange: (value: CriteriaScoreItem[]) => void;
  // Fallback: plain 0-100 score when no criteria configured
  plainScore?: number | null;
  onPlainScoreChange?: (score: number | null) => void;
}

export function CriteriaScoreEditor({
  criteria,
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

  function getScore(criterionId: string): number {
    return value?.find((s) => s.criterionId === criterionId)?.score ?? 0;
  }

  function handleChange(criterion: ReviewCriterion, rawScore: string) {
    const score = rawScore === "" ? 0 : Math.min(100, Math.max(0, Number(rawScore)));
    const existing = value ?? [];
    const updated = existing.some((s) => s.criterionId === criterion.id)
      ? existing.map((s) =>
          s.criterionId === criterion.id ? { ...s, score } : s
        )
      : [
          ...existing,
          { criterionId: criterion.id, name: criterion.name, weight: criterion.weight, score },
        ];
    onChange(updated);
  }

  const computedScore =
    value && value.length > 0
      ? Math.round(value.reduce((sum, c) => sum + (c.score * c.weight) / 100, 0))
      : null;

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
              max={100}
              value={getScore(c.id) || ""}
              onChange={(e) => handleChange(c, e.target.value)}
              placeholder="0–100"
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
