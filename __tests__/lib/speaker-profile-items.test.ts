import { describe, expect, it } from "vitest";
import {
  askedProfileItems,
  missingProfileDocSlots,
  PROFILE_ITEM_KEYS,
  profileFormItems,
  profileItemsSchema,
  readEventProfileItems,
  readSpeakerProfileItems,
} from "@/lib/speaker-profile/constants";

/**
 * What a speaker's form link asks for (owner, Nov 19, 2026: "give control to
 * organizer just like reimbursement"): the event's default, and one speaker's
 * own list. Asked or not; the rules for an item that is asked are unchanged.
 */
describe("what a speaker is asked for", () => {
  it("is everything on an event that never chose, so nothing changes until someone does", () => {
    expect(readEventProfileItems(null)).toEqual([...PROFILE_ITEM_KEYS]);
    expect(readEventProfileItems({})).toEqual([...PROFILE_ITEM_KEYS]);
    expect(readEventProfileItems({ speakerProfile: { items: [] } })).toEqual([...PROFILE_ITEM_KEYS]);
    expect(readEventProfileItems({ speakerProfile: { items: "photo" } })).toEqual([...PROFILE_ITEM_KEYS]);
  });

  it("is the event's list when set, in the list's own order, unknown keys dropped", () => {
    expect(readEventProfileItems({ speakerProfile: { items: ["presentation", "photo", "nonsense"] } })).toEqual(["photo", "presentation"]);
  });

  it("is the speaker's own list when set, which replaces the event's rather than narrowing it", () => {
    const eventSettings = { speakerProfile: { items: ["photo", "bio"] } };
    expect(askedProfileItems({ eventSettings, speakerItems: null })).toEqual(["photo", "bio"]);
    // A passport asked of one speaker on an event that asks nobody: the point of the override.
    expect(askedProfileItems({ eventSettings, speakerItems: ["passport"] })).toEqual(["passport"]);
    expect(readSpeakerProfileItems([])).toBeNull();
  });

  it("never saves an empty list", () => {
    expect(profileItemsSchema.safeParse([]).success).toBe(false);
    expect(profileItemsSchema.safeParse(["cover_letter", "photo"]).data).toEqual(["photo", "cover_letter"]);
    expect(profileItemsSchema.safeParse(["cv"]).success).toBe(false);
  });

  it("separates the form to submit from the presentation, which is never submitted", () => {
    expect(profileFormItems(["photo", "presentation"])).toEqual(["photo"]);
    expect(profileFormItems(["presentation"])).toEqual([]);
  });

  it("never counts a document that is not asked as missing", () => {
    // Today's rule when everything is asked: the passport is required.
    expect(missingProfileDocSlots([])).toEqual(["passport"]);
    // A local speaker not asked for one is never held up by it.
    expect(missingProfileDocSlots([], ["photo", "bio", "presentation"])).toEqual([]);
    expect(missingProfileDocSlots(["Passport copy"], ["passport"])).toEqual([]);
  });
});
