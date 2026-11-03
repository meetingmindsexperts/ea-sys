"use client";

/**
 * Event Settings: the DET performance code, shown under the DTCM switch while
 * it is on (or still holds text). Saved with the tab. Required while DTCM is
 * on; the rule and the normaliser live in src/lib/dtcm-performance-code.ts,
 * this is only the input.
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DTCM_PERFORMANCE_CODE_MAX,
  isValidDtcmPerformanceCode,
  normalizeDtcmPerformanceCode,
} from "@/lib/dtcm-performance-code";

interface Props {
  /** True while DTCM is on; an empty code is then a problem. */
  required: boolean;
  value: string;
  onChange: (value: string) => void;
}

export function DtcmPerformanceCodeField({ required, value, onChange }: Props) {
  const code = normalizeDtcmPerformanceCode(value);
  const problem = fieldProblem(code, required);

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-4">
      <Label htmlFor="dtcmPerformanceCode" className="text-sm font-medium">
        DET performance code {required && <span className="text-destructive">*</span>}
      </Label>
      <Input
        id="dtcmPerformanceCode"
        placeholder="e.g., PDUB01DEC2026A"
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        maxLength={DTCM_PERFORMANCE_CODE_MAX}
        aria-invalid={problem !== null}
        aria-describedby="dtcmPerformanceCode-help"
        className="font-mono"
      />
      <p id="dtcmPerformanceCode-help" className={problem ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
        {problem ??
          "The performance code DET issued with this event's permit. Every DTCM barcode for the event is bought against it, so each event has its own."}
      </p>
    </div>
  );
}

function fieldProblem(code: string | null, required: boolean): string | null {
  if (code === null) return required ? "Required while DTCM barcodes are on." : null;
  if (!isValidDtcmPerformanceCode(code)) return "Use only letters, digits, - and _.";
  return null;
}
