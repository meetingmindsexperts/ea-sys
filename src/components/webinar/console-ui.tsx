"use client";

/**
 * Pieces the Webinar Console and the webinar section of the event's Analytics page share (moved out of
 * the console page on Nov 23, 2026, when the webinar reports moved to Analytics): the event-timezone
 * context, time and duration formats, and the cards' title, tile, loading and empty states.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Loader2 } from "lucide-react";
import { CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DEFAULT_EVENT_TIMEZONE, formatDateTimeInTz } from "@/lib/event-time";

/**
 * Every time on the console is shown in the EVENT's timezone, never the
 * viewer's (owner rule, Oct 1, 2026). The page provides it once; any card
 * reads it with useEventTz().
 */
export const EventTzContext = createContext<string>(DEFAULT_EVENT_TIMEZONE);

export function useEventTz(): string {
  return useContext(EventTzContext);
}

/** A timestamp in the event timezone, or "—". */
export function fmtTz(iso: string | null | undefined, tz: string, opts?: { short?: boolean }): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : formatDateTimeInTz(d, tz, opts);
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
}

export function afterSessionTitle(hasZoom: boolean, sessionEnded: boolean): string | undefined {
  if (!hasZoom) return "Attach a Zoom webinar first";
  if (!sessionEnded) return "Available after the session ends";
  return undefined;
}

// Static class strings per tone — Tailwind can't see dynamically-built names.
export const TITLE_TONES = {
  sky: "bg-sky-100 text-sky-700",
  violet: "bg-violet-100 text-violet-700",
  emerald: "bg-emerald-100 text-emerald-700",
  amber: "bg-amber-100 text-amber-700",
  red: "bg-red-100 text-red-600",
  slate: "bg-slate-100 text-slate-600",
} as const;

export function ConsoleTitle({
  icon: Icon,
  tone,
  pulse = false,
  children,
}: {
  icon: LucideIcon;
  tone: keyof typeof TITLE_TONES;
  /** Pulses the chip icon — used by the Live-now card while the room is live. */
  pulse?: boolean;
  children: ReactNode;
}) {
  return (
    <CardTitle className="flex items-center gap-2.5">
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${TITLE_TONES[tone]}`}
      >
        <Icon className={pulse ? "h-4 w-4 animate-pulse" : "h-4 w-4"} />
      </span>
      {children}
    </CardTitle>
  );
}

export function KpiTile({
  label,
  value,
  accent,
  icon: Icon,
}: {
  label: string;
  value: number | string;
  accent?: string;
  icon?: LucideIcon;
}) {
  return (
    <div className="border rounded-lg p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wide">
        {Icon ? <Icon className="h-3 w-3" /> : null}
        {label}
      </div>
      <div className={`text-2xl font-semibold mt-1 ${accent ?? ""}`}>{value}</div>
    </div>
  );
}

// ── Consistent loading + empty state primitives ────────────────────
// Every data-backed card uses one of these instead of ad-hoc markup so
// scanning the page feels calm and predictable.
export function CardLoading() {
  return (
    <div className="flex items-center justify-center py-8">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}

export function CardEmpty({
  message,
  actionLabel,
  onAction,
  actionDisabled,
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
}) {
  return (
    <div className="rounded-lg border border-dashed p-6 text-center space-y-3">
      <p className="text-sm text-muted-foreground">{message}</p>
      {actionLabel && onAction ? (
        <Button size="sm" onClick={onAction} disabled={actionDisabled}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}
