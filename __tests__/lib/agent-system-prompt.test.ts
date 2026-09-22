/**
 * The Event Agent's prompt is org-level with an optional event. With no
 * event it tells the model how to find one; with one it names the id the
 * event tools take. Both branches are pure and pinned here.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    organization: { findUnique: vi.fn(async () => ({ name: "MM <Group>" })) },
    event: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "ev1"
          ? {
              id: "ev1",
              name: "Gulf Summit",
              status: "PUBLISHED",
              startDate: new Date("2027-03-12T05:00:00Z"),
              endDate: new Date("2027-03-14T05:00:00Z"),
              venue: "Hall A",
              city: "Dubai",
              country: "UAE",
              specialty: null,
              eventType: "CONFERENCE",
              _count: { registrations: 3, speakers: 2, eventSessions: 1, tracks: 0 },
            }
          : null,
      ),
    },
  },
  dbOperator: {},
}));

import { buildEventContextSection, buildSystemPrompt } from "@/lib/agent/system-prompt";

const tools = [
  { name: "list_events", description: "", input_schema: { type: "object" as const } },
  { name: "create_event", description: "", input_schema: { type: "object" as const } },
];

describe("buildEventContextSection", () => {
  it("tells the model how to find an event when none is selected", () => {
    const s = buildEventContextSection(null);
    expect(s).toContain("## No event selected");
    expect(s).toContain("list_events or search_event");
    expect(s).toMatch(/ask which one before writing/);
  });

  it("names the id every event tool takes when an event is selected", () => {
    const s = buildEventContextSection({
      id: "ev1",
      name: "Gulf Summit",
      status: "PUBLISHED",
      eventType: "CONFERENCE",
      startDate: new Date("2027-03-12T05:00:00Z"),
      endDate: null,
      venue: "Hall A, Dubai",
      specialty: null,
      counts: { registrations: 3, speakers: 2, eventSessions: 1, tracks: 0 },
    });
    expect(s).toContain("## Current event");
    expect(s).toContain("Event ID: ev1 (pass this as eventId");
    expect(s).toContain("March 12, 2027 to TBD");
    expect(s).toContain("Registrations: 3");
  });
});

describe("buildSystemPrompt", () => {
  it("is org-level without an event and carries the generated capabilities", async () => {
    const p = await buildSystemPrompt({ organizationId: "org1", eventId: null, readOnly: false, tools });
    expect(p).toContain("assistant for MM <Group>");
    expect(p).toContain("## No event selected");
    expect(p).toContain("**Write (1):** create_event");
    expect(p).toContain("### Creating an event");
    expect(p).toContain("### Finding an event");
    // The tracks example must show the look-before-create step: the golden
    // task set (Sep 22, 2026) caught the model copying an example that
    // skipped it, against guideline 1.
    expect(p).toContain("### Setting up tracks and sessions");
    const example = p.slice(p.indexOf("### Setting up tracks and sessions"));
    expect(example.indexOf("Call list_tracks")).toBeGreaterThan(-1);
    expect(example.indexOf("Call list_tracks")).toBeLessThan(example.indexOf("Call create_track"));
    expect(p).not.toContain("READ-ONLY SESSION");
    // The prompt's own note on upsert_sponsors said "replaces the entire
    // array" while the executor has merged by default since Sep 2, 2026.
    expect(p).toContain("upsert_sponsors merges by default");
    expect(p).not.toContain("replaces the entire sponsor array");
    // The sponsor EXAMPLE still said "replaces the entire array" after the
    // note was corrected (found in the E3 red-team round, Sep 22, 2026).
    expect(p).not.toContain("replaces the entire array");
    const sponsorExample = p.slice(p.indexOf("### Adding a sponsor"));
    expect(sponsorExample).toContain("merges by default");
  });

  it("carries the dashboard map, with the event's id filled in when one is selected", async () => {
    // Asked "where can I find those drafts?", the agent invented sidebar
    // names (Sep 22, 2026); the map is where it reads the real ones from.
    const withEvent = await buildSystemPrompt({ organizationId: "org1", eventId: "ev1", readOnly: false, tools });
    expect(withEvent).toContain("## Where things are in the dashboard");
    expect(withEvent).toContain("Communications, Email Templates");
    expect(withEvent).toContain("/events/ev1/communications/templates");
    const without = await buildSystemPrompt({ organizationId: "org1", eventId: null, readOnly: false, tools });
    expect(without).toContain("/events/{eventId}/communications/templates");
  });

  it("tells the model the approval card is the single confirmation, never a prose question first", async () => {
    // The Sep 22, 2026 smoke pass: the model asked "shall I proceed?" in
    // prose and only then called the tool that raises the card, so the
    // person confirmed twice. Guideline 3 used to ask for exactly that.
    const p = await buildSystemPrompt({ organizationId: "org1", eventId: null, readOnly: false, tools });
    expect(p).toContain("Do not ask for permission in prose first");
    expect(p).not.toContain("wait for their go-ahead");
    // The reminder EXAMPLE still told the model to ask "Shall I send them
    // the reminder?" and stop, the exact double confirmation guideline 3
    // forbids (found in the E3 red-team round, Sep 22, 2026).
    expect(p).not.toContain("Shall I send them the reminder?");
    expect(p).not.toContain("Only after the user says yes");
    const example = p.slice(p.indexOf("### Sending a reminder email"), p.indexOf("### Adding a sponsor"));
    expect(example).toContain("call send_bulk_email");
    expect(example).toContain("APPROVAL_REQUIRED");
  });

  it("names the two red-team rules: a name matching two people is a question, a bulk send never swaps its audience", async () => {
    // E3 round, Sep 22, 2026: asked to email an outside address, the model
    // said the tool could not and raised a card for every registrant
    // instead; asked about one of two speakers with one name, the fix is
    // a question, never a guess.
    const p = await buildSystemPrompt({ organizationId: "org1", eventId: "ev1", readOnly: false, tools });
    expect(p).toContain("ask which one before writing; never pick one");
    expect(p).toContain("never send to a different audience instead");
    expect(p).toContain("cannot email one person or an address outside the event");
  });

  it("carries the current event when one is selected, and the read-only banner for MEMBER", async () => {
    const p = await buildSystemPrompt({ organizationId: "org1", eventId: "ev1", readOnly: true, tools });
    expect(p).toContain("## Current event");
    expect(p).toContain("Event ID: ev1");
    expect(p).toContain("Hall A, Dubai, UAE");
    expect(p).toContain("READ-ONLY SESSION");
  });

  it("falls back to the org-level section when the event is not this org's", async () => {
    const p = await buildSystemPrompt({ organizationId: "org1", eventId: "foreign", readOnly: false, tools });
    expect(p).toContain("## No event selected");
  });
});
