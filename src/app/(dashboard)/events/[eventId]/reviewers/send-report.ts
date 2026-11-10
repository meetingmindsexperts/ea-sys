import type { SendInvitationsOutcome } from "@/hooks/use-api";

export type SendReportLevel = "error" | "warning" | "info" | "success";

export interface SendReport {
  /** The worst outcome's level: it decides the toast's colour and how long it stays. */
  level: SendReportLevel;
  /** Every outcome of the press in plain words, the worst first. */
  lines: string[];
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Enough names to act on without a toast that fills the screen. */
const MAX_NAMES = 8;

function nameList(names: string[]): string {
  if (names.length <= MAX_NAMES) return names.join(", ");
  return `${names.slice(0, MAX_NAMES).join(", ")} and ${names.length - MAX_NAMES} more`;
}

/**
 * One report per Send to all press. Sonner shows only the newest toast's
 * text, so a toast per outcome hid "10 could not be sent: <the reason>" behind
 * the success line (review of 428991e8, Nov 10, 2026). The lines are listed
 * worst first, so the first one is the title and names the level.
 *
 * It NAMES who was not emailed (review of 94a2aee5): the send goes in id
 * order, not the order on screen, and no row is marked as sent, so "3 could
 * not be sent" or "it stopped part-way" left the organiser one option, pressing
 * Send to all again and emailing everyone twice. `onPage` is the list the
 * organiser is looking at.
 */
export function sendInvitationsReport(res: SendInvitationsOutcome, onPage: { userId: string; name: string }[] = []): SendReport {
  const nameOf = new Map(onPage.map((r) => [r.userId, r.name]));
  const failedNames = res.failedIds.map((id) => nameOf.get(id)).filter((n): n is string => !!n);
  const reached = new Set([...res.emailedIds, ...res.failedIds]);
  const notReached = onPage.filter((r) => !reached.has(r.userId)).map((r) => r.name);
  const who = failedNames.length > 0 ? ` (${nameList(failedNames)})` : "";
  const rest = notReached.length > 0 ? ` Not reached: ${nameList(notReached)}.` : "";

  const all: Array<{ show: boolean; level: SendReportLevel; text: string }> = [
    { show: res.failed > 0, level: "error", text: `${res.failed} could not be sent${who}: ${res.firstFailure ?? "the send failed"}` },
    {
      show: !!res.interrupted,
      level: "error",
      text: `The send stopped before the end (${res.interrupted}).${rest} Use the Send invitation button on their rows: Send to all would email everyone again.`,
    },
    { show: res.emailed > 0, level: "success", text: `Invitation emailed to ${plural(res.emailed, "reviewer", "reviewers")}` },
  ];
  const shown = all.filter((line) => line.show);
  if (shown.length === 0) return { level: "info", lines: ["There is nobody to send to"] };
  return { level: shown[0].level, lines: shown.map((line) => line.text) };
}
