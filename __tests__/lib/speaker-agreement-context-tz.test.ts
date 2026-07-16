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
          location: null,
          track: null,
        },
      },
    ],
    topicSpeakers: [],
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
});
