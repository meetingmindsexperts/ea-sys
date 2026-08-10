"use client";

/**
 * "Showing N of M — narrow the filters" for a capped CRM list.
 *
 * THE BUG THIS EXISTS TO FIX. The board returned at most 1,000 deals and said
 * nothing about it. A pipeline with 10,412 deals rendered as a pipeline with
 * 1,000 deals — not visibly broken, just quietly wrong, and every total anyone
 * read off that screen was wrong with it. On a sales pipeline that is worse than
 * an obviously empty screen, because nobody goes looking for the missing 9,412.
 *
 * Renders nothing when the list fits, so it costs nothing on a normal org.
 */
import { AlertTriangle } from "lucide-react";
import type { CrmListMeta } from "@/crm/lib/list-caps";

export function ListTruncationBanner({
  meta,
  shown,
  noun,
}: {
  meta: CrmListMeta | undefined;
  /** How many rows actually rendered — the honest numerator. */
  shown: number;
  /** Plural noun for the copy, e.g. "deals". */
  noun: string;
}) {
  if (!meta?.truncated) return null;

  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <p>
        Showing <b className="tabular-nums">{shown.toLocaleString()}</b> of{" "}
        <b className="tabular-nums">{meta.total.toLocaleString()}</b> {noun}. Narrow the filters
        to see the rest — totals on this screen cover only what is shown.
      </p>
    </div>
  );
}
