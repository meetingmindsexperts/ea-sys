"use client";

/**
 * The result of a bulk reviewer change: one headline, then each reason
 * something was skipped with what it covers. Shared by the selection dialog
 * and the pasted-sheet dialog.
 */
import { CheckCircle2 } from "lucide-react";
import type { SkipLine } from "@/lib/abstract-bulk-reviewer-outcome";

export function BulkReviewerOutcome({ headline, lines, note }: { headline: string; lines: SkipLine[]; note?: string }) {
  return (
    <div className="space-y-3" role="status">
      <p className="flex items-start gap-2 text-sm font-medium">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
        {headline}
      </p>
      {lines.length > 0 && (
        <ul className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
          {lines.map((line) => (
            <li key={line.reason}>
              <span className="font-medium">
                {line.label}: {line.count}
              </span>
              <p className="mt-0.5 break-words text-xs text-muted-foreground">
                {line.items.join(", ")}
                {line.more > 0 && ` and ${line.more} more`}
              </p>
            </li>
          ))}
        </ul>
      )}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}
