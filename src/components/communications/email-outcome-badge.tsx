import { Badge } from "@/components/ui/badge";
import { emailOutcome, type EmailOutcomeInput, type EmailOutcomeTone } from "@/lib/email-outcome";

const TONE_CLASS: Record<EmailOutcomeTone, string> = {
  neutral: "",
  good: "border-emerald-200 bg-emerald-50 text-emerald-700",
  warn: "border-amber-200 bg-amber-50 text-amber-800",
  bad: "",
};

const TONE_VARIANT: Record<EmailOutcomeTone, "secondary" | "outline" | "destructive"> = {
  neutral: "secondary",
  good: "outline",
  warn: "outline",
  bad: "destructive",
};

/**
 * The one badge for what happened to an email: Sent, Delivered, Bounced,
 * Bounced (temporary), Marked as spam or Failed (src/lib/email-outcome.ts).
 * Hovering shows the plain-words explanation.
 */
export function EmailOutcomeBadge({ row, className = "" }: { row: EmailOutcomeInput; className?: string }) {
  const outcome = emailOutcome(row);
  const variant = TONE_VARIANT[outcome.tone];
  return (
    <Badge variant={variant} className={`${TONE_CLASS[outcome.tone]} ${className}`.trim()} title={outcome.explanation ?? undefined}>
      {outcome.label}
    </Badge>
  );
}
