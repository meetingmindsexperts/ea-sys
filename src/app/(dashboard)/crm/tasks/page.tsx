"use client";

/**
 * My Tasks — the follow-ups.
 *
 * Overdue is surfaced separately and first, because a follow-up list that buries
 * the thing you were supposed to do last Tuesday among the things due next month
 * is just a list.
 */
import { Suspense, useState } from "react";
import { useSession } from "next-auth/react";
import { Archive, ArchiveRestore, CheckCircle2, CheckSquare, Circle, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CrmEmptyState } from "@/crm/components/crm-empty-state";
import { CrmListSkeleton } from "@/crm/components/crm-skeletons";
import { OwnerFilter } from "@/crm/components/filters/owner-filter";
import { DateRangeFilter } from "@/crm/components/filters/date-range-filter";
import { useCrmFilters } from "@/crm/lib/use-crm-filters";
import { useCrmTasks, useDeleteTask, useRestoreTask, useUpdateTask } from "@/crm/hooks/use-crm-api";
import { canOwnDeals, canDeleteCrm } from "@/crm/lib/crm-roles";
import { personName, type CrmTaskRow } from "@/crm/lib/crm-types";
import { cn } from "@/lib/utils";

const TASK_FILTER_KEYS = ["owner", "dueFrom", "dueTo"];

function TasksPageInner() {
  const { data: session } = useSession();
  const canWrite = canOwnDeals(session?.user?.role);
  const canDelete = canDeleteCrm(session?.user?.role);

  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [status, setStatus] = useState<"OPEN" | "DONE">("OPEN");
  const [showArchived, setShowArchived] = useState(false);

  const { get, set, clear, anyActive } = useCrmFilters();
  const taskFilters = {
    ownerId: get("owner") || undefined,
    dueFrom: get("dueFrom") || undefined,
    dueTo: get("dueTo") || undefined,
    archived: showArchived ? "1" : undefined,
  };
  const filtersActive = anyActive(TASK_FILTER_KEYS);

  const { data: tasks = [], isLoading } = useCrmTasks(scope, status, taskFilters);
  const update = useUpdateTask();
  const del = useDeleteTask();
  const restore = useRestoreTask();

  const now = new Date();
  const overdue = tasks.filter((t) => t.dueAt && new Date(t.dueAt) < now && t.status === "OPEN");
  const rest = tasks.filter((t) => !overdue.includes(t));

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Follow-ups on deals and accounts</p>
        <div className="flex items-center gap-2">
          <Tabs value={scope} onValueChange={(v) => setScope(v as "mine" | "all")}>
            <TabsList>
              <TabsTrigger value="mine">Mine</TabsTrigger>
              <TabsTrigger value="all">Everyone</TabsTrigger>
            </TabsList>
          </Tabs>
          <Tabs value={status} onValueChange={(v) => setStatus(v as "OPEN" | "DONE")}>
            <TabsList>
              <TabsTrigger value="OPEN">Open</TabsTrigger>
              <TabsTrigger value="DONE">Done</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 p-2">
        {/* An explicit rep filter shows THEIR tasks — it overrides the mine/all tab. */}
        <OwnerFilter value={get("owner")} onChange={(v) => set({ owner: v })} placeholder="Any rep" />
        <DateRangeFilter
          label="Due"
          from={get("dueFrom")}
          to={get("dueTo")}
          onFromChange={(v) => set({ dueFrom: v })}
          onToChange={(v) => set({ dueTo: v })}
        />
        <Button
          variant={showArchived ? "default" : "outline"}
          size="sm"
          onClick={() => setShowArchived((v) => !v)}
        >
          <Archive className="mr-2 h-3.5 w-3.5" />
          {showArchived ? "Showing archived" : "Show archived"}
        </Button>
        {filtersActive && (
          <Button variant="ghost" size="sm" onClick={() => clear(TASK_FILTER_KEYS)}>
            <X className="mr-1 h-3.5 w-3.5" />
            Clear
          </Button>
        )}
      </div>

      {isLoading ? (
        <CrmListSkeleton rows={5} />
      ) : tasks.length === 0 ? (
        <CrmEmptyState
          icon={CheckSquare}
          title={
            showArchived
              ? "No archived tasks"
              : status === "OPEN"
                ? "Nothing outstanding"
                : "Nothing completed yet"
          }
          description={
            showArchived
              ? "Tasks you archive will show up here, ready to restore."
              : status === "OPEN"
                ? "Add a follow-up from a deal to start tracking it here."
                : "Completed follow-ups will appear here."
          }
        />
      ) : (
        <div className="space-y-6">
          {overdue.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold text-destructive">
                Overdue ({overdue.length})
              </h2>
              {overdue.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  overdue
                  canWrite={canWrite}
                  canDelete={canDelete}
                  onToggle={() =>
                    update.mutate({ taskId: t.id, status: t.status === "OPEN" ? "DONE" : "OPEN" })
                  }
                  onArchive={() => del.mutate(t.id)}
                  onRestore={() => restore.mutate(t.id)}
                />
              ))}
            </section>
          )}

          {rest.length > 0 && (
            <section className="space-y-2">
              {overdue.length > 0 && (
                <h2 className="text-sm font-semibold text-muted-foreground">Everything else</h2>
              )}
              {rest.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  canWrite={canWrite}
                  canDelete={canDelete}
                  onToggle={() =>
                    update.mutate({ taskId: t.id, status: t.status === "OPEN" ? "DONE" : "OPEN" })
                  }
                  onArchive={() => del.mutate(t.id)}
                  onRestore={() => restore.mutate(t.id)}
                />
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function TaskRow({
  task,
  overdue,
  canWrite,
  canDelete,
  onToggle,
  onArchive,
  onRestore,
}: {
  task: CrmTaskRow;
  overdue?: boolean;
  canWrite: boolean;
  canDelete: boolean;
  onToggle: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const done = task.status === "DONE";
  const archived = !!task.archivedAt;

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3 transition-colors hover:border-primary/30",
        archived && "opacity-60",
      )}
    >
      <button
        type="button"
        onClick={canWrite ? onToggle : undefined}
        disabled={!canWrite}
        aria-label={done ? "Reopen task" : "Complete task"}
        className="mt-0.5 text-muted-foreground hover:text-foreground disabled:cursor-default"
      >
        {done ? (
          <CheckCircle2 className="h-5 w-5 text-emerald-600" />
        ) : (
          <Circle className="h-5 w-5" />
        )}
      </button>

      <div className="flex-1">
        <p className={done ? "text-sm text-muted-foreground line-through" : "text-sm font-medium"}>
          {task.title}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {task.dueAt && (
            <span className={overdue ? "font-medium text-destructive" : undefined}>
              Due {new Date(task.dueAt).toLocaleDateString()}
            </span>
          )}
          {task.deal && <Badge variant="outline" className="text-[10px]">{task.deal.name}</Badge>}
          {task.company && <Badge variant="outline" className="text-[10px]">{task.company.name}</Badge>}
          <span>{personName(task.owner)}</span>
        </div>
      </div>

      {canDelete &&
        (archived ? (
          <button
            type="button"
            aria-label="Restore task"
            onClick={onRestore}
            className="text-muted-foreground hover:text-foreground"
          >
            <ArchiveRestore className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Archive task"
            onClick={onArchive}
            className="text-muted-foreground hover:text-destructive"
          >
            <Archive className="h-4 w-4" />
          </button>
        ))}
    </div>
  );
}

export default function CrmTasksPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <TasksPageInner />
    </Suspense>
  );
}
