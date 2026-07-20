"use client";

/**
 * Deal value min–max. STAFF ONLY.
 *
 * The parent decides whether to render this at all (via canViewDealValues), and the
 * SERVER independently ignores value params from a non-finance caller — so this is
 * a convenience, never the security boundary. A redacted value must not become
 * binary-searchable through a filter.
 *
 * Like the date range, min/max STAGE locally and commit together on Apply (or
 * Enter) via one onApply({min,max}) — a range only means something once both ends
 * (or a deliberate one) are set, and one commit = one URL/history entry.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ValueRangeFilter({
  min,
  max,
  onApply,
}: {
  /** The APPLIED range (from the URL) — seeds the staged inputs and resets them
   *  when the range changes out from under us (Clear, back-button). */
  min: string;
  max: string;
  /** Commit both ends at once. Empty string → null clears that end. */
  onApply: (range: { min: string | null; max: string | null }) => void;
}) {
  const [pendingMin, setPendingMin] = useState(min);
  const [pendingMax, setPendingMax] = useState(max);

  // React 19 "store info from a previous render" pattern (no useEffect+setState):
  // adopt an externally-changed applied range (Clear, navigation) into the inputs.
  const [appliedMin, setAppliedMin] = useState(min);
  const [appliedMax, setAppliedMax] = useState(max);
  if (min !== appliedMin || max !== appliedMax) {
    setAppliedMin(min);
    setAppliedMax(max);
    setPendingMin(min);
    setPendingMax(max);
  }

  const dirty = pendingMin !== min || pendingMax !== max;

  function apply() {
    if (!dirty) return;
    onApply({ min: pendingMin || null, max: pendingMax || null });
  }

  return (
    <div className="flex items-center gap-2">
      <Label className="text-xs text-muted-foreground">Value</Label>
      <Input
        inputMode="numeric"
        className="w-[6.5rem]"
        placeholder="min"
        value={pendingMin}
        onChange={(e) => setPendingMin(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && apply()}
        aria-label="Minimum value"
      />
      <span className="text-muted-foreground">–</span>
      <Input
        inputMode="numeric"
        className="w-[6.5rem]"
        placeholder="max"
        value={pendingMax}
        onChange={(e) => setPendingMax(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && apply()}
        aria-label="Maximum value"
      />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={apply}
        disabled={!dirty}
        aria-label="Apply value range"
      >
        Apply
      </Button>
    </div>
  );
}
