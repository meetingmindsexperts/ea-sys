"use client";
/**
 * The budget's activity log: who did what, when, in plain words, newest
 * first. The sentences come from the server (the activity route runs the
 * describer), so this card only lays them out. Twelve entries show at first;
 * the rest unfold on request.
 */
import { useState } from "react";
import { History, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fmtWhen } from "@/procurement/components/budget-ui";
import { useBudgetActivity } from "@/procurement/hooks/use-procurement-api";

const INITIAL = 12;

export function BudgetActivityCard({ budgetId }: { budgetId: string }) {
  const q = useBudgetActivity(budgetId);
  const [showAll, setShowAll] = useState(false);
  const items = q.data?.items ?? [];
  const visible = showAll ? items : items.slice(0, INITIAL);

  return (
    <section className="rounded-lg border bg-card" aria-label="Activity">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <History className="h-4 w-4 text-muted-foreground" /> Activity
        </h2>
        {items.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {q.data?.truncated ? `latest ${items.length}` : `${items.length} ${items.length === 1 ? "entry" : "entries"}`}
          </span>
        )}
      </div>
      {q.isPending ? (
        <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading the log</div>
      ) : q.isError ? (
        <p className="px-4 py-6 text-sm text-destructive">{`Could not load the activity log. ${q.error instanceof Error ? q.error.message : ""}`}</p>
      ) : items.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">Nothing recorded yet.</p>
      ) : (
        <ol className="divide-y">
          {visible.map((it) => (
            <li key={it.id} className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[11rem_1fr]">
              <div className="text-xs text-muted-foreground">
                <time dateTime={it.at}>{fmtWhen(it.at)}</time>
                <div className="truncate" title={it.actor?.email ?? undefined}>{it.actor?.name || it.actor?.email || "System"}</div>
              </div>
              <div className="min-w-0">
                <div className="font-medium">{it.title}</div>
                {it.detail && <div className="text-muted-foreground">{it.detail}</div>}
              </div>
            </li>
          ))}
        </ol>
      )}
      {items.length > INITIAL && (
        <div className="border-t px-4 py-2">
          <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show fewer" : `Show all ${items.length}`}
          </Button>
        </div>
      )}
    </section>
  );
}
