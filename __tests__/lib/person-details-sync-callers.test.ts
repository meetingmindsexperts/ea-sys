/**
 * Which edit paths sync personal details (Sep 29, 2026). The registrant portal
 * must NOT: it has no name lock, and an unverified public registration can
 * claim someone's unlinked registration (review H1/H2). Source assertions,
 * because the point is which files call the helper at all.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

describe("person-details-sync callers", () => {
  it("the registrant portal self-edit never syncs onto a speaker", () => {
    expect(read("src/app/api/registrant/registrations/route.ts")).not.toContain("person-details-sync");
  });

  it.each([
    ["src/services/speaker-service.ts", "syncSpeakerDetailsToRegistrations"],
    ["src/services/registration-service.ts", "syncRegistrationDetailsToSpeakers"],
    ["src/app/api/events/[eventId]/abstracts/my-profile/route.ts", "syncSpeakerDetailsToRegistrations"],
    ["src/app/api/public/events/[slug]/speaker-form/[token]/route.ts", "syncSpeakerDetailsToRegistrations"],
    ["src/app/api/public/events/[slug]/speaker-form/[token]/photo/route.ts", "syncSpeakerDetailsToRegistrations"],
  ])("%s calls %s", (file, fn) => {
    expect(read(file)).toContain(`${fn}(`);
  });
});
