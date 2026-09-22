import fs from "node:fs";
import { summarise, summaryMarkdown } from "./_grade";
import { readTaskLines, RUN_FILE, SUMMARY_JSON, SUMMARY_MD } from "./_report";

/**
 * Folds tasks.jsonl into summary.json (for E5's model comparison and a
 * future CI step) and summary.md (for a person), and prints the table.
 */
export default async function globalTeardownGolden() {
  const lines = readTaskLines();
  const summary = summarise(lines);
  let run: Record<string, unknown> = {};
  try {
    run = JSON.parse(fs.readFileSync(RUN_FILE, "utf8")) as Record<string, unknown>;
  } catch {
    // No run.json means setup never ran; the summary still stands on its own.
  }
  fs.writeFileSync(
    SUMMARY_JSON,
    JSON.stringify({ ...run, finishedAt: new Date().toISOString(), ...summary, tasks: lines }, null, 2),
  );
  const md = summaryMarkdown(lines);
  fs.writeFileSync(SUMMARY_MD, md);
  console.log("\n" + md);
  console.log(`[agent-golden:teardown] summary written to ${SUMMARY_JSON} and ${SUMMARY_MD}`);
}
