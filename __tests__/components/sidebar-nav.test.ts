/**
 * What the sidebar shows, for every role and context: the safety net for
 * custom roles Phase 3. Recorded on the role-based logic (Oct 5, 2026); moving
 * `computeSidebarNav` onto `can()` must leave it byte for byte unchanged
 * except where a change is intended and reviewed.
 *
 * Re-record ONLY when a change is intended: `npx vitest run
 * __tests__/components/sidebar-nav.test.ts -u`, then read the diff.
 */
import { describe, it, expect } from "vitest";
import { computeSidebarNav, type SidebarNavInput } from "@/components/layout/sidebar-nav";

const ROLES = ["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER", "ONSITE", "WEBINARS", "CRM_USER", "HR_USER", "REVIEWER", "SUBMITTER", "REGISTRANT"];

/** Person variants that change what a role sees. */
const PEOPLE: { label: string; extra: Record<string, unknown> }[] = [
  { label: "plain", extra: {} },
  { label: "hrAccess", extra: { hrAccess: true } },
  { label: "procurementRequest", extra: { procurementRequest: true } },
  { label: "customKey", extra: { procurementPermissions: ["procurement.budgets.view"] } },
];

const CONTEXTS: { label: string; input: Pick<SidebarNavInput, "isEventPage" | "currentEvent" | "submitterCtx"> }[] = [
  { label: "org page", input: { isEventPage: false, currentEvent: undefined, submitterCtx: undefined } },
  { label: "event loading", input: { isEventPage: true, currentEvent: undefined, submitterCtx: undefined } },
  { label: "conference", input: { isEventPage: true, currentEvent: { eventType: "CONFERENCE" }, submitterCtx: { submitterSource: "ABSTRACT", abstractCount: 1, proposalCount: 0 } } },
  { label: "webinar", input: { isEventPage: true, currentEvent: { eventType: "WEBINAR" }, submitterCtx: { submitterSource: "PROPOSAL", abstractCount: 0, proposalCount: 1 } } },
  { label: "hybrid", input: { isEventPage: true, currentEvent: { eventType: "HYBRID" }, submitterCtx: null } },
];

const FLAGS = [
  { label: "modules on", hrEnabled: true, procurementEnabled: true },
  { label: "modules off", hrEnabled: false, procurementEnabled: false },
];

function render(): string {
  const lines: string[] = [];
  for (const flags of FLAGS)
    for (const role of ROLES)
      for (const person of PEOPLE)
        for (const ctx of CONTEXTS) {
          const nav = computeSidebarNav({
            user: { id: "u1", organizationId: "org-1", role, ...person.extra },
            hrEnabled: flags.hrEnabled,
            procurementEnabled: flags.procurementEnabled,
            ...ctx.input,
          });
          const base = nav.baseNavigation.map((i) => i.name).join(", ");
          const event = nav.visibleEventSections.map((s) => `${s.label || "-"}: ${s.items.map((i) => i.name).join(", ")}`).join(" | ");
          lines.push(`${flags.label} · ${role} · ${person.label} · ${ctx.label}${nav.hidden ? " => HIDDEN" : ` => [${base}] {${event}}`}`);
        }
  return lines.join("\n") + "\n";
}

describe("sidebar navigation for every role and context", () => {
  it("matches the recorded snapshot", async () => {
    await expect(render()).toMatchFileSnapshot("./__snapshots__/sidebar-nav.txt");
  });
});
