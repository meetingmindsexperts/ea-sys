"use client";

/**
 * Shared record-page layout primitives for the CRM detail pages (deal / account /
 * contact).
 *
 * The pattern is the SaaS-admin standard: a record HEADER (identity + primary
 * actions), then a two-column body — a main work area (activity, follow-ups,
 * history) and a sticky sidebar of key facts. On mobile it stacks with the facts
 * FIRST (context before the work area). Everything is one bordered `bg-card` card so
 * the page reads as grouped sections rather than one long undifferentiated stack.
 *
 * Presentational only — no data, no hooks — so all three record bodies compose the
 * same shell and stay visually consistent.
 */
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function RecordHeader({
  icon: Icon,
  title,
  badges,
  actions,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 space-y-2">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            {Icon && <Icon className="h-6 w-6 shrink-0 text-muted-foreground" />}
            <span className="break-words">{title}</span>
          </h1>
          {badges && <div className="flex flex-wrap items-center gap-2">{badges}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** Two-column body: main work area (left, wider) + sticky facts sidebar (right). */
export function RecordGrid({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <div className="grid items-start gap-5 lg:grid-cols-3">
      <div className="order-2 space-y-5 lg:order-1 lg:col-span-2">{children}</div>
      <aside className="order-1 space-y-5 lg:order-2 lg:sticky lg:top-6">{sidebar}</aside>
    </div>
  );
}

/** A titled card section. Omit `title` to get a plain padded card (e.g. to host a
 *  component that renders its own heading). */
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
        <header className="flex items-center gap-2 border-b px-4 py-3">
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
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium break-words">{children}</dd>
    </div>
  );
}

/** Muted em-dash placeholder — a redacted/absent value is never a fake 0. */
export function Dash() {
  return <span className="text-muted-foreground">—</span>;
}
