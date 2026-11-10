import type { SendInvitationsOutcome } from "@/hooks/use-api";

export type SendReportLevel = "error" | "warning" | "info" | "success";

export interface SendReport {
  /** The worst outcome's level: it decides the toast's colour and how long it stays. */
  level: SendReportLevel;
  /** Every outcome of the press in plain words, the worst first. */
  lines: string[];
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * One report per Send to all press. Sonner shows only the newest toast's
 * text, so a toast per outcome hid "10 could not be sent: <the reason>" behind
 * the success line (review of 428991e8, Nov 10, 2026). The lines are listed
 * worst first, so the first one is the title and names the level.
 */
export function sendInvitationsReport(res: SendInvitationsOutcome): SendReport {
  const all: Array<{ show: boolean; level: SendReportLevel; text: string }> = [
    { show: res.failed > 0, level: "error", text: `${res.failed} could not be sent: ${res.firstFailure ?? "the send failed"}` },
    {
      show: !!res.interrupted,
      level: "error",
      text: `The send stopped before the end (${res.interrupted}). Send to all starts again from the first reviewer, so use the Send button on the rows it did not reach.`,
    },
    { show: res.emailed > 0, level: "success", text: `Invitation emailed to ${plural(res.emailed, "reviewer", "reviewers")}` },
  ];
  const shown = all.filter((line) => line.show);
  if (shown.length === 0) return { level: "info", lines: ["There is nobody to send to"] };
  return { level: shown[0].level, lines: shown.map((line) => line.text) };
}
