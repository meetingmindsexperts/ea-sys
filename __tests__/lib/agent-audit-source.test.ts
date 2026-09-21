/**
 * Every executor stamps the door it was reached through onto the audit
 * trail via ctx.source (agent readiness gap G5). Before this the literal
 * "mcp" was hardcoded 65 times across the tool files, so an action taken
 * by a signed-in person through the in-app Event Agent was recorded as an
 * MCP client's. Two guards: the source files carry no such literal, and an
 * executor passes the context's source through to its service.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const { mockCreateSpeaker } = vi.hoisted(() => ({ mockCreateSpeaker: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: {}, dbOperator: {} }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/services/speaker-service", () => ({
  createSpeaker: mockCreateSpeaker,
  updateSpeaker: vi.fn(),
}));

import { SPEAKER_EXECUTORS } from "@/lib/agent/tools/speakers";
import type { AgentContext } from "@/lib/agent/tools/_shared";

const TOOLS_DIR = path.join(process.cwd(), "src/lib/agent/tools");

describe("audit source comes from the context", () => {
  it("no tool file hardcodes a door", () => {
    const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const src = readFileSync(path.join(TOOLS_DIR, f), "utf8");
      expect(src, `${f} stamps a literal door`).not.toMatch(/source:\s*"(mcp|agent)"/);
    }
  });

  it("the in-app route stamps source agent and the MCP door stamps mcp", () => {
    const route = readFileSync(
      path.join(process.cwd(), "src/app/api/events/[eventId]/agent/execute/route.ts"),
      "utf8",
    );
    expect(route).toMatch(/source:\s*"agent"/);
    const mcp = readFileSync(path.join(process.cwd(), "src/lib/agent/register-mcp-tools.ts"), "utf8");
    expect(mcp).toMatch(/source:\s*"mcp"/);
    expect(mcp).not.toMatch(/source:\s*"agent"/);
  });

  describe("create_speaker passes ctx.source to the service", () => {
    beforeEach(() => {
      mockCreateSpeaker.mockReset();
      mockCreateSpeaker.mockResolvedValue({
        ok: true,
        speaker: { id: "spk1", email: "a@b.co", firstName: "Ada", lastName: "L", status: "INVITED" },
      });
    });

    const ctx = (source: AgentContext["source"]): AgentContext => ({
      eventId: "ev1",
      organizationId: "org1",
      userId: "u1",
      source,
      counters: { creates: 0, emailsSent: 0 },
    });

    for (const source of ["agent", "mcp"] as const) {
      it(`records "${source}"`, async () => {
        await SPEAKER_EXECUTORS.create_speaker(
          { email: "a@b.co", firstName: "Ada", lastName: "L" },
          ctx(source),
        );
        expect(mockCreateSpeaker).toHaveBeenCalledTimes(1);
        expect(mockCreateSpeaker.mock.calls[0][0]).toMatchObject({ source, userId: "u1" });
      });
    }
  });
});
