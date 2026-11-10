import type { SendAssignmentsOutcome } from "@/hooks/use-api";

export type SendReportLevel = "error" | "warning" | "info" | "success";

export interface SendReport {
  /** The worst outcome's level: it decides the toast's colour and how long it stays. */
  level: SendReportLevel;
  /** Every outcome of the press in plain words, the worst first. */
  lines: string[];
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * One report per Send assignments press (review of 428991e8, Nov 10, 2026).
 *
 * The page used to fire one toast per outcome. Sonner shows only the newest
 * toast's text and drops a fourth, so "10 could not be sent: <the reason>" sat
 * unread behind "3 reviewers have not set up their account", and "do not send
 * to them again" (shown nowhere else) could be covered the same way. The lines
 * are listed worst first, so the first one is the title and names the level.
 */
export function sendAssignmentsReport(res: SendAssignmentsOutcome): SendReport {
  const all: Array<{ show: boolean; level: SendReportLevel; text: string }> = [
    { show: res.failed > 0, level: "error", text: `${res.failed} could not be sent: ${res.firstFailure ?? "the send failed"}` },
    {
      show: res.notRecorded > 0,
      level: "error",
      text: `${plural(res.notRecorded, "reviewer was", "reviewers were")} emailed but it could not be recorded, so they still show as not emailed. Do not send to them again.`,
    },
    {
      show: !!res.interrupted,
      level: "error",
      text: `The send stopped before the end (${res.interrupted}). The list shows who is still waiting; pressing Send again is safe.`,
    },
    {
      show: res.notSetUp > 0,
      level: "warning",
      text: `${plural(res.notSetUp, "reviewer has", "reviewers have")} not set up their account. Send their invitation first.`,
    },
    {
      show: res.reclaimed > 0,
      level: "warning",
      text: `${plural(res.reclaimed, "reviewer", "reviewers")} had an interrupted send earlier and may receive this email twice.`,
    },
    {
      show: res.busy > 0,
      level: "info",
      text: `${plural(res.busy, "reviewer is", "reviewers are")} being emailed by another send, or a send to them was interrupted in the last 10 minutes. Try again after that.`,
    },
    { show: res.emailed > 0, level: "success", text: `Assignments emailed to ${plural(res.emailed, "reviewer", "reviewers")}` },
  ];
  const shown = all.filter((line) => line.show);
  if (shown.length === 0) return { level: "info", lines: ["Nothing new to send"] };
  return { level: shown[0].level, lines: shown.map((line) => line.text) };
}
