import { describe, expect, it } from "vitest";
import {
  newSessionRoleKey,
  readSessionRoles,
  resolveSessionRoleKey,
  runsSession,
  sessionRoleKeyOf,
  sessionRoleLabel,
} from "@/lib/session-roles";
import { planSessionRoles, type SessionRoleInput } from "@/services/session-role-service";

const keys = (roles: { key: string }[]) => roles.map((r) => r.key);

describe("readSessionRoles", () => {
  it("is the four built-ins, in the picker's order, until the organisation changes it", () => {
    expect(keys(readSessionRoles({}))).toEqual(["MODERATOR", "CHAIRPERSON", "PANELIST", "SPEAKER"]);
    expect(keys(readSessionRoles(null))).toEqual(["MODERATOR", "CHAIRPERSON", "PANELIST", "SPEAKER"]);
  });

  it("keeps the stored order, names and hiding; a built-in keeps its own duty", () => {
    const roles = readSessionRoles({
      sessionRoles: [
        { key: "host", label: "Host", duty: "RUNS" },
        { key: "SPEAKER", label: "Presenter", duty: "RUNS" },
        { key: "PANELIST", label: "Panelist", hidden: true },
        { key: "MODERATOR", label: "" },
        { key: "CHAIRPERSON" },
      ],
    });
    expect(keys(roles)).toEqual(["host", "SPEAKER", "PANELIST", "MODERATOR", "CHAIRPERSON"]);
    expect(roles[0]).toEqual({ key: "host", label: "Host", duty: "RUNS", builtIn: false, hidden: false });
    expect(roles[1]).toMatchObject({ label: "Presenter", duty: "PRESENTS", builtIn: true });
    expect(roles[2].hidden).toBe(true);
    expect(roles[3].label).toBe("Moderator"); // an empty name falls back
  });

  it("never loses a built-in, and drops what it cannot read", () => {
    const roles = readSessionRoles({
      sessionRoles: [
        { key: "keynote", label: "Keynote", duty: "PRESENTS" },
        { key: "keynote", label: "Twice", duty: "PRESENTS" },
        { key: "mc", label: "MC", duty: "SOMETIMES" },
        { key: "", label: "Nobody", duty: "RUNS" },
        "junk",
      ],
    });
    expect(keys(roles)).toEqual(["keynote", "MODERATOR", "CHAIRPERSON", "PANELIST", "SPEAKER"]);
  });
});

describe("an assignment's role", () => {
  const roles = readSessionRoles({
    sessionRoles: [
      { key: "host", label: "Host", duty: "RUNS" },
      { key: "keynote", label: "Keynote", duty: "PRESENTS" },
      { key: "CHAIRPERSON", label: "Chair" },
    ],
  });

  it("an added role stores its duty's built-in, so the email rule answers for it", () => {
    expect(resolveSessionRoleKey("host", roles)).toEqual({ role: "MODERATOR", customRoleKey: "host" });
    expect(resolveSessionRoleKey("keynote", roles)).toEqual({ role: "SPEAKER", customRoleKey: "keynote" });
    expect(runsSession(resolveSessionRoleKey("host", roles)!.role)).toBe(true);
    expect(resolveSessionRoleKey("CHAIRPERSON", roles)).toEqual({ role: "CHAIRPERSON", customRoleKey: null });
    expect(resolveSessionRoleKey("mc", roles)).toBeNull();
  });

  it("shows the organisation's names, and falls back to the built-in for a key no longer listed", () => {
    expect(sessionRoleLabel({ role: "MODERATOR", customRoleKey: "host" }, roles)).toBe("Host");
    expect(sessionRoleLabel({ role: "CHAIRPERSON" }, roles)).toBe("Chair");
    expect(sessionRoleLabel({ role: "MODERATOR", customRoleKey: "gone" }, roles)).toBe("Moderator");
    expect(sessionRoleKeyOf({ role: "SPEAKER", customRoleKey: "keynote" })).toBe("keynote");
    expect(sessionRoleKeyOf({ role: "SPEAKER", customRoleKey: null })).toBe("SPEAKER");
  });

  it("a new role's key is its name, never a built-in's or one already taken", () => {
    expect(newSessionRoleKey("Host", [])).toBe("host");
    expect(newSessionRoleKey("Speaker", ["SPEAKER"])).toBe("speaker-2");
    expect(newSessionRoleKey("Host", ["host", "host-2"])).toBe("host-3");
    expect(newSessionRoleKey("!!!", [])).toBe("role");
  });
});

describe("planSessionRoles", () => {
  const current = readSessionRoles({
    sessionRoles: [{ key: "host", label: "Host", duty: "RUNS" }, { key: "MODERATOR" }, { key: "CHAIRPERSON" }, { key: "PANELIST" }, { key: "SPEAKER" }],
  });
  const asInput = (extra: SessionRoleInput[] = []): SessionRoleInput[] => [
    ...current.map((r) => ({ key: r.key, label: r.label, duty: r.duty, hidden: r.hidden })),
    ...extra,
  ];
  const none = new Map<string, number>();

  it("adds, renames, hides and reorders", () => {
    const input = asInput([{ label: "Keynote", duty: "PRESENTS" }]).reverse();
    input.find((r) => r.key === "CHAIRPERSON")!.label = "Chair";
    input.find((r) => r.key === "PANELIST")!.hidden = true;
    const plan = planSessionRoles(current, input, none);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(keys(plan.next)[0]).toBe("keynote");
    expect(plan.next.find((r) => r.key === "CHAIRPERSON")?.label).toBe("Chair");
    expect(plan.next.find((r) => r.key === "PANELIST")?.hidden).toBe(true);
  });

  it("never removes a built-in or changes its duty", () => {
    const withoutPanelist = asInput().filter((r) => r.key !== "PANELIST");
    const removed = planSessionRoles(current, withoutPanelist, none);
    expect(!removed.ok && removed.result.ok === false && removed.result.code).toBe("BUILT_IN_REQUIRED");
    const flipped = asInput().map((r) => (r.key === "SPEAKER" ? { ...r, duty: "RUNS" as const } : r));
    const dutyPlan = planSessionRoles(current, flipped, none);
    expect(!dutyPlan.ok && dutyPlan.result.ok === false && dutyPlan.result.code).toBe("BUILT_IN_DUTY_FIXED");
  });

  it("an added role nobody holds may be deleted or change its duty; a held one may only be hidden", () => {
    const deleted = asInput().filter((r) => r.key !== "host");
    expect(planSessionRoles(current, deleted, none).ok).toBe(true);
    const held = new Map([["host", 3]]);
    const refused = planSessionRoles(current, deleted, held);
    expect(!refused.ok && refused.result.ok === false && refused.result.code).toBe("ROLE_IN_USE");
    expect(!refused.ok && refused.result.ok === false && refused.result.inUse).toEqual([
      { key: "host", label: "Host", assignments: 3 },
    ]);
    const flipped = asInput().map((r) => (r.key === "host" ? { ...r, duty: "PRESENTS" as const } : r));
    expect(planSessionRoles(current, flipped, none).ok).toBe(true);
    const flippedHeld = planSessionRoles(current, flipped, held);
    expect(!flippedHeld.ok && flippedHeld.result.ok === false && flippedHeld.result.code).toBe("ROLE_IN_USE");
    const hidden = asInput().map((r) => (r.key === "host" ? { ...r, hidden: true } : r));
    expect(planSessionRoles(current, hidden, held).ok).toBe(true);
  });

  it("refuses two roles with one name, a blank name, and a key it does not know", () => {
    const dup = planSessionRoles(current, asInput([{ label: "host", duty: "RUNS" }]), none);
    expect(!dup.ok && dup.result.ok === false && dup.result.code).toBe("DUPLICATE_LABEL");
    const blank = planSessionRoles(current, asInput([{ label: "  ", duty: "RUNS" }]), none);
    expect(!blank.ok && blank.result.ok === false && blank.result.code).toBe("INVALID_LABEL");
    const stranger = planSessionRoles(current, asInput([{ key: "ghost", label: "Ghost", duty: "RUNS" }]), none);
    expect(!stranger.ok && stranger.result.ok === false && stranger.result.code).toBe("UNKNOWN_ROLE");
  });

  it("never hands a new role the key of one somebody still holds", () => {
    const plan = planSessionRoles(current, asInput([{ label: "Keynote", duty: "PRESENTS" }]), new Map([["keynote", 1]]));
    expect(plan.ok && plan.next.find((r) => r.label === "Keynote")?.key).toBe("keynote-2");
  });
});
