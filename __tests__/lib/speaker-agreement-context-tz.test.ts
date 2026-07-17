/**
 * buildSpeakerEmailContext — event-timezone rendering of {sessionDateTime}
 * (review M10, July 16 2026). The merge field lands inside the personalized
 * agreement document, so it must show the EVENT's clock, not the Dubai-fixed
 * formatDateTime it used before (nor the server's UTC clock).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    speaker: { findFirst: vi.fn() },
    event: { findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { buildSpeakerEmailContext } from "@/lib/speaker-agreement";

// 2026-03-05 14:00 UTC = 09:00 in New York (EST, GMT-5) = 18:00 in Dubai.
const SESSION_START = new Date("2026-03-05T14:00:00Z");

function speakerRow() {
  return {
    title: "DR",
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@x.com",
    jobTitle: null,
    organization: null,
    country: null,
    sessions: [
      {
        role: "SPEAKER",
        session: {
          name: "Opening Keynote",
          startTime: SESSION_START,
          endTime: new Date("2026-03-05T15:00:00Z"),
          location: null as string | null,
          track: null,
          topics: [] as unknown[],
        },
      },
    ],
    topicSpeakers: [],
  };
}

function moderatedSession(topics: unknown[] = []) {
  return {
    role: "MODERATOR",
    session: {
      name: "Structural Heart Panel",
      // 16:00–17:30 UTC = 11:00 AM – 12:30 PM in New York.
      startTime: new Date("2026-03-05T16:00:00Z"),
      endTime: new Date("2026-03-05T17:30:00Z"),
      location: "Hall B",
      track: null,
      topics,
    },
  };
}

function eventRow(timezone: string | null) {
  return {
    name: "Cardio Summit",
    slug: "cardio",
    startDate: new Date("2026-03-05T00:00:00Z"),
    endDate: new Date("2026-03-06T00:00:00Z"),
    timezone,
    venue: null,
    address: null,
    city: null,
    organization: { name: "MMG" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.speaker.findFirst.mockResolvedValue(speakerRow());
});

describe("buildSpeakerEmailContext — {sessionDateTime} in the event's timezone", () => {
  it("renders a New York event's session in the New York clock, labelled", async () => {
    mockDb.event.findFirst.mockResolvedValue(eventRow("America/New_York"));
    const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
    expect(ctx?.sessionDateTime).toContain("9:00 AM");
    expect(ctx?.sessionDateTime).toContain("EST");
    expect(ctx?.sessionDateTime).not.toContain("GST");
  });

  it("defaults a timezone-less event to Dubai (GMT+4), preserving legacy output", async () => {
    mockDb.event.findFirst.mockResolvedValue(eventRow(null));
    const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
    expect(ctx?.sessionDateTime).toContain("6:00 PM");
    expect(ctx?.sessionDateTime).toContain("GMT+4");
  });

  it("presentationDetails carries date / time / duration as THREE separate lines, no Role row", async () => {
    mockDb.event.findFirst.mockResolvedValue(eventRow("America/New_York"));
    const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
    // 14:00–15:00 UTC = 9:00–10:00 AM in New York, a 1-hour session —
    // date <br/> time <br/> duration (owner request: never one combined line).
    expect(ctx?.presentationDetails).toContain("Mar 5, 2026<br/>9:00 AM – 10:00 AM EST<br/>1h");
    expect(ctx?.presentationDetailsText).toContain("9:00 AM – 10:00 AM");
    // Separate moderator/speaker sends — the block never displays the role.
    expect(ctx?.presentationDetails).not.toContain(">Role<");
  });

  it("keeps the {sessionDateTime} docx token format-stable (start time only)", async () => {
    // The merge token lands inside the personalized agreement DOCUMENT —
    // the email block enrichment must not change its shape.
    mockDb.event.findFirst.mockResolvedValue(eventRow("America/New_York"));
    const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
    expect(ctx?.sessionDateTime).toContain("9:00 AM");
    expect(ctx?.sessionDateTime).not.toContain("–");
    expect(ctx?.sessionDateTime).not.toContain("(1h)");
  });

  it("renders one Date & Time line per session for a multi-session speaker", async () => {
    const row = speakerRow();
    row.sessions.push(moderatedSession());
    mockDb.speaker.findFirst.mockResolvedValue(row);
    mockDb.event.findFirst.mockResolvedValue(eventRow("America/New_York"));
    const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
    expect(ctx?.presentationDetails).toContain("9:00 AM – 10:00 AM");
    expect(ctx?.presentationDetails).toContain("11:00 AM – 12:30 PM");
    expect(ctx?.presentationDetails).toContain("1h 30m");
  });
});

describe("buildSpeakerEmailContext — {{moderatorDetails}} run-sheet", () => {
  const TOPICS = [
    {
      title: "TAVR Outcomes",
      duration: 20,
      speakers: [{ speaker: { title: "DR", firstName: "Jane", lastName: "Doe" } }],
    },
    {
      title: "Mitral Repair Debate",
      duration: 45,
      speakers: [
        { speaker: { title: "PROF", firstName: "John", lastName: "Smith" } },
        { speaker: { title: null, firstName: "Mary", lastName: "Johnson" } },
      ],
    },
  ];

  function moderatorRow(topics: unknown[] = TOPICS) {
    const row = speakerRow();
    row.sessions = [moderatedSession(topics)];
    return row;
  }

  beforeEach(() => {
    mockDb.event.findFirst.mockResolvedValue(eventRow("America/New_York"));
  });

  it("renders the moderated session with computed per-topic start–end times + durations", async () => {
    mockDb.speaker.findFirst.mockResolvedValue(moderatorRow());
    const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
    // Session header + window (11:00 AM – 12:30 PM EST, 1h 30m).
    expect(ctx?.moderatorDetails).toContain("Structural Heart Panel");
    expect(ctx?.moderatorDetails).toContain("Hall B");
    expect(ctx?.moderatorDetails).toContain("11:00 AM – 12:30 PM");
    // Topic clock stacks from the session start: 20m then 45m.
    expect(ctx?.moderatorDetails).toContain("11:00 AM – 11:20 AM");
    expect(ctx?.moderatorDetails).toContain("11:20 AM – 12:05 PM");
    expect(ctx?.moderatorDetails).toContain("20m");
    expect(ctx?.moderatorDetails).toContain("45m");
    // Topics + formatted speaker names.
    expect(ctx?.moderatorDetails).toContain("TAVR Outcomes");
    expect(ctx?.moderatorDetails).toContain("Dr. Jane Doe");
    expect(ctx?.moderatorDetails).toContain("Prof. John Smith, Mary Johnson");
    // Text variant mirrors it.
    expect(ctx?.moderatorDetailsText).toContain("11:00 AM – 11:20 AM");
    expect(ctx?.moderatorDetailsText).toContain("TAVR Outcomes");
  });

  it("a topic without a duration shows — and does NOT advance the clock", async () => {
    mockDb.speaker.findFirst.mockResolvedValue(
      moderatorRow([
        { title: "Welcome", duration: null, speakers: [] },
        { title: "Timed Talk", duration: 30, speakers: [] },
      ]),
    );
    const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
    // The timed topic starts at the SESSION start — the untimed one held the clock.
    expect(ctx?.moderatorDetails).toContain("11:00 AM – 11:30 AM");
  });

  it("is EMPTY for a speaker who moderates nothing", async () => {
    mockDb.speaker.findFirst.mockResolvedValue(speakerRow()); // role SPEAKER only
    const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
    expect(ctx?.moderatorDetails).toBe("");
    expect(ctx?.moderatorDetailsText).toBe("");
  });

  it("shows a no-topics note when the moderated session has no topics yet", async () => {
    mockDb.speaker.findFirst.mockResolvedValue(moderatorRow([]));
    const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
    expect(ctx?.moderatorDetails).toContain("No topics have been added");
  });

  it("HTML-escapes topic titles (a malicious title cannot inject)", async () => {
    mockDb.speaker.findFirst.mockResolvedValue(
      moderatorRow([
        { title: '<script>alert("x")</script>', duration: 10, speakers: [] },
      ]),
    );
    const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
    expect(ctx?.moderatorDetails).not.toContain("<script>");
    expect(ctx?.moderatorDetails).toContain("&lt;script&gt;");
  });
});
