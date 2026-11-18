import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {}, tenantTransaction: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  DEFAULT_TOPIC_PRESENTER_LABEL,
  presenterLabelText,
  SESSION_TOPIC_PRESETS,
  TOPIC_PRESENTER_LABEL_KEYS,
} from "@/lib/session-topic-presets";
import { presenterLabelUpdate, presetTopicProblem } from "@/services/session-service";

describe("session topic presets", () => {
  it("offers Panel Discussion and Q&A, presented by All until the organiser changes it", () => {
    expect(SESSION_TOPIC_PRESETS).toEqual(["Panel Discussion", "Q&A"]);
    expect(presenterLabelText(DEFAULT_TOPIC_PRESENTER_LABEL)).toBe("All");
  });

  it("turns the three codes into the owner's words, and nothing else into anything", () => {
    expect(TOPIC_PRESENTER_LABEL_KEYS.map(presenterLabelText)).toEqual(["All", "All Faculty", "All the above"]);
    expect(presenterLabelText(null)).toBeNull();
    expect(presenterLabelText(undefined)).toBeNull();
    expect(presenterLabelText("All")).toBeNull(); // the words are not a code
    expect(presenterLabelText("toString")).toBeNull(); // nor is an inherited key
  });
});

describe("presetTopicProblem", () => {
  it("accepts ordinary topics and presets that name no speakers", () => {
    expect(presetTopicProblem(undefined)).toBeNull();
    expect(
      presetTopicProblem([
        { title: "Keynote", speakerIds: ["s1"] },
        { title: "Panel Q&A", presenterLabel: "ALL_FACULTY", speakerIds: [] },
        { title: "Q&A", presenterLabel: null, speakerIds: ["s2"] },
      ]),
    ).toBeNull();
  });

  it("refuses a preset that also names speakers, rather than dropping them", () => {
    expect(presetTopicProblem([{ title: "Q&A", presenterLabel: "ALL", speakerIds: ["s1"] }])).toMatch(
      /cannot also name speakers/,
    );
  });

  it("refuses a code that is not one of the three", () => {
    expect(presetTopicProblem([{ title: "Q&A", presenterLabel: "EVERYONE" }])).toMatch(/must be one of/);
  });
});

describe("presenterLabelUpdate", () => {
  it("writes the label the caller sent, null included", () => {
    expect(presenterLabelUpdate({ title: "Q&A", presenterLabel: "ALL_ABOVE" })).toEqual({ presenterLabel: "ALL_ABOVE" });
    expect(presenterLabelUpdate({ title: "Q&A", presenterLabel: null })).toEqual({ presenterLabel: null });
  });

  it("keeps the stored label when a caller that does not know the field leaves it out", () => {
    expect(presenterLabelUpdate({ title: "Panel Discussion", speakerIds: [] })).toEqual({});
    expect(presenterLabelUpdate({ title: "Panel Discussion" })).toEqual({});
  });

  it("makes it an ordinary topic when the caller leaves it out and names speakers", () => {
    expect(presenterLabelUpdate({ title: "Panel Discussion", speakerIds: ["s1"] })).toEqual({ presenterLabel: null });
  });
});
