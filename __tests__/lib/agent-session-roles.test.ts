import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The agent names a session role by its code or by the organisation's name
 * for it (Nov 18, 2026; docs/SESSION_ROLES_PLAN.md step 6), and an unknown
 * name is refused with the organisation's names instead of becoming a
 * Speaker without a word.
 */

const { mockAdd, mockReplace, mockGetRoles } = vi.hoisted(() => ({
  mockAdd: vi.fn(),
  mockReplace: vi.fn(),
  mockGetRoles: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/services/session-service", () => ({
  addSessionSpeaker: (...a: unknown[]) => mockAdd(...a),
  replaceSessionRoster: (...a: unknown[]) => mockReplace(...a),
  removeSessionSpeaker: vi.fn(),
  appendSessionTopics: vi.fn(),
  createSession: vi.fn(),
  updateSession: vi.fn(),
}));
vi.mock("@/services/session-role-service", async () => {
  const { readSessionRoles } = await import("@/lib/session-roles");
  return {
    getSessionRoles: (...a: unknown[]) => mockGetRoles(...a),
    getSessionRolesForDisplay: async () => readSessionRoles({}),
  };
});

import { SESSION_EXECUTORS } from "@/lib/agent/tools/sessions";
import { readSessionRoles } from "@/lib/session-roles";

const ctx = { eventId: "ev1", userId: "u1", organizationId: "org1", source: "mcp" } as never;
const ROLES = readSessionRoles({
  sessionRoles: [
    { key: "host", label: "Host", duty: "RUNS" },
    { key: "CHAIRPERSON", label: "Chair" },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRoles.mockResolvedValue(ROLES);
  mockAdd.mockResolvedValue({ ok: true, sessionSpeaker: {}, alreadyAssigned: false, roleChanged: false });
  mockReplace.mockResolvedValue({ ok: true, before: [], after: [], topicRowsRemoved: 0 });
});

describe("the agent's session roles", () => {
  it("takes an added role by its name and stores its duty's built-in plus its key", async () => {
    await SESSION_EXECUTORS.add_speaker_to_session({ sessionId: "s1", speakerId: "sp1", role: "host" }, ctx);
    expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({ role: "MODERATOR", customRoleKey: "host" }));
    await SESSION_EXECUTORS.add_speaker_to_session({ sessionId: "s1", speakerId: "sp1", role: "Chair" }, ctx);
    expect(mockAdd).toHaveBeenLastCalledWith(expect.objectContaining({ role: "CHAIRPERSON", customRoleKey: null }));
  });

  it("reads no list for a built-in code, in any case, or no role at all", async () => {
    await SESSION_EXECUTORS.add_speaker_to_session({ sessionId: "s1", speakerId: "sp1", role: "moderator" }, ctx);
    await SESSION_EXECUTORS.add_speaker_to_session({ sessionId: "s1", speakerId: "sp1" }, ctx);
    expect(mockGetRoles).not.toHaveBeenCalled();
    expect(mockAdd.mock.calls.map(([a]) => (a as { role: string }).role)).toEqual(["MODERATOR", "SPEAKER"]);
  });

  it("refuses a name that is not the organisation's, saying which are", async () => {
    const res = (await SESSION_EXECUTORS.add_speaker_to_session({ sessionId: "s1", speakerId: "sp1", role: "MC" }, ctx)) as {
      code?: string;
      error?: string;
    };
    expect(res.code).toBe("INVALID_ROLE");
    expect(res.error).toContain("Host");
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("replace_session_speakers resolves every assignment before writing any", async () => {
    await SESSION_EXECUTORS.replace_session_speakers(
      { sessionId: "s1", assignments: [{ speakerId: "sp1", role: "Host" }, { speakerId: "sp2" }] },
      ctx,
    );
    expect(mockReplace).toHaveBeenCalledWith(
      expect.objectContaining({
        assignments: [
          { speakerId: "sp1", role: "MODERATOR", customRoleKey: "host" },
          { speakerId: "sp2", role: "SPEAKER", customRoleKey: null },
        ],
      }),
    );
    const bad = (await SESSION_EXECUTORS.replace_session_speakers(
      { sessionId: "s1", assignments: [{ speakerId: "sp1", role: "MC" }] },
      ctx,
    )) as { code?: string };
    expect(bad.code).toBe("INVALID_ROLE");
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });
});
