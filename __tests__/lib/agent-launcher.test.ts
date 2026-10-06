// The floating AI Agent button's rule: who sees it, where it goes, and the
// pages it stays off. A pure function over (pathname, may use the agent); who
// may is `agent.use` (custom roles Phase 6), pinned against the old list below.

import { describe, expect, it } from "vitest";
import { agentLauncherHref } from "@/lib/agent/launcher";
import { AGENT_ROLES } from "@/lib/agent/agent-roles";
import { can, principalFromUser } from "@/lib/permissions/can";

const mayUse = (role: string | null | undefined) => can(principalFromUser({ id: "u", role, organizationId: "o" }), "agent.use");

describe("agentLauncherHref", () => {
  it("renders for exactly the roles the agent admits", () => {
    for (const role of AGENT_ROLES) expect(agentLauncherHref("/dashboard", mayUse(role))).toBe("/agent");
    for (const role of ["ONSITE", "WEBINARS", "CRM_USER", "HR_USER", "REVIEWER", "SUBMITTER", "REGISTRANT", undefined, null]) {
      expect(agentLauncherHref("/dashboard", mayUse(role))).toBeNull();
    }
  });

  it("opens the organisation-wide agent from pages outside an event", () => {
    expect(agentLauncherHref("/dashboard", true)).toBe("/agent");
    expect(agentLauncherHref("/events", true)).toBe("/agent");
    expect(agentLauncherHref("/settings", true)).toBe("/agent");
    expect(agentLauncherHref("/contacts", true)).toBe("/agent");
    expect(agentLauncherHref("/events/new", true)).toBe("/agent");
  });

  it("carries the current event to that event's agent page", () => {
    expect(agentLauncherHref("/events/ev_1", true)).toBe("/events/ev_1/agent");
    expect(agentLauncherHref("/events/ev_1/registrations", true)).toBe("/events/ev_1/agent");
    expect(agentLauncherHref("/events/ev_1/speakers/sp_9", true)).toBe("/events/ev_1/agent");
    expect(agentLauncherHref("/events/ev_1/registrations?status=PAID", true)).toBe("/events/ev_1/agent");
  });

  it("stays off the agent pages themselves", () => {
    expect(agentLauncherHref("/agent", true)).toBeNull();
    expect(agentLauncherHref("/agent?event=ev_1", true)).toBeNull();
    expect(agentLauncherHref("/events/ev_1/agent", true)).toBeNull();
  });

  it("stays off the door surfaces: the scanner and the kiosk", () => {
    expect(agentLauncherHref("/events/ev_1/check-in", true)).toBeNull();
    expect(agentLauncherHref("/events/ev_1/check-in/kiosk", true)).toBeNull();
  });

  it("stays off the log viewer, which owns that corner", () => {
    expect(agentLauncherHref("/logs", true)).toBeNull();
  });

  it("does not mistake a look-alike path for a hidden one", () => {
    expect(agentLauncherHref("/agents", true)).toBe("/agent");
    expect(agentLauncherHref("/events/ev_1/check-ins", true)).toBe("/events/ev_1/agent");
  });
});
