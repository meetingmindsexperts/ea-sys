// The floating AI Agent button's rule: who sees it, where it goes, and the
// pages it stays off. A pure function over (pathname, role), so a new door
// surface or a widened role list fails here rather than in a browser.

import { describe, expect, it } from "vitest";
import { agentLauncherHref } from "@/lib/agent/launcher";
import { AGENT_ROLES } from "@/lib/agent/agent-roles";

describe("agentLauncherHref", () => {
  it("renders for exactly the roles the agent admits", () => {
    for (const role of AGENT_ROLES) expect(agentLauncherHref("/dashboard", role)).toBe("/agent");
    for (const role of ["ONSITE", "WEBINARS", "CRM_USER", "HR_USER", "REVIEWER", "SUBMITTER", "REGISTRANT", undefined, null]) {
      expect(agentLauncherHref("/dashboard", role)).toBeNull();
    }
  });

  it("opens the organisation-wide agent from pages outside an event", () => {
    expect(agentLauncherHref("/dashboard", "ADMIN")).toBe("/agent");
    expect(agentLauncherHref("/events", "ADMIN")).toBe("/agent");
    expect(agentLauncherHref("/settings", "ORGANIZER")).toBe("/agent");
    expect(agentLauncherHref("/contacts", "MEMBER")).toBe("/agent");
    expect(agentLauncherHref("/events/new", "ADMIN")).toBe("/agent");
  });

  it("carries the current event to that event's agent page", () => {
    expect(agentLauncherHref("/events/ev_1", "ADMIN")).toBe("/events/ev_1/agent");
    expect(agentLauncherHref("/events/ev_1/registrations", "ADMIN")).toBe("/events/ev_1/agent");
    expect(agentLauncherHref("/events/ev_1/speakers/sp_9", "ORGANIZER")).toBe("/events/ev_1/agent");
    expect(agentLauncherHref("/events/ev_1/registrations?status=PAID", "ADMIN")).toBe("/events/ev_1/agent");
  });

  it("stays off the agent pages themselves", () => {
    expect(agentLauncherHref("/agent", "ADMIN")).toBeNull();
    expect(agentLauncherHref("/agent?event=ev_1", "ADMIN")).toBeNull();
    expect(agentLauncherHref("/events/ev_1/agent", "ADMIN")).toBeNull();
  });

  it("stays off the door surfaces: the scanner and the kiosk", () => {
    expect(agentLauncherHref("/events/ev_1/check-in", "ADMIN")).toBeNull();
    expect(agentLauncherHref("/events/ev_1/check-in/kiosk", "ADMIN")).toBeNull();
  });

  it("stays off the log viewer, which owns that corner", () => {
    expect(agentLauncherHref("/logs", "SUPER_ADMIN")).toBeNull();
  });

  it("does not mistake a look-alike path for a hidden one", () => {
    expect(agentLauncherHref("/agents", "ADMIN")).toBe("/agent");
    expect(agentLauncherHref("/events/ev_1/check-ins", "ADMIN")).toBe("/events/ev_1/agent");
  });
});
