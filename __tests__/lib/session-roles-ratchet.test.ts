import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUILT_IN_ROLE_DUTY, roleDuty, RUNNING_BUILT_IN_ROLES, runsSession } from "@/lib/session-roles";

/**
 * What a session role DOES is asked of `src/lib/session-roles.ts` (Nov 18,
 * 2026; docs/SESSION_ROLES_PLAN.md). Before it, the two email blocks and the
 * preview each wrote "Moderator or Chairperson" themselves, which a role an
 * organisation adds (a Host that runs a session) could never satisfy.
 *
 * Every file that names "MODERATOR" or "CHAIRPERSON" is listed here with why
 * it may. A new file fails until it is either routed through `runsSession`
 * or added with its reason.
 */
const ALLOWED: Record<string, string> = {
  "src/lib/session-roles.ts": "the rule itself",
  "src/lib/session-enums.ts": "labels, colours and the picker order of the four built-ins",
  "src/services/session-service.ts": "the list of values the service accepts",
  "src/app/(dashboard)/events/[eventId]/communications/page.tsx":
    "the Brief Moderators and Brief Chairpersons tiles name their one role, matched through matchesSessionRoleFilter",
  "src/app/api/events/[eventId]/import/sessions/route.ts": "the CSV columns moderatorEmails and chairEmails name their role",
  "src/lib/agent/register-mcp-tools.ts": "the agent's role parameter lists the four values (plan step 6)",
  "src/lib/openapi-spec.ts": "the public API reference lists the four values",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("session role duty", () => {
  it("is decided in one place: no other file names the running roles", () => {
    const root = process.cwd();
    const naming = walk(path.join(root, "src"))
      .filter((f) => /"(MODERATOR|CHAIRPERSON)"/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(root, f).split(path.sep).join("/"))
      .sort();
    expect(naming.filter((f) => !(f in ALLOWED))).toEqual([]);
    // A listed file that no longer names them should leave the list.
    expect(Object.keys(ALLOWED).filter((f) => !naming.includes(f))).toEqual([]);
  });

  it("Moderator and Chairperson run; Speaker and Panelist present", () => {
    expect(BUILT_IN_ROLE_DUTY).toEqual({
      SPEAKER: "PRESENTS",
      MODERATOR: "RUNS",
      CHAIRPERSON: "RUNS",
      PANELIST: "PRESENTS",
    });
    expect(RUNNING_BUILT_IN_ROLES).toEqual(["MODERATOR", "CHAIRPERSON"]);
    expect(runsSession("MODERATOR")).toBe(true);
    expect(runsSession("SPEAKER")).toBe(false);
  });

  it("an unknown role presents, so the person never drops out of both email blocks", () => {
    expect(roleDuty("HOST")).toBe("PRESENTS");
    expect(roleDuty(null)).toBe("PRESENTS");
    expect(roleDuty("toString")).toBe("PRESENTS");
  });
});
