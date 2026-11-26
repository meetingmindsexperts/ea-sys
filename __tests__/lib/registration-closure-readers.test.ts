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
const READS_THE_SWITCH = /(settings\w*|\))\??\.registrationOpen\b|\[["']registrationOpen["']\]|\{[^}]*\bregistrationOpen\b[^}]*\}\s*=\s*\w*settings/i;

/** A public file that creates a registration, directly or through a service. */
const CREATES_A_REGISTRATION = /registration\.create\(|createGroupRegistration\(|ensureSubmitterRegistration\(|createRegistration\(/;

/**
 * How each public door asks the rule. presenter-signup.ts asks it inside resolvePresenterRateSelection
 * (settingsClosedReason): with registration closed an author is linked, never given a registration.
 */
const ASKS_THE_RULE = /from "@\/lib\/(registration-closure|registration-closure-server|presenter-signup)"/;

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
    expect(READS_THE_SWITCH.test('if (settings["registrationOpen"] === false) {')).toBe(true);
    expect(READS_THE_SWITCH.test("const { registrationOpen } = eventSettings;")).toBe(true);
    expect(READS_THE_SWITCH.test("registrationOpen: event.registrationOpen !== false,")).toBe(false);
  });
});

describe("every public door that creates a registration asks the rule", () => {
  it("each file under the public API that creates one imports the rule (or presenter-signup, which asks it)", () => {
    const publicDirs = [join(SRC, "app", "api", "public"), join(SRC, "app", "e")];
    const doors = publicDirs.flatMap(sourceFiles).filter((path) => CREATES_A_REGISTRATION.test(readFileSync(path, "utf8")));
    // The four known doors: a new one must show up here, so a vanished match is noticed too.
    expect(doors.length).toBeGreaterThanOrEqual(4);
    const missing = doors
      .filter((path) => !ASKS_THE_RULE.test(readFileSync(path, "utf8")))
      .map((path) => relative(ROOT, path).split("\\").join("/"));
    expect(missing).toEqual([]);
  });
});
