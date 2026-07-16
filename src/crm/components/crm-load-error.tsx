"use client";

/**
 * The "couldn't load" card every CRM list page renders on a failed fetch.
 *
 * WHY THIS EXISTS (CRM review M6): every list page destructured
 * `{ data = [], isLoading }` and ignored `isError`, so a failed
 * GET /api/crm/deals (session lapse, 500, network) rendered as "No deals yet" —
 * the `= []` default converts an error into a false fact ("your pipeline is
 * empty"). An error state must never render as an empty state — the exact class
 * fixed in core for the registrant portal on June 26.
 */
import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CrmLoadError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center">
      <AlertTriangle className="h-8 w-8 text-destructive" />
      <div>
        <p className="font-medium">Couldn&apos;t load {what}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Your data is safe — this is a loading problem, not an empty {what.replace(/s$/, "")} list.
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RotateCw className="mr-2 h-4 w-4" />
        Try again
      </Button>
    </div>
  );
}
