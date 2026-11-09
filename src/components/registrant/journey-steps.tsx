import { AlertCircle, CheckCircle2, ChevronRight, Clock, MinusCircle } from "lucide-react";
import type { JourneyStep, StepState, SurveyLine } from "@/lib/registrant-journey";
import { cn } from "@/lib/utils";
import { TakeSurveyButton } from "@/components/registrant/take-survey-button";

/**
 * One event's journey as a row of steps (registrant-journey.ts). Each state
 * has its own icon AND word, never colour alone, and the colours hold AA
 * contrast on white.
 */
const STATE_STYLE: Record<StepState, { icon: typeof CheckCircle2; className: string; srLabel: string }> = {
  done: { icon: CheckCircle2, className: "border-emerald-200 bg-emerald-50 text-emerald-800", srLabel: "Done" },
  action: { icon: AlertCircle, className: "border-amber-300 bg-amber-50 text-amber-900", srLabel: "Needs you" },
  waiting: { icon: Clock, className: "border-slate-200 bg-slate-50 text-slate-700", srLabel: "Not yet" },
  missed: { icon: MinusCircle, className: "border-slate-200 bg-white text-slate-500", srLabel: "Did not happen" },
};

export function JourneySteps({ steps }: { steps: JourneyStep[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-2" aria-label="Your journey for this event">
      {steps.map((step, i) => {
        const style = STATE_STYLE[step.state];
        const Icon = style.icon;
        return (
          <li key={step.key} className="flex items-center gap-1">
            <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium", style.className)}>
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="sr-only">{style.srLabel}: </span>
              {step.label}
            </span>
            {i < steps.length - 1 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The surveys behind the Survey step, by name, when there is something to
 * say: one still to answer, or more than one survey.
 */
export function SurveyList({ surveys, registrationId }: { surveys: SurveyLine[]; registrationId: string }) {
  if (surveys.length === 0) return null;
  if (surveys.length === 1 && surveys[0].answered) return null;
  return (
    <ul className="divide-y rounded-md border text-sm">
      {surveys.map((s) => (
        <li key={s.id ?? "certificate"} className="flex flex-col gap-1 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <div className="min-w-0">
            <p className="font-medium">{s.name}</p>
            {s.certificate && !s.answered && <p className="text-xs text-muted-foreground">The certificate survey</p>}
          </div>
          {s.answered ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-emerald-800">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
              {s.daily ? "Answered today" : "Answered"}
            </span>
          ) : (
            <TakeSurveyButton registrationId={registrationId} surveyId={s.id} />
          )}
        </li>
      ))}
    </ul>
  );
}
