/**
 * A logger call may carry its stable code ONCE. `logger.warn({ msg: "a:b" },
 * "A sentence")` makes pino write two "msg" keys on one line; a JSON parser
 * keeps the last, so the code is lost exactly where the line is searched
 * (SystemLog, CloudWatch). The sentence belongs in a `detail` field.
 * Found by the production warnings audit, Nov 10 2026 (33 call sites).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import ts from "typescript";

const ROOT = path.resolve(__dirname, "../..");
const LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function hasMsgKey(node: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some((p) => p.name !== undefined && p.name.getText() === "msg");
}

/** `x.warn({ msg, ... }, somethingElse)`: the shape that writes msg twice. */
function doubleMsgCalls(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    ts.forEachChild(node, visit);
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    if (!LEVELS.has(node.expression.name.text) || node.arguments.length < 2) return;
    if (!hasMsgKey(node.arguments[0])) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    found.push(`${path.relative(ROOT, file)}:${line + 1}`);
  };
  visit(sf);
  return found;
}

describe("logger calls carry msg once", () => {
  it("the check itself sees the double-msg shape", () => {
    const bad = 'apiLogger.warn({ msg: "a:b", eventId }, "A sentence");';
    const good = 'apiLogger.warn({ msg: "a:b", eventId, detail: "A sentence" });';
    expect(doubleMsgCalls("x.ts", bad)).toHaveLength(1);
    expect(doubleMsgCalls("x.ts", good)).toHaveLength(0);
  });

  it("no call in src/ or worker/ passes msg in the object and a second message", () => {
    const found = ["src", "worker"]
      .flatMap((dir) => sourceFiles(path.join(ROOT, dir)))
      .filter((file) => fs.readFileSync(file, "utf8").includes("msg"))
      .flatMap((file) => doubleMsgCalls(file, fs.readFileSync(file, "utf8")));
    expect(found).toEqual([]);
  });
});
