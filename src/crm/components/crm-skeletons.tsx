"use client";

/**
 * Loading skeletons for the CRM surfaces.
 *
 * The `progressive-loading` rule: for anything that can take >~300ms, show the
 * SHAPE of what's coming (columns, rows) rather than a lone centered spinner — it
 * reads as faster and doesn't collapse the layout when the data lands.
 */
import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors the deal board — a few columns of stacked cards. */
export function CrmBoardSkeleton({ columns = 5 }: { columns?: number }) {
  return (
    <div className="flex gap-4 overflow-hidden pb-4">
      {Array.from({ length: columns }).map((_, c) => (
        <div key={c} className="flex w-72 shrink-0 flex-col rounded-xl border bg-muted/30">
          <div className="flex items-center justify-between border-b px-3 py-2.5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-10" />
          </div>
          <div className="flex flex-col gap-2 p-2">
            {Array.from({ length: 3 - (c % 2) }).map((_, i) => (
              <div key={i} className="space-y-2 rounded-lg border bg-background p-3">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
                <div className="flex items-center justify-between pt-1">
                  <Skeleton className="h-5 w-16" />
                  <Skeleton className="h-4 w-12" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Mirrors a list of stacked card rows (tasks). */
export function CrmListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-start gap-3 rounded-lg border p-3">
          <Skeleton className="mt-0.5 h-5 w-5 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-4 w-4" />
        </div>
      ))}
    </div>
  );
}

/** Mirrors a data table — a header rule plus N rows. */
export function CrmTableSkeleton({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="border-b bg-muted/40 px-4 py-3">
        <Skeleton className="h-4 w-32" />
      </div>
      <div className="divide-y">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex items-center gap-4 px-4 py-3">
            <Skeleton className="h-4 flex-1" />
            {Array.from({ length: cols - 1 }).map((_, c) => (
              <Skeleton key={c} className="h-4 w-20" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
