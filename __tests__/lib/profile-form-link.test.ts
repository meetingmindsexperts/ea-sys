/**
 * {{profileFormLink}} in any send to speakers (Nov 27, 2026): the form row is
 * made only when the email names the token, and the link is the form's own.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { upsert } = vi.hoisted(() => ({ upsert: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { speakerProfileForm: { upsert } } }));
vi.mock("@/lib/speaker-profile/server", () => ({ generateProfileFormToken: () => "tok_new" }));

import { profileFormLinkForSend } from "@/lib/speaker-profile/form-link";

const base = { eventId: "ev1", organizationId: "org1", speakerId: "sp1", createdById: null, appUrl: "https://app.test", eventSlug: "medcon" };

beforeEach(() => {
  upsert.mockReset();
  upsert.mockResolvedValue({ id: "f1", token: "tok_kept", status: "SUBMITTED" });
});

describe("profileFormLinkForSend", () => {
  it("makes nothing and answers empty when no text names the token", async () => {
    const out = await profileFormLinkForSend({ ...base, texts: ["Hello {{firstName}}", null, "{{agreementLink}}"] });
    expect(out).toEqual({ profileFormLink: "" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("answers the speaker's own link when a text names it (a typed message too), keeping an existing form's token", async () => {
    const out = await profileFormLinkForSend({ ...base, texts: ["Subject", undefined, "Your form: {{profileFormLink}}"] });
    expect(out).toEqual({ profileFormLink: "https://app.test/e/medcon/speaker-form/tok_kept" });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { speakerId: "sp1" },
        update: {},
        create: { eventId: "ev1", organizationId: "org1", speakerId: "sp1", token: "tok_new", createdById: null },
      }),
    );
  });
});
