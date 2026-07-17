"use client";

/**
 * Shared record-page layout primitives for the CRM detail pages (deal / account /
 * contact).
 *
 * The pattern is the SaaS-admin standard, with an explicit THREE-TIER hierarchy so a
 * record page never reads as one long undifferentiated stack:
 *
 *   1. Identity header — avatar/icon tile + title + subtitle + status badges +
 *      primary actions, and (optionally) a KEY-STATS strip: the 3–4 numbers that
 *      answer "where does this record stand?" without scrolling (a deal's value,
 *      stage, close date, owner).
 *   2. Main work area (left, wider) — the things a human DOES here: activity log,
 *      line items, history.
 *   3. Facts rail (right, sticky) — secondary reference facts + related people.
 *
 * On mobile it stacks header → work area → facts: the header stats already carry the
 * key context, so the work area comes before the reference rail.
 *
 * Presentational only — no data, no hooks — so all three record bodies compose the
 * same shell and stay visually consistent.
 */
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface RecordStat {
  label: string;
  value: ReactNode;
}

export function RecordHeader({
  icon: Icon,
  avatarText,
  title,
  subtitle,
  badges,
  actions,
  stats,
}: {
  icon?: LucideIcon;
  /** Initials rendered in the identity tile when there is no icon (contacts). */
  avatarText?: string;
  title: ReactNode;
  /** One muted line under the title — the record's parent/context (company, role…). */
  subtitle?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  /** Key-stats strip under the identity row — the "where does this stand?" numbers. */
  stats?: RecordStat[];
}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 p-5">
        <div className="flex min-w-0 items-start gap-3.5">
          {(Icon || avatarText) && (
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              {Icon ? (
                <Icon className="h-5 w-5" />
              ) : (
                <span className="text-sm font-semibold uppercase">{avatarText}</span>
              )}
            </div>
          )}
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight break-words">{title}</h1>
            {subtitle && <div className="mt-0.5 text-sm text-muted-foreground">{subtitle}</div>}
            {badges && <div className="mt-2 flex flex-wrap items-center gap-2">{badges}</div>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {stats && stats.length > 0 && (
        <dl className="flex flex-wrap gap-x-10 gap-y-3 border-t bg-muted/30 px-5 py-3">
          {stats.map((s) => (
            <div key={s.label} className="min-w-0">
              <dt className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                {s.label}
              </dt>
              <dd className="mt-0.5 truncate text-base font-semibold tabular-nums">{s.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** Two-column body: main work area (left, wider) + sticky facts rail (right).
 *  Stacks work-area-first on mobile — the header stats already give the context. */
export function RecordGrid({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <div className="grid items-start gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">{children}</div>
      <aside className="space-y-5 lg:sticky lg:top-6">{sidebar}</aside>
    </div>
  );
}

/** A titled card section. The muted header band separates section chrome from
 *  content so scanning the page reads as labelled groups, not one flat surface.
 *  Omit `title` to get a plain padded card (e.g. to host a component that renders
 *  its own heading). */
export function RecordCard({
  icon: Icon,
  title,
  action,
  children,
  className,
  bodyClassName,
}: {
  icon?: LucideIcon;
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("overflow-hidden rounded-xl border bg-card", className)}>
      {title && (
        <header className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
          {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
          <h2 className="text-sm font-semibold">{title}</h2>
          {action && <div className="ml-auto flex items-center gap-1">{action}</div>}
        </header>
      )}
      <div className={cn("p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

/** Definition list for the sidebar facts. */
export function Facts({ children }: { children: ReactNode }) {
  return <dl className="space-y-3.5">{children}</dl>;
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="mt-1 text-sm font-medium break-words">{children}</dd>
    </div>
  );
}

/** Muted em-dash placeholder — a redacted/absent value is never a fake 0. */
export function Dash() {
  return <span className="text-muted-foreground">—</span>;
}
