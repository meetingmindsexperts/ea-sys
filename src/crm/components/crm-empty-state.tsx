"use client";

/**
 * One empty-state look for the whole CRM — a dashed card with an icon token, a
 * one-line title, an optional sentence, and an optional action. Consistency across
 * the five surfaces is the point (the `consistency` design rule): a bare "No data"
 * paragraph on one page and a rich state on another reads as unfinished.
 */
import type { LucideIcon } from "lucide-react";

export function CrmEmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-muted/20 px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground/70">
        <Icon className="h-6 w-6" />
      </div>
      <p className="mt-4 text-sm font-medium text-foreground">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
