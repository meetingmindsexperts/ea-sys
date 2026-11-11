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
          id: "s-keynote",
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

function moderatedSession(topics: unknown[] = [], role = "MODERATOR") {
  return {
    role,
    session: {
      id: "s-panel",
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

  it("presentationDetails carries date / time as TWO separate lines — no duration, no Role row (organizer removed durations July 30)", async () => {
    mockDb.event.findFirst.mockResolvedValue(eventRow("America/New_York"));
    const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
    // 14:00–15:00 UTC = 9:00–10:00 AM in New York —
    // date <br/> time (owner request: never one combined line, no duration).
    expect(ctx?.presentationDetails).toContain("Mar 5, 2026<br/>9:00 AM – 10:00 AM (EST)");
    expect(ctx?.presentationDetails).not.toContain("EST<br/>1h");
    expect(ctx?.presentationDetailsText).toContain("9:00 AM – 10:00 AM");
    // Separate moderator/speaker sends — the block never displays the role.
    expect(ctx?.presentationDetails).not.toContain(">Role<");
  });

  it("multi-session speakers get ONE TABLE PER SESSION, each with its own window, in start-time order — no Track row", async () => {
    const row = speakerRow();
    row.sessions = [
      {
        role: "SPEAKER",
        session: {
          // Deliberately the LATER session listed first — output must sort
          // by start time.
          id: "s-valve",
          name: "Valve Workshop",
          startTime: new Date("2026-03-05T16:00:00Z"), // 11:00 AM EST
          endTime: new Date("2026-03-05T17:30:00Z"),
          location: null,
          track: { name: "Track B" } as never,
          topics: [],
        },
      },
      {
        role: "SPEAKER",
        session: {
          id: "s-keynote",
          name: "Opening Keynote",
          startTime: SESSION_START, // 9:00 AM EST
          endTime: new Date("2026-03-05T15:00:00Z"),
          location: null,
          track: { name: "Track A" } as never,
          topics: [],
        },
      },
    ];
    mockDb.speaker.findFirst.mockResolvedValue(row);
    mockDb.event.findFirst.mockResolvedValue(eventRow("America/New_York"));
    const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
    const html = ctx?.presentationDetails ?? "";

    // Two separate tables — one per session, with an explicit spacer div
    // between them (email clients that drop table margins glued them).
    expect(html.match(/<table/g)?.length).toBe(2);
    expect(html).toContain('<div style="height:16px; font-size:0; line-height:0;">&nbsp;</div>');
    // Each session's table carries ITS OWN track, never the joined list.
    const [first, second] = html.split("</table>");
    expect(first).toContain("Opening Keynote"); // earlier session first
    expect(first).toContain("9:00 AM – 10:00 AM (EST)");
    expect(second).toContain("Valve Workshop");
    expect(second).toContain("11:00 AM – 12:30 PM (EST)");
    // Track was removed from the block (organizer, July 30 2026) — the
    // {trackNames} merge token still carries it separately.
    expect(html).not.toContain(">Track<");
    expect(html).not.toContain("Track A");
    expect(html).not.toContain("Track B");
    expect(ctx?.trackNames).toContain("Track A");
    expect(ctx?.trackNames).toContain("Track B");

    // Text mirror: per-session blocks separated by a blank line.
    expect(ctx?.presentationDetailsText).toContain("Session: Opening Keynote");
    expect(ctx?.presentationDetailsText).toContain("Session: Valve Workshop");
    expect(ctx?.presentationDetailsText).toContain("\n\n");
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

  it("dual-role person across two sessions: speaking session in presentationDetails, a session they only moderate ONLY in moderatorDetails (July 31, 2026)", async () => {
    const row = speakerRow();
    row.sessions.push(moderatedSession());
    mockDb.speaker.findFirst.mockResolvedValue(row);
    mockDb.event.findFirst.mockResolvedValue(eventRow("America/New_York"));
    const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
    // Speaking session stays in the presentation block, under its own
    // bold heading (baked into the variable — organizer, July 31 2026)…
    expect(ctx?.presentationDetails).toContain("Your Presentation Details:");
    expect(ctx?.presentationDetails).toContain("font-weight:700");
    expect(ctx?.presentationDetails).toContain("9:00 AM – 10:00 AM");
    expect(ctx?.presentationDetails).toContain("Opening Keynote");
    // …but the moderated session's window/name must NOT appear there…
    expect(ctx?.presentationDetails).not.toContain("11:00 AM – 12:30 PM");
    expect(ctx?.presentationDetails).not.toContain("Structural Heart Panel");
    // …it renders in the moderator block instead.
    expect(ctx?.moderatorDetails).toContain("Structural Heart Panel");
    expect(ctx?.moderatorDetails).toContain("11:00 AM – 12:30 PM (EST)");
    expect(ctx?.presentationDetails).not.toContain("1h 30m"); // durations removed July 30
    // The docx scalar tokens deliberately keep covering ALL engagements.
    expect(ctx?.sessionTitles).toContain("Opening Keynote");
    expect(ctx?.sessionTitles).toContain("Structural Heart Panel");
  });

  it("moderator-only person: presentationDetails is EMPTY (their whole schedule lives in moderatorDetails)", async () => {
    const row = speakerRow();
    row.sessions = [moderatedSession()];
    row.topicSpeakers = [];
    mockDb.speaker.findFirst.mockResolvedValue(row);
    mockDb.event.findFirst.mockResolvedValue(eventRow("America/New_York"));
    const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
    expect(ctx?.presentationDetails).toBe("");
    expect(ctx?.moderatorDetails).toContain("Your Moderation Details:");
  });

  // Owner, Nov 11 2026. One person holds one session-level role, so "moderator
  // and speaker in the same session" is a MODERATOR role plus a topic. Before
  // this the topic was dropped from the presentation block, so a template with
  // only {{presentationDetails}} said nothing and the slot's time showed nowhere.
  describe("moderator who also presents a topic in the session they moderate", () => {
    const OWN_TOPIC = {
      title: "TAVR Outcomes",
      duration: 20,
      speakers: [{ speaker: { title: "DR", firstName: "Jane", lastName: "Doe" } }],
    };
    const OTHER_TOPIC = {
      title: "Mitral Repair Debate",
      duration: 45,
      speakers: [{ speaker: { title: "PROF", firstName: "John", lastName: "Smith" } }],
    };

    function moderatorWhoPresents(role = "MODERATOR") {
      const row = speakerRow();
      const moderated = moderatedSession([OTHER_TOPIC, OWN_TOPIC], role);
      row.sessions = [moderated];
      row.topicSpeakers = [
        {
          topic: {
            id: "own",
            title: OWN_TOPIC.title,
            duration: OWN_TOPIC.duration,
            session: {
              id: moderated.session.id,
              name: moderated.session.name,
              startTime: moderated.session.startTime,
              endTime: moderated.session.endTime,
              location: moderated.session.location as string | null,
              track: null,
              // The 45m topic runs first: 11:00 + 45m = 11:45 – 12:05 PM.
              topics: [
                { id: "other", duration: 45 },
                { id: "own", duration: 20 },
              ],
            },
          },
        },
      ] as unknown as ReturnType<typeof speakerRow>["topicSpeakers"];
      return row;
    }

    beforeEach(() => {
      mockDb.event.findFirst.mockResolvedValue(eventRow("America/New_York"));
    });

    it("presentationDetails lists their own topic with its time slot, under the session and its room", async () => {
      mockDb.speaker.findFirst.mockResolvedValue(moderatorWhoPresents());
      const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
      const html = ctx?.presentationDetails ?? "";
      expect(html).toContain("Your Presentation Details:");
      // The room comes from their session row: the topic query carries none.
      expect(html).toContain("Structural Heart Panel · Hall B");
      expect(html).toContain("TAVR Outcomes<br/>11:45 AM – 12:05 PM (EST)");
      expect(html).toContain("11:00 AM – 12:30 PM (EST)");
      // Only what THEY present: the other speaker's topic is not theirs.
      expect(html).not.toContain("Mitral Repair Debate");
      // One session, one table.
      expect(html.match(/<table/g)?.length).toBe(1);

      expect(ctx?.presentationDetailsText).toContain("Session: Structural Heart Panel · Hall B");
      expect(ctx?.presentationDetailsText).toContain("Topic: TAVR Outcomes, 11:45 AM – 12:05 PM (EST)");
    });

    it("moderatorDetails still carries the whole run-sheet, their own topic included", async () => {
      mockDb.speaker.findFirst.mockResolvedValue(moderatorWhoPresents());
      const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
      expect(ctx?.moderatorDetails).toContain("Your Moderation Details:");
      expect(ctx?.moderatorDetails).toContain("Mitral Repair Debate");
      expect(ctx?.moderatorDetails).toContain("TAVR Outcomes");
      expect(ctx?.moderatorDetails).toContain("Dr. Jane Doe");
      // The session is still ONE entry in the moderator block.
      expect(ctx?.moderatorDetails.match(/Structural Heart Panel/g)?.length).toBe(1);
    });

    it("a CHAIRPERSON who presents a topic gets the same", async () => {
      mockDb.speaker.findFirst.mockResolvedValue(moderatorWhoPresents("CHAIRPERSON"));
      const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
      expect(ctx?.presentationDetails).toContain("TAVR Outcomes<br/>11:45 AM – 12:05 PM (EST)");
      expect(ctx?.moderatorDetails).toContain("TAVR Outcomes");
    });

    it("alongside a separate speaking session: two tables in start-time order, the moderated one second", async () => {
      const row = moderatorWhoPresents();
      row.sessions.unshift(speakerRow().sessions[0]); // Opening Keynote, 9:00 AM
      mockDb.speaker.findFirst.mockResolvedValue(row);
      const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
      const html = ctx?.presentationDetails ?? "";
      expect(html.match(/<table/g)?.length).toBe(2);
      const [first, second] = html.split("</table>");
      expect(first).toContain("Opening Keynote");
      expect(second).toContain("Structural Heart Panel");
      expect(second).toContain("TAVR Outcomes");
    });

    // The four below came out of the review of 69c84961: each one names a
    // mutation that the tests above let through.

    it("takes the room of ITS OWN session, never another row's (a later row with a different room)", async () => {
      // Since the review the room is read from the topic's own session.
      const row = moderatorWhoPresents();
      // A second, later speaking session in another room, listed LAST.
      row.sessions.push({
        role: "SPEAKER",
        session: {
          id: "s-closing",
          name: "Closing Plenary",
          startTime: new Date("2026-03-05T19:00:00Z"), // 2:00 PM EST
          endTime: new Date("2026-03-05T20:00:00Z"),
          location: "Hall Z",
          track: null,
          topics: [],
        },
      });
      mockDb.speaker.findFirst.mockResolvedValue(row);
      const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
      const [first, second] = (ctx?.presentationDetails ?? "").split("</table>");
      expect(first).toContain("Structural Heart Panel · Hall B");
      expect(first).not.toContain("Hall Z");
      expect(second).toContain("Closing Plenary · Hall Z");
    });

    it("a moderated session with no room renders the bare session name", async () => {
      const row = moderatorWhoPresents();
      row.sessions[0].session.location = null;
      const [own] = row.topicSpeakers as unknown as Array<{ topic: { session: { location: string | null } } }>;
      own.topic.session.location = null;
      mockDb.speaker.findFirst.mockResolvedValue(row);
      const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
      expect(ctx?.presentationDetails).toContain("Structural Heart Panel</td>");
      expect(ctx?.presentationDetailsText).toContain("Session: Structural Heart Panel\n");
    });

    it("several own topics in one moderated session: each timed one carries its own slot, an untimed one its title only", async () => {
      const row = moderatorWhoPresents();
      const [own] = row.topicSpeakers as unknown as Array<{ topic: { session: Record<string, unknown> } }>;
      const session = own.topic.session;
      // Order on the session: own 25m, other 45m, own 20m, own untimed.
      const siblings = [
        { id: "own-a", duration: 25 },
        { id: "other", duration: 45 },
        { id: "own-b", duration: 20 },
        { id: "own-c", duration: null },
      ];
      const ownTopic = (id: string, title: string, duration: number | null) => ({
        topic: { id, title, duration, session: { ...session, topics: siblings } },
      });
      row.topicSpeakers = [
        ownTopic("own-a", "Welcome and Introduction", 25),
        ownTopic("own-b", "Updates in AML Management", 20),
        ownTopic("own-c", "Open Discussion", null),
      ] as unknown as ReturnType<typeof speakerRow>["topicSpeakers"];
      mockDb.speaker.findFirst.mockResolvedValue(row);
      const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
      const html = ctx?.presentationDetails ?? "";
      // 11:00 start: 25m, then 45m of someone else, then 20m.
      expect(html).toContain("Welcome and Introduction<br/>11:00 AM – 11:25 AM (EST)");
      expect(html).toContain("Updates in AML Management<br/>12:10 PM – 12:30 PM (EST)");
      expect(html).toContain("Open Discussion");
      expect(html).not.toContain("Open Discussion<br/>");
      // All three under ONE session table.
      expect(html.match(/<table/g)?.length).toBe(1);
      expect(ctx?.presentationDetailsText).toContain(
        "Topic: Welcome and Introduction, 11:00 AM – 11:25 AM (EST); Updates in AML Management, 12:10 PM – 12:30 PM (EST); Open Discussion",
      );
    });

    // Review of 69c84961, LOW 2: the group key was name + start time, so two
    // DIFFERENT sessions sharing both were one table.
    describe("two different sessions with the same name and start (parallel rooms)", () => {
      const START = new Date("2026-03-05T15:00:00Z"); // 10:00 AM EST
      const workshop = (id: string, location: string, end: string) => ({
        id,
        name: "Workshop",
        startTime: START,
        endTime: new Date(end),
        location,
        track: null,
      });
      const HALL_A = workshop("s-a", "Hall A", "2026-03-05T15:30:00Z"); // to 10:30
      const HALL_B = workshop("s-b", "Hall B", "2026-03-05T17:00:00Z"); // to 12:00
      const topicInB = [
        {
          topic: {
            id: "tb",
            title: "My B-topic",
            duration: 30,
            session: { ...HALL_B, topics: [{ id: "tb", duration: 30 }] },
          },
        },
      ] as unknown as ReturnType<typeof speakerRow>["topicSpeakers"];

      it("moderates one, presents a topic in the OTHER: the topic shows under its own room", async () => {
        const row = speakerRow();
        row.sessions = [{ role: "MODERATOR", session: { ...HALL_A, topics: [] } }];
        row.topicSpeakers = topicInB;
        mockDb.speaker.findFirst.mockResolvedValue(row);
        const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
        const html = ctx?.presentationDetails ?? "";
        expect(html).toContain("Workshop · Hall B");
        expect(html).not.toContain("Hall A");
        expect(html).toContain("My B-topic<br/>10:00 AM – 10:30 AM (EST)");
        expect(html).toContain("10:00 AM – 12:00 PM (EST)");
      });

      it("speaks in one, presents a topic in the other: two tables, the topic in its own", async () => {
        const row = speakerRow();
        row.sessions = [
          { role: "SPEAKER", session: { ...HALL_A, topics: [] } },
          { role: "MODERATOR", session: { ...HALL_B, topics: [] } },
        ];
        row.topicSpeakers = topicInB;
        mockDb.speaker.findFirst.mockResolvedValue(row);
        const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
        const html = ctx?.presentationDetails ?? "";
        expect(html.match(/<table/g)?.length).toBe(2);
        const [first, second] = html.split("</table>");
        expect(first).toContain("Workshop · Hall A");
        expect(first).toContain("10:00 AM – 10:30 AM (EST)");
        expect(first).not.toContain("My B-topic");
        expect(second).toContain("Workshop · Hall B");
        expect(second).toContain("My B-topic");
        expect(second).toContain("10:00 AM – 12:00 PM (EST)");
      });
    });

    it("a topic-only speaker (no session role) sees the session's room too", async () => {
      // Review LOW 3: the room showed for a moderator who presents and not for
      // the speaker beside them on the same session.
      const row = moderatorWhoPresents();
      row.sessions = [];
      mockDb.speaker.findFirst.mockResolvedValue(row);
      const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
      expect(ctx?.presentationDetails).toContain("Structural Heart Panel · Hall B");
      expect(ctx?.presentationDetailsText).toContain("Session: Structural Heart Panel · Hall B");
      expect(ctx?.moderatorDetails).toBe("");
    });

    it("sorts by start time when the moderated session comes BEFORE the speaking one", async () => {
      const row = moderatorWhoPresents();
      // Speaking row listed FIRST but starting later (2:00 PM EST): groups are
      // created speaking-rows-first, so only the sort can put the panel on top.
      row.sessions.unshift({
        role: "SPEAKER",
        session: {
          id: "s-closing",
          name: "Closing Plenary",
          startTime: new Date("2026-03-05T19:00:00Z"),
          endTime: new Date("2026-03-05T20:00:00Z"),
          location: null,
          track: null,
          topics: [],
        },
      });
      mockDb.speaker.findFirst.mockResolvedValue(row);
      const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
      const [first, second] = (ctx?.presentationDetails ?? "").split("</table>");
      expect(first).toContain("Structural Heart Panel");
      expect(first).toContain("TAVR Outcomes");
      expect(second).toContain("Closing Plenary");
    });
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

  function moderatorRow(topics: unknown[] = TOPICS, role = "MODERATOR") {
    const row = speakerRow();
    row.sessions = [moderatedSession(topics, role)];
    return row;
  }

  beforeEach(() => {
    mockDb.event.findFirst.mockResolvedValue(eventRow("America/New_York"));
  });

  it("opens with the 'Your Moderation Details:' heading and renders NO topic-level times (organizer, July 30 PM)", async () => {
    mockDb.speaker.findFirst.mockResolvedValue(moderatorRow());
    const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
    expect(ctx?.moderatorDetails).toContain("Your Moderation Details:");
    // Session header + window — the ONLY clock shown, tz in parens.
    expect(ctx?.moderatorDetails).toContain("Structural Heart Panel");
    expect(ctx?.moderatorDetails).toContain("Hall B");
    expect(ctx?.moderatorDetails).toContain("11:00 AM – 12:30 PM (EST)");
    // Topic-level computed times were removed with the Time column.
    expect(ctx?.moderatorDetails).not.toContain("11:00 AM – 11:20 AM");
    expect(ctx?.moderatorDetails).not.toContain("11:20 AM – 12:05 PM");
    expect(ctx?.moderatorDetails).not.toContain(">Duration<");
    // Topics + formatted speaker names.
    expect(ctx?.moderatorDetails).toContain("TAVR Outcomes");
    expect(ctx?.moderatorDetails).toContain("Dr. Jane Doe");
    expect(ctx?.moderatorDetails).toContain("Prof. John Smith, Mary Johnson");
    // Text variant mirrors it (heading + no topic times).
    expect(ctx?.moderatorDetailsText).toContain("Your Moderation Details:");
    expect(ctx?.moderatorDetailsText).not.toContain("11:00 AM – 11:20 AM");
    expect(ctx?.moderatorDetailsText).toContain("TAVR Outcomes");
  });

  it("renders TBA in 'Presented by' for a topic with no speaker, in both HTML and text", async () => {
    // This document is handed to someone running a room, so an unassigned slot
    // has to read as unassigned rather than as a blank cell they mistake for a
    // rendering fault. Previously a bare dash in HTML and nothing at all in the
    // plain-text mirror.
    mockDb.speaker.findFirst.mockResolvedValue(
      moderatorRow([
        { title: "Opening Remarks", duration: 10, speakers: [] },
        ...TOPICS,
      ]),
    );
    const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
    expect(ctx?.moderatorDetails).toContain("Opening Remarks");
    expect(ctx?.moderatorDetails).toContain("TBA");
    expect(ctx?.moderatorDetailsText).toContain("Opening Remarks — TBA");
    // Assigned topics are untouched.
    expect(ctx?.moderatorDetails).toContain("Dr. Jane Doe");
  });

  it("renders the labeled Session / Date & Time table then the Topic | Presented by run-sheet — no role, no track, no Time column", async () => {
    const row = moderatorRow();
    (row.sessions[0].session as { track: unknown }).track = { name: "Track B" };
    mockDb.speaker.findFirst.mockResolvedValue(row);
    const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
    const html = ctx?.moderatorDetails ?? "";
    // Labeled info table (shared renderer with presentationDetails). The
    // role/track/duration rows were removed by the organizer (July 30, 2026 —
    // this superseded the same-day "Your Role" badge row).
    expect(html).toContain(">Session<");
    expect(html).toContain(">Date &amp; Time<");
    expect(html).not.toContain(">Your Role<");
    expect(html).not.toContain(">Track<");
    expect(html).not.toContain("Track B");
    // …followed by the run-sheet table headers ("Presented by", not
    // "Speaker(s)"; no Time and no Duration columns — July 30 PM).
    expect(html).not.toContain(">Time<");
    expect(html).toContain(">Topic<");
    expect(html).toContain(">Presented by<");
    expect(html).not.toContain(">Speaker(s)<");
    expect(html).not.toContain(">Duration<");
    // Text mirror uses the same labeled lines.
    expect(ctx?.moderatorDetailsText).toContain("Session: Structural Heart Panel · Hall B");
    expect(ctx?.moderatorDetailsText).not.toContain("Your Role:");
    expect(ctx?.moderatorDetailsText).toContain("Date & Time: ");
    expect(ctx?.moderatorDetailsText).not.toContain("Track:");
  });

  it("a CHAIRPERSON gets the block too — same run-sheet, no role row (July 30, 2026)", async () => {
    mockDb.speaker.findFirst.mockResolvedValue(moderatorRow(TOPICS, "CHAIRPERSON"));
    const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
    // The full run-sheet renders for chairs exactly like moderators; the
    // "Your Role" badge was removed the same day by the organizer.
    expect(ctx?.moderatorDetails).toContain("TAVR Outcomes");
    expect(ctx?.moderatorDetails).toContain("Dr. Jane Doe");
    expect(ctx?.moderatorDetails).not.toContain(">Your Role<");
    expect(ctx?.moderatorDetailsText).not.toContain("Your Role:");
  });

  it("is EMPTY for a speaker who moderates nothing", async () => {
    mockDb.speaker.findFirst.mockResolvedValue(speakerRow()); // role SPEAKER only
    const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
    expect(ctx?.moderatorDetails).toBe("");
    expect(ctx?.moderatorDetailsText).toBe("");
  });

  it("PANELIST does NOT get the block — only roles that RUN the session do", async () => {
    mockDb.speaker.findFirst.mockResolvedValue(moderatorRow(TOPICS, "PANELIST"));
    const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
    expect(ctx?.moderatorDetails).toBe("");
    expect(ctx?.moderatorDetailsText).toBe("");
  });

  it("presentationDetails shows the speaker's OWN topic window, stacked from siblings — no duration line", async () => {
    const row = speakerRow();
    row.topicSpeakers = [
      {
        topic: {
          id: "t2",
          title: "Valve Repair Update",
          duration: 30,
          session: {
            id: "s-keynote",
            name: "Opening Keynote",
            startTime: SESSION_START, // 9:00 AM in New York
            endTime: new Date("2026-03-05T15:00:00Z"),
            location: null,
            track: null,
            // A 20m sibling precedes this speaker's topic → 9:20 – 9:50 AM.
            topics: [
              { id: "t1", duration: 20 },
              { id: "t2", duration: 30 },
            ],
          },
        },
      },
    ] as unknown as ReturnType<typeof speakerRow>["topicSpeakers"];
    mockDb.speaker.findFirst.mockResolvedValue(row);
    const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
    expect(ctx?.presentationDetails).toContain("Valve Repair Update<br/>9:20 AM – 9:50 AM (EST)");
    expect(ctx?.presentationDetails).not.toContain("EST<br/>30m");
    // The docx {topicTitles} token stays titles-only.
    expect(ctx?.topicTitles).toBe("Valve Repair Update");
  });

  it("a topic without a duration renders its title only (no time lines)", async () => {
    const row = speakerRow();
    row.topicSpeakers = [
      {
        topic: {
          id: "t1",
          title: "Welcome Remarks",
          duration: null,
          session: {
            id: "s-keynote",
            name: "Opening Keynote",
            startTime: SESSION_START,
            endTime: new Date("2026-03-05T15:00:00Z"),
            location: null,
            track: null,
            topics: [{ id: "t1", duration: null }],
          },
        },
      },
    ] as unknown as ReturnType<typeof speakerRow>["topicSpeakers"];
    mockDb.speaker.findFirst.mockResolvedValue(row);
    const ctx = await buildSpeakerEmailContext("evt-1", "spk-1");
    expect(ctx?.presentationDetails).toContain("Welcome Remarks");
    expect(ctx?.presentationDetails).not.toContain("Welcome Remarks<br/>");
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
