import { describe, expect, it } from "vitest";
import {
  AGENDA_TRACK_BORDER_SETTING,
  isAgendaLiveForAttendees,
  isAgendaPublished,
  readAgendaTrackBorder,
} from "@/lib/agenda-display";
import { cloneEventSettings } from "@/lib/event-clone-settings";

describe("readAgendaTrackBorder", () => {
  it("keeps the border when the organiser never touched the switch", () => {
    expect(readAgendaTrackBorder({})).toBe(true);
    expect(readAgendaTrackBorder(null)).toBe(true);
    expect(readAgendaTrackBorder(undefined)).toBe(true);
    expect(readAgendaTrackBorder([])).toBe(true);
  });

  it("drops it only on an explicit false", () => {
    expect(readAgendaTrackBorder({ [AGENDA_TRACK_BORDER_SETTING]: false })).toBe(false);
    expect(readAgendaTrackBorder({ [AGENDA_TRACK_BORDER_SETTING]: true })).toBe(true);
    // An odd stored value never hides the border by accident.
    expect(readAgendaTrackBorder({ [AGENDA_TRACK_BORDER_SETTING]: "false" })).toBe(true);
    expect(readAgendaTrackBorder({ [AGENDA_TRACK_BORDER_SETTING]: 0 })).toBe(true);
  });

  it("copies with the event", () => {
    expect(cloneEventSettings({ [AGENDA_TRACK_BORDER_SETTING]: false })).toMatchObject({
      [AGENDA_TRACK_BORDER_SETTING]: false,
    });
  });
});

describe("isAgendaPublished", () => {
  it("reads the switch and its old name, strictly true", () => {
    expect(isAgendaPublished({ agendaPublished: true })).toBe(true);
    expect(isAgendaPublished({ programmePublished: true })).toBe(true);
    expect(isAgendaPublished({ agendaPublished: false })).toBe(false);
    expect(isAgendaPublished({})).toBe(false);
    expect(isAgendaPublished(null)).toBe(false);
    // A stray string never publishes a programme.
    expect(isAgendaPublished({ agendaPublished: "true" })).toBe(false);
  });
});

describe("isAgendaLiveForAttendees", () => {
  it("needs the switch AND a public event, as the public route does", () => {
    expect(isAgendaLiveForAttendees({ agendaPublished: true }, "PUBLISHED")).toBe(true);
    expect(isAgendaLiveForAttendees({ agendaPublished: true }, "LIVE")).toBe(true);
    expect(isAgendaLiveForAttendees({ agendaPublished: true }, "DRAFT")).toBe(false);
    expect(isAgendaLiveForAttendees({ agendaPublished: true }, "COMPLETED")).toBe(false);
    expect(isAgendaLiveForAttendees({ agendaPublished: false }, "LIVE")).toBe(false);
  });
});
