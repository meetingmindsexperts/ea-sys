"use client";

/**
 * My Tasks — the follow-ups.
 *
 * Overdue is surfaced separately and first, because a follow-up list that buries
 * the thing you were supposed to do last Tuesday among the things due next month
 * is just a list.
 */
import { useState } from "react";
import { useSession } from "next-auth/react";
import { CheckCircle2, Circle, Loader2, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCrmTasks, useDeleteTask, useUpdateTask } from "@/crm/hooks/use-crm-api";
import { canOwnDeals } from "@/crm/lib/crm-roles";
import { personName, type CrmTaskRow } from "@/crm/lib/crm-types";

export default function CrmTasksPage() {
  const { data: session } = useSession();
  const canWrite = canOwnDeals(session?.user?.role);

  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [status, setStatus] = useState<"OPEN" | "DONE">("OPEN");

  const { data: tasks = [], isLoading } = useCrmTasks(scope, status);
  const update = useUpdateTask();
  const del = useDeleteTask();

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

      {isLoading ? (
        <div className="flex items-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading tasks…
        </div>
      ) : tasks.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          {status === "OPEN" ? "Nothing outstanding. " : "Nothing completed yet."}
          {status === "OPEN" && "Add a follow-up from a deal."}
        </p>
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
                  onToggle={() =>
                    update.mutate({ taskId: t.id, status: t.status === "OPEN" ? "DONE" : "OPEN" })
                  }
                  onDelete={() => del.mutate(t.id)}
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
                  onToggle={() =>
                    update.mutate({ taskId: t.id, status: t.status === "OPEN" ? "DONE" : "OPEN" })
                  }
                  onDelete={() => del.mutate(t.id)}
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
  onToggle,
  onDelete,
}: {
  task: CrmTaskRow;
  overdue?: boolean;
  canWrite: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const done = task.status === "DONE";

  return (
    <div className="flex items-start gap-3 rounded-lg border p-3">
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

      {canWrite && (
        <button
          type="button"
          aria-label="Delete task"
          onClick={onDelete}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
