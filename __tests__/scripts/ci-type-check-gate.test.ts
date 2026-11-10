/**
 * CI must FAIL when the type check fails (Nov 10, 2026).
 *
 * The "Type check & Lint" step of deploy.yml runs `npm run type-check` in the background to save
 * time and then waits for it. It ended in a bare `wait`, which returns 0 whatever the background
 * job found, so a type error could never fail the step: one sat on main for a day with every run
 * green. `wait` must name the type check's PID.
 *
 * This runs the step's REAL text from the workflow, under `bash -e` as GitHub does, with `npm`
 * replaced by a stub, so restoring the bare `wait` fails here.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WORKFLOWS = path.resolve(__dirname, "../../.github/workflows");
const deploy = fs.readFileSync(path.join(WORKFLOWS, "deploy.yml"), "utf8");

/** The `run: |` block of the named step, de-indented. */
function stepScript(name: string): string {
  const lines = deploy.split("\n");
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (start < 0) throw new Error(`step not found: ${name}`);
  const runAt = lines.findIndex((l, i) => i > start && l.trim() === "run: |");
  const indent = lines[runAt + 1].length - lines[runAt + 1].trimStart().length;
  const body: string[] = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== "" && line.length - line.trimStart().length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n").trim();
}

/** Run the step with `npm run type-check` and `npm run lint` exiting as given. */
function runStep(typeCheckExit: number, lintExit: number, typeCheckFirst = false): number | null {
  const stub = `npm() {
  if [ "$2" = "type-check" ]; then ${typeCheckFirst ? "" : "sleep 0.2;"} return ${typeCheckExit}; fi
  if [ "$2" = "lint" ]; then ${typeCheckFirst ? "sleep 0.2;" : ""} return ${lintExit}; fi
  return 99
}
`;
  return spawnSync("bash", ["-e", "-c", stub + stepScript("Type check & Lint")], { encoding: "utf8" }).status;
}

describe("deploy.yml: the Type check & Lint step", () => {
  it("is the step this test thinks it is", () => {
    const script = stepScript("Type check & Lint");
    expect(script).toContain("npm run type-check &");
    expect(script).toContain("npm run lint");
  });

  it("passes when both pass", () => {
    expect(runStep(0, 0)).toBe(0);
  });

  it("FAILS when the type check fails and lint passes: the hole this closes", () => {
    expect(runStep(2, 0)).toBe(2);
  });

  it("fails on a type error even when the type check finishes before lint does", () => {
    expect(runStep(2, 0, true)).toBe(2);
  });

  it("fails when lint fails", () => {
    expect(runStep(0, 1)).not.toBe(0);
  });
});

describe("no workflow waits for background jobs without asking how they ended", () => {
  it.each(fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)))("%s has no bare `wait`", (file) => {
    const bare = fs
      .readFileSync(path.join(WORKFLOWS, file), "utf8")
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => line === "wait");
    expect(bare, "a bare `wait` returns 0 whatever the background job found: wait on its PID").toEqual([]);
  });
});
