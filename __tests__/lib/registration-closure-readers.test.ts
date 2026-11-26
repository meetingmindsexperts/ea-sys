/**
 * Every public door asks registration-closure.ts whether registration is closed. Until Nov 26, 2026
 * seven files each read `settings.registrationOpen` on their own, so a close date or a webinar
 * that was over could only ever be added to some of them. A file that reads the switch from a
 * settings object fails here until it uses the rule (or is added below with a reason).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

/** `settings.registrationOpen`, `eventSettings?.registrationOpen`, `(x as Y).registrationOpen`. */
const READS_THE_SWITCH = /(settings\w*|\))\??\.registrationOpen\b/i;

const ALLOWED: Record<string, string> = {
  "src/lib/registration-closure.ts": "the rule itself",
  "src/app/(dashboard)/events/[eventId]/settings/page.tsx": "the switch's own editor",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("who reads the registration switch", () => {
  it("only the rule and the Settings page read it from the settings", () => {
    const offenders = sourceFiles(SRC).flatMap((path) => {
      const rel = relative(ROOT, path).split("\\").join("/");
      if (ALLOWED[rel]) return [];
      return readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, i) => (READS_THE_SWITCH.test(line) ? [`${rel}:${i + 1}: ${line.trim()}`] : []));
    });
    expect(offenders).toEqual([]);
  });

  it("the pattern catches the shapes the old readers used", () => {
    for (const line of [
      "if (eventSettings.registrationOpen === false) {",
      "registrationOpen: settings.registrationOpen !== false,",
      "(settings as Record<string, unknown>).registrationOpen === false;",
    ]) {
      expect(READS_THE_SWITCH.test(line)).toBe(true);
    }
    expect(READS_THE_SWITCH.test("registrationOpen: event.registrationOpen !== false,")).toBe(false);
  });
});
