import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The dashboard's type scale (Oct 7, 2026). Five steps, each with one job:
 *
 *   Page title       24px semibold   PageHeader       one per page
 *   Section heading  18px semibold   SectionHeading   a group of cards or a big card
 *   Card title       16px semibold   CardTitle        a single card
 *   Body             14px normal     (default)        content
 *   Meta             12px muted      text-xs + muted  dates, hints, counts
 *
 * Size carries the rank, so weight and grey can stay quiet: medium weight is
 * for things you can click, and muted text is for meta only. A page that picks
 * its own heading classes drifts from the others, which is how the platform
 * ended up with fifteen page-title styles; reach for these instead.
 */

export function PageHeader({
  icon: Icon,
  title,
  description,
  actions,
  leading,
  trailing,
  className,
}: {
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Buttons on the right. */
  actions?: React.ReactNode;
  /** Before the title, such as a back link. */
  leading?: React.ReactNode;
  /** After the title text, such as a loading spinner. */
  trailing?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-4", className)}>
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2.5">
          {leading}
          {Icon && <Icon className="h-6 w-6 shrink-0 text-primary" aria-hidden />}
          <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
          {trailing}
        </div>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function SectionHeading({
  title,
  description,
  actions,
  as: Tag = "h2",
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  as?: "h2" | "h3";
  className?: string;
}) {
  return (
    <div className={cn("flex items-end justify-between gap-4", className)}>
      <div className="min-w-0 space-y-0.5">
        <Tag className="text-lg font-semibold tracking-tight">{title}</Tag>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

/**
 * One group of form fields inside a card: the group's name and a line about it
 * on the left, the fields on the right (stacked on narrow screens). A long form
 * gets its hierarchy from these groups, not from bigger labels: twenty fields
 * in one grid read as twenty equals however the card title is set.
 */
export function FormSection({
  title,
  description,
  children,
  className,
  contentClassName,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <section
      className={cn(
        "grid gap-x-10 gap-y-4 border-t pt-6 first:border-t-0 first:pt-0 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]",
        className,
      )}
    >
      <div className="space-y-1">
        <h3 className="text-base font-semibold">{title}</h3>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      <div className={cn("min-w-0 space-y-4", contentClassName)}>{children}</div>
    </section>
  );
}

/**
 * A settings card: one FormSection in its own card. The title column matches
 * the grouped General tab, so every settings tab reads the same way: what the
 * group is on the left, its fields on the right.
 */
export function SettingsCard({
  title,
  description,
  children,
  className,
  titleClassName,
  contentClassName,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  titleClassName?: string;
  contentClassName?: string;
}) {
  return (
    <Card className={className}>
      <CardContent>
        <FormSection
          title={<span className={titleClassName}>{title}</span>}
          description={description}
          contentClassName={contentClassName}
        >
          {children}
        </FormSection>
      </CardContent>
    </Card>
  );
}

/** A number with its label: the label names it, the number is what you read. */
export function StatTile({
  label,
  value,
  note,
  icon,
  valueClassName,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  note?: React.ReactNode;
  icon?: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">{label}</span>
        {icon}
      </div>
      <div className={cn("text-3xl font-semibold tracking-tight tabular-nums", valueClassName)}>{value}</div>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}
