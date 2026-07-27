"use client";

/**
 * CRM Home — the "what needs me today" landing.
 *
 * `/crm` used to redirect straight to the board, so a rep opened the CRM onto a raw
 * pipeline with no sense of what to act on. This page answers that first question:
 * my overdue follow-ups, deals slipping past their close date, unread replies, and a
 * compact pipeline snapshot.
 *
 * It is deliberately ACTION-oriented, not analytics — Reports owns pipeline-by-stage,
 * win/loss and per-rep breakdowns. Everything here links somewhere you'd go to *do*
 * something. All data comes from existing endpoints (report / tasks / deals / inbox /
 * notifications), so there's no new server surface behind this.
 *
 * Finance is gated end to end: the report tells us `canSeeValues`, and money renders
 * "—" for a MEMBER — never a fabricated 0. MEMBER also gets tasks read-only (no
 * complete toggle), matching canOwnDeals everywhere else.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  Building2,
  CalendarClock,
  CheckSquare,
  Circle,
  Handshake,
  Inbox,
  Layers,
  Percent,
  Plus,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { CrmLoadError } from "@/crm/components/crm-load-error";
import { CreateDealDialog } from "@/crm/components/create-deal-dialog";
import { CreateTaskDialog } from "@/crm/components/create-task-dialog";
import {
  useCrmDeals,
  useCrmInboxThreads,
  useCrmNotifications,
  useCrmReport,
  useCrmStages,
  useCrmTasks,
  useUpdateTask,
} from "@/crm/hooks/use-crm-api";
import { canOwnDeals, canViewCrmInbox } from "@/crm/lib/crm-roles";
import { formatDealValue, personName, type CrmBoardDeal, type CrmTaskRow } from "@/crm/lib/crm-types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Money for a KPI/label — "—" when redacted or genuinely mixed (never a fake sum). */
function money(v: number | null, currency: string | null, mixed?: boolean): string {
  if (mixed) return "— (mixed)";
  return v === null ? "—" : formatDealValue(v, currency ?? "USD") ?? "—";
}

/** Last instant of a due date's day — a task is overdue only once this has passed. */
function endOfDueDay(dueAt: string): Date {
  const e = new Date(dueAt);
  e.setHours(23, 59, 59, 999);
  return e;
}

export function CrmOverview() {
  const { data: session } = useSession();
  const role = session?.user?.role;
  const canWrite = canOwnDeals(role);
  const showInbox = canViewCrmInbox(role);

  const router = useRouter();

  // Captured once per mount, not read during render — keeps the component pure
  // (react-hooks/purity) and the "overdue / closing soon" math stable for the view.
  const [now] = useState(() => new Date());
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const soonCutoff = new Date(startOfToday.getTime() + 7 * DAY_MS);

  const [newDealOpen, setNewDealOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);

  const report = useCrmReport({});
  const tasksQ = useCrmTasks("mine", "OPEN");
  const dealsQ = useCrmDeals({});
  const inboxQ = useCrmInboxThreads();
  const notifQ = useCrmNotifications();
  const stagesQ = useCrmStages();
  const updateTask = useUpdateTask();

  const canSeeValues = report.data?.canSeeValues ?? false;

  // ── My follow-ups ──────────────────────────────────────────────────────────
  const tasks = tasksQ.data ?? [];
  const overdueTasks = tasks
    .filter((t) => t.dueAt && endOfDueDay(t.dueAt) < now)
    .sort((a, b) => new Date(a.dueAt!).getTime() - new Date(b.dueAt!).getTime());
  const upcomingTasks = tasks
    .filter((t) => !overdueTasks.includes(t))
    .sort((a, b) => {
      // Dated tasks first (soonest up top); undated fall to the bottom.
      if (!a.dueAt) return b.dueAt ? 1 : 0;
      if (!b.dueAt) return -1;
      return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
    });

  // ── Deals needing attention: OPEN, with a close date that's overdue or ≤7 days ─
  const attentionDeals = (dealsQ.data ?? [])
    .filter((d) => d.status === "OPEN" && !d.archivedAt && d.expectedClose)
    .map((d) => ({ deal: d, close: new Date(d.expectedClose!) }))
    .filter(({ close }) => close < soonCutoff)
    .sort((a, b) => a.close.getTime() - b.close.getTime());

  const unread = showInbox ? inboxQ.data?.unreadCount ?? 0 : 0;
  const winRate = report.data?.winLoss.winRate ?? null;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Your follow-ups, deals that need a nudge, and the pipeline at a glance.
        </p>
        {canWrite && (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setNewTaskOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              New task
            </Button>
            <Button className="btn-gradient text-white shadow-sm" size="sm" onClick={() => setNewDealOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              New deal
            </Button>
          </div>
        )}
      </div>

      {/* ── KPI strip — action counts, not analytics ─────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          icon={Layers}
          label="Open pipeline"
          loading={report.isLoading}
          value={money(report.data?.pipeline.openValue ?? null, report.data?.pipeline.openCurrency ?? null, report.data?.pipeline.openMixed)}
          sub={report.data ? `${report.data.pipeline.openCount} open deal${report.data.pipeline.openCount === 1 ? "" : "s"}` : undefined}
          onClick={() => router.push("/crm/deals")}
        />
        <KpiCard
          icon={CalendarClock}
          label="Needs attention"
          loading={dealsQ.isLoading}
          value={String(attentionDeals.length)}
          sub="closing soon or overdue"
          tone={attentionDeals.length > 0 ? "warn" : undefined}
        />
        <KpiCard
          icon={AlertTriangle}
          label="Overdue tasks"
          loading={tasksQ.isLoading}
          value={String(overdueTasks.length)}
          sub={overdueTasks.length > 0 ? "past their due date" : "all caught up"}
          tone={overdueTasks.length > 0 ? "danger" : undefined}
          onClick={() => router.push("/crm/tasks")}
        />
        {showInbox ? (
          <KpiCard
            icon={Inbox}
            label="Unread replies"
            loading={inboxQ.isLoading}
            value={String(unread)}
            sub={unread > 0 ? "in the shared inbox" : "nothing new"}
            tone={unread > 0 ? "info" : undefined}
            onClick={() => router.push("/crm/inbox")}
          />
        ) : (
          <KpiCard
            icon={Percent}
            label="Win rate"
            loading={report.isLoading}
            value={winRate === null ? "—" : `${winRate}%`}
            sub={report.data ? `${report.data.winLoss.wonCount} won · ${report.data.winLoss.lostCount} lost` : undefined}
          />
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* ── Main column: deals needing attention + my tasks ─────────────────── */}
        <div className="space-y-6 lg:col-span-2">
          {/* Deals needing attention */}
          <section className="overflow-hidden rounded-xl border bg-card">
            <header className="flex items-center gap-2 border-b p-3">
              <CalendarClock className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Deals needing attention</h2>
              <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                {attentionDeals.length}
              </span>
            </header>
            {dealsQ.isLoading ? (
              <PanelSkeleton rows={4} />
            ) : dealsQ.isError ? (
              <CrmLoadError what="deals" onRetry={() => dealsQ.refetch()} />
            ) : attentionDeals.length === 0 ? (
              <PanelEmpty
                icon={Handshake}
                title="Nothing slipping"
                description="Open deals closing within a week — or already past their close date — show up here."
              />
            ) : (
              <ul className="divide-y">
                {attentionDeals.slice(0, 6).map(({ deal, close }) => (
                  <AttentionDealRow
                    key={deal.id}
                    deal={deal}
                    close={close}
                    overdue={close < startOfToday}
                    canSeeValues={canSeeValues}
                    onOpen={() => router.push(`/crm/deals/${deal.id}`)}
                  />
                ))}
                {attentionDeals.length > 6 && (
                  <li>
                    <button
                      type="button"
                      onClick={() => router.push("/crm/deals")}
                      className="flex w-full items-center justify-center gap-1 px-3 py-2.5 text-xs font-medium text-primary hover:bg-muted/40"
                    >
                      {attentionDeals.length - 6} more on the board
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </li>
                )}
              </ul>
            )}
          </section>

          {/* My tasks */}
          <section className="overflow-hidden rounded-xl border bg-card">
            <header className="flex items-center gap-2 border-b p-3">
              <CheckSquare className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">My tasks</h2>
              <button
                type="button"
                onClick={() => router.push("/crm/tasks")}
                className="ml-auto flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                View all
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </header>
            {tasksQ.isLoading ? (
              <PanelSkeleton rows={4} />
            ) : tasksQ.isError ? (
              <CrmLoadError what="tasks" onRetry={() => tasksQ.refetch()} />
            ) : tasks.length === 0 ? (
              <PanelEmpty
                icon={CheckSquare}
                title="Nothing outstanding"
                description="Follow-ups you own show up here — add one from a deal to start tracking it."
              />
            ) : (
              <div>
                {overdueTasks.length > 0 && (
                  <p className="border-b bg-destructive/5 px-3 py-1.5 text-xs font-semibold text-destructive">
                    Overdue ({overdueTasks.length})
                  </p>
                )}
                <ul className="divide-y">
                  {[...overdueTasks, ...upcomingTasks].slice(0, 7).map((t) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                      overdue={overdueTasks.includes(t)}
                      canWrite={canWrite}
                      onToggle={() => updateTask.mutate({ taskId: t.id, status: "DONE" })}
                      onOpenDeal={t.deal ? () => router.push(`/crm/deals/${t.deal!.id}`) : undefined}
                    />
                  ))}
                </ul>
                {tasks.length > 7 && (
                  <button
                    type="button"
                    onClick={() => router.push("/crm/tasks")}
                    className="flex w-full items-center justify-center gap-1 border-t px-3 py-2.5 text-xs font-medium text-primary hover:bg-muted/40"
                  >
                    {tasks.length - 7} more
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )}
          </section>
        </div>

        {/* ── Sidebar: recent activity for me ─────────────────────────────────── */}
        <section className="overflow-hidden rounded-xl border bg-card lg:col-span-1">
          <header className="flex items-center gap-2 border-b p-3">
            <Bell className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Recent for you</h2>
            {(notifQ.data?.unreadCount ?? 0) > 0 && (
              <Badge className="ml-auto bg-sky-600 text-[10px]">{notifQ.data!.unreadCount} new</Badge>
            )}
          </header>
          {notifQ.isLoading ? (
            <PanelSkeleton rows={5} />
          ) : notifQ.isError ? (
            <CrmLoadError what="your activity" onRetry={() => notifQ.refetch()} />
          ) : (notifQ.data?.notifications.length ?? 0) === 0 ? (
            <PanelEmpty
              icon={Bell}
              title="Nothing recent"
              description="Deal assignments, stage moves and task nudges land here."
            />
          ) : (
            <ul className="divide-y">
              {notifQ.data!.notifications.slice(0, 8).map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    disabled={!n.link}
                    onClick={() => n.link && router.push(n.link)}
                    className={cn(
                      "block w-full px-3 py-2.5 text-left transition-colors",
                      n.link && "cursor-pointer hover:bg-muted/40",
                    )}
                  >
                    <span className="flex items-start gap-2">
                      {!n.isRead && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-600" />}
                      <span className="min-w-0 flex-1">
                        <span className={cn("block truncate text-sm", !n.isRead && "font-medium")}>{n.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">{n.message}</span>
                        <span className="mt-0.5 block text-[11px] text-muted-foreground/70">
                          {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
                        </span>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {canWrite && (
        <>
          <CreateDealDialog
            open={newDealOpen}
            onOpenChange={setNewDealOpen}
            stages={stagesQ.data ?? []}
            defaultEventId={null}
          />
          {newTaskOpen && <CreateTaskDialog open={newTaskOpen} onOpenChange={setNewTaskOpen} />}
        </>
      )}
    </div>
  );
}

// ── Pieces ─────────────────────────────────────────────────────────────────────

function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
  tone,
  loading,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
  tone?: "warn" | "danger" | "info";
  loading?: boolean;
  onClick?: () => void;
}) {
  const toneCls =
    tone === "danger"
      ? "text-destructive"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-500"
        : tone === "info"
          ? "text-sky-600 dark:text-sky-400"
          : "";
  const inner = (
    <>
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-16" />
      ) : (
        <p className={cn("mt-2 text-2xl font-bold tabular-nums", toneCls)}>{value}</p>
      )}
      {sub && !loading && <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">{sub}</p>}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-muted/30"
      >
        {inner}
      </button>
    );
  }
  return <div className="rounded-xl border bg-card p-4">{inner}</div>;
}

function AttentionDealRow({
  deal,
  close,
  overdue,
  canSeeValues,
  onOpen,
}: {
  deal: CrmBoardDeal;
  close: Date;
  overdue: boolean;
  canSeeValues: boolean;
  onOpen: () => void;
}) {
  const value = formatDealValue(deal.dealValue, deal.currency);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{deal.name}</span>
          <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            {deal.company && (
              <span className="flex min-w-0 items-center gap-1">
                <Building2 className="h-3 w-3 shrink-0" />
                <span className="truncate">{deal.company.name}</span>
              </span>
            )}
            <span className="shrink-0">· {personName(deal.owner)}</span>
          </span>
        </span>
        <span className="shrink-0 text-right">
          {canSeeValues && (
            <span className="block text-sm font-semibold tabular-nums">
              {value ?? <span className="font-normal text-muted-foreground">—</span>}
            </span>
          )}
          <span
            className={cn(
              "flex items-center justify-end gap-1 text-xs tabular-nums",
              overdue ? "font-medium text-destructive" : "text-muted-foreground",
            )}
          >
            <CalendarClock className="h-3 w-3" />
            {overdue ? "Overdue · " : ""}
            {close.toLocaleDateString()}
          </span>
        </span>
      </button>
    </li>
  );
}

function TaskRow({
  task,
  overdue,
  canWrite,
  onToggle,
  onOpenDeal,
}: {
  task: CrmTaskRow;
  overdue: boolean;
  canWrite: boolean;
  onToggle: () => void;
  onOpenDeal?: () => void;
}) {
  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <button
        type="button"
        onClick={canWrite ? onToggle : undefined}
        disabled={!canWrite}
        aria-label="Complete task"
        className="mt-0.5 text-muted-foreground hover:text-emerald-600 disabled:cursor-default disabled:hover:text-muted-foreground"
      >
        <Circle className="h-4 w-4" />
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{task.title}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {task.dueAt && (
            <span className={overdue ? "font-medium text-destructive" : undefined}>
              Due {new Date(task.dueAt).toLocaleDateString()}
            </span>
          )}
          {task.deal &&
            (onOpenDeal ? (
              <button
                type="button"
                onClick={onOpenDeal}
                className="max-w-[12rem] truncate rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted/60"
              >
                {task.deal.name}
              </button>
            ) : (
              <Badge variant="outline" className="text-[10px]">
                {task.deal.name}
              </Badge>
            ))}
          {task.company && <Badge variant="outline" className="text-[10px]">{task.company.name}</Badge>}
        </div>
      </div>
    </li>
  );
}

function PanelSkeleton({ rows }: { rows: number }) {
  return (
    <div className="divide-y">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-3">
          <Skeleton className="h-4 w-4 shrink-0 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

function PanelEmpty({ icon: Icon, title, description }: { icon: LucideIcon; title: string; description: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-6 py-10 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground/70">
        <Icon className="h-5 w-5" />
      </div>
      <p className="mt-1 text-sm font-medium">{title}</p>
      <p className="max-w-xs text-xs text-muted-foreground">{description}</p>
    </div>
  );
}
