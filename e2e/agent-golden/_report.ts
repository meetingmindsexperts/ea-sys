import fs from "node:fs";
import path from "node:path";
import type { TaskReportLine } from "./_grade";

/**
 * Where a golden run writes its numbers. tasks.jsonl grows one line per
 * task as the run goes (so a killed run still leaves a partial record);
 * the teardown folds it into summary.json and summary.md. All under
 * test-results/, which is gitignored.
 */
export const REPORT_DIR = path.resolve(process.cwd(), "test-results", "agent-golden");
export const TASKS_FILE = path.join(REPORT_DIR, "tasks.jsonl");
export const RUN_FILE = path.join(REPORT_DIR, "run.json");
export const SUMMARY_JSON = path.join(REPORT_DIR, "summary.json");
export const SUMMARY_MD = path.join(REPORT_DIR, "summary.md");

/** Default 1.5M charged tokens per run (input + output + cache writes); cache reads are not counted. */
export const DEFAULT_TOKEN_CAP = 1_500_000;

export function tokenCap(): number {
  const raw = Number(process.env.AGENT_GOLDEN_TOKEN_CAP);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOKEN_CAP;
}

export function readTaskLines(): TaskReportLine[] {
  if (!fs.existsSync(TASKS_FILE)) return [];
  return fs
    .readFileSync(TASKS_FILE, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TaskReportLine);
}

export function appendTaskLine(line: TaskReportLine): void {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.appendFileSync(TASKS_FILE, JSON.stringify(line) + "\n");
}
