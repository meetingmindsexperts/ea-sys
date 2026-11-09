import { AlertCircle, Check, Clock, Minus } from "lucide-react";
import type { JourneyStep, StepState } from "@/lib/registrant-journey";
import { cn } from "@/lib/utils";

/**
 * One event's journey as a connected stepper (registrant-journey.ts):
 * vertical on a phone, a row from `sm` up. Each state has its own icon AND
 * label, never colour alone; the dots are graphics on white at 3:1 or more and
 * the labels hold AA text contrast.
 */
const STATE_STYLE: Record<StepState, { icon: typeof Check; dot: string; label: string; srLabel: string }> = {
  done: { icon: Check, dot: "bg-emerald-600 text-white", label: "text-foreground", srLabel: "Done" },
  action: { icon: AlertCircle, dot: "bg-amber-600 text-white ring-4 ring-amber-100", label: "font-semibold text-amber-900", srLabel: "Needs you" },
  waiting: { icon: Clock, dot: "border-2 border-slate-300 bg-white text-slate-500", label: "text-slate-600", srLabel: "Not yet" },
  missed: { icon: Minus, dot: "bg-slate-100 text-slate-500", label: "text-slate-500", srLabel: "Did not happen" },
};

export function JourneySteps({ steps }: { steps: JourneyStep[] }) {
  return (
    <ol className="flex flex-col sm:flex-row sm:items-start" aria-label="Your journey for this event">
      {steps.map((step, i) => {
        const style = STATE_STYLE[step.state];
        const Icon = style.icon;
        const last = i === steps.length - 1;
        return (
          <li key={step.key} className={cn("relative flex items-center gap-3 sm:flex-1 sm:flex-col sm:gap-2 sm:text-center", !last && "pb-3 sm:pb-0")}>
            {/* The line to the next step: down the dots on a phone, across them wider up. Green once this step is done. */}
            {!last && (
              <span
                aria-hidden
                className={cn(
                  "absolute left-3 top-7 h-[calc(100%-1.75rem)] w-0.5 -translate-x-1/2 rounded-full sm:left-[calc(50%+1.125rem)] sm:top-3 sm:h-0.5 sm:w-[calc(100%-2.25rem)] sm:translate-x-0 sm:-translate-y-1/2",
                  step.state === "done" ? "bg-emerald-500" : "bg-slate-200",
                )}
              />
            )}
            <span className={cn("relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full", style.dot)}>
              <Icon className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />
            </span>
            <span className={cn("text-sm leading-tight sm:max-w-[9rem] sm:text-xs", style.label)}>
              <span className="sr-only">{style.srLabel}: </span>
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
