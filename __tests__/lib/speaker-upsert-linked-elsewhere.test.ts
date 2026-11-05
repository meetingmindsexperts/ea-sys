/**
 * upsertEventSpeaker never moves a speaker record linked to another account
 * (security review of 7cf4eb3b): a public sign-up door with someone's address
 * must not take over their speaker profile, abstracts or certificate.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/logger", () => { const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }; return { apiLogger: l, dbLogger: l, eventLogger: l, authLogger: l }; });
vi.mock("@/lib/db", () => ({ db: {} }));

import { SpeakerLinkedElsewhereError, upsertEventSpeaker } from "@/lib/speaker-companion";

const tx = (existing: unknown) => ({
  speaker: { findUnique: vi.fn().mockResolvedValue(existing), update: vi.fn(), create: vi.fn().mockResolvedValue({ id: "new" }) },
});
const args = { eventId: "e1", organizationId: "o1", email: "v@x.com", userId: "attacker", profile: { firstName: "A", lastName: "B" }, overwriteExisting: true };

describe("upsertEventSpeaker and an existing record", () => {
  it("refuses, and writes nothing, when the record is linked to another account", async () => {
    const t = tx({ id: "s1", submitterSource: null, firstName: "V", lastName: "W", userId: "victim" });
    await expect(upsertEventSpeaker(t as never, args as never)).rejects.toBeInstanceOf(SpeakerLinkedElsewhereError);
    expect(t.speaker.update).not.toHaveBeenCalled();
    expect(t.speaker.create).not.toHaveBeenCalled();
  });

  it("links a record already this account's", async () => {
    const t = tx({ id: "s1", submitterSource: null, firstName: "V", lastName: "W", userId: "attacker" });
    expect(await upsertEventSpeaker(t as never, { ...args, accountConfirmed: false } as never)).toBe("s1");
    expect(t.speaker.update).toHaveBeenCalledTimes(1);
  });

  it("an unclaimed record (the organisers made it) goes only to a confirmed account", async () => {
    const unconfirmed = tx({ id: "s1", submitterSource: null, firstName: "V", lastName: "W", userId: null });
    expect(await upsertEventSpeaker(unconfirmed as never, { ...args, accountConfirmed: false } as never)).toBeNull();
    expect(unconfirmed.speaker.update).not.toHaveBeenCalled();
    const confirmed = tx({ id: "s1", submitterSource: null, firstName: "V", lastName: "W", userId: null });
    expect(await upsertEventSpeaker(confirmed as never, { ...args, accountConfirmed: true } as never)).toBe("s1");
    expect(confirmed.speaker.update).toHaveBeenCalledTimes(1);
  });

  it("a brand-new speaker is created without any confirmation", async () => {
    const t = tx(null);
    expect(await upsertEventSpeaker(t as never, { ...args, accountConfirmed: false } as never)).toBe("new");
  });
});
