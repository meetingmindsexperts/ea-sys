import { eventCountdown } from "@/lib/event-time";

/**
 * "12 days to go" / "Day 2 of 3" / "Ended 5 days ago".
 *
 * Counted in calendar days in the EVENT's timezone (see `eventCountdown`), not
 * the viewer's, so the same event reads the same for an organizer in Dubai and
 * one in London.
 *
 * `now` is passed in rather than read here: this renders inside lists, and a
 * component that calls `Date.now()` on every row both violates React 19's
 * render purity rule and lets two rows disagree about what day it is.
 */
export function EventCountdownBadge({
  startDate,
  endDate,
  timezone,
  now,
  onDark = false,
  size = "sm",
  className = "",
}: {
  startDate: Date | string;
  endDate: Date | string;
  timezone?: string | null;
  now: Date;
  /** Render for the event header's dark gradient instead of a light surface. */
  onDark?: boolean;
  /** "lg" = the event header, where the countdown is a headline fact, not a footnote. */
  size?: "sm" | "lg";
  className?: string;
}) {
  const c = eventCountdown(startDate, endDate, timezone, now);

  // A finished event's age is noise on a dashboard — the "Completed" status pill
  // already says everything an organizer needs. Only surface time that is still
  // actionable.
  if (c.phase === "past") return null;

  const urgent = c.phase === "ongoing" || c.days <= 7; // inside the last week — start noticing

  // On the event header the badge sits on the cerulean gradient, so it is filled
  // gold (or emerald while the event is live) rather than tinted — a translucent
  // white pill disappears into the gradient, which defeats the point of putting
  // the countdown at the top of the page.
  const tone = onDark
    ? c.phase === "ongoing"
      ? "bg-emerald-400 text-emerald-950 border-emerald-300 shadow-sm"
      : "bg-amber-400 text-amber-950 border-amber-300 shadow-sm"
    : c.phase === "ongoing"
      ? "bg-green-50 text-green-700 border-green-200"
      : urgent
        ? "bg-amber-50 text-amber-700 border-amber-200"
        : "bg-muted text-muted-foreground border-border";

  const sizing =
    size === "lg"
      ? "px-3 py-0.5 text-base md:text-lg font-bold"
      : "px-2 py-0.5 text-xs font-medium";

  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border ${sizing} ${tone} ${className}`}
    >
      {c.label}
    </span>
  );
}
