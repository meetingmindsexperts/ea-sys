/**
 * An abstract or session proposal email's subject is the decision itself
 * ("Abstract Accepted!"), so on the activity timeline it needs the read key,
 * not speakers.read or registrations.read alone (owner, Oct 27, 2026).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockEmails } = vi.hoisted(() => ({
  mockDb: {
    issuedCertificate: { findMany: vi.fn() },
    auditLog: { findMany: vi.fn() },
    speakerReimbursement: { findUnique: vi.fn() },
    registration: { findFirst: vi.fn() },
    speaker: { findFirst: vi.fn() },
  },
  mockEmails: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/email-log", () => ({ getEmailLogsFor: (...a: unknown[]) => mockEmails(...a) }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { buildRegistrationActivity, buildSpeakerActivity } from "@/lib/activity-feed";

const email = (id: string, templateSlug: string | null, subject: string) => ({
  id,
  createdAt: new Date("2026-10-27T10:00:00Z"),
  subject,
  to: "spk@x.com",
  status: "SENT",
  templateSlug,
  errorMessage: null,
  hasBody: true,
  attachmentNames: [],
});

const EMAILS = [
  email("e-abs", "abstract-status-update", "Abstract Accepted! - MEHF"),
  email("e-agr", "presenter-agreement", "Presenter agreement"),
  email("e-prop", "session-proposal-confirmation", "Session Proposal Received - MEHF"),
  email("e-inv", "speaker-invitation", "You are invited"),
];

const speaker = { id: "spk1", sourceRegistrationId: null, email: "spk@x.com" };
const ids = (items: { id: string }[]) => items.map((i) => i.id).sort();

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.issuedCertificate.findMany.mockResolvedValue([]);
  mockDb.auditLog.findMany.mockResolvedValue([]);
  mockDb.speakerReimbursement.findUnique.mockResolvedValue(null);
  mockDb.registration.findFirst.mockResolvedValue(null);
  mockEmails.mockImplementation(async (type: string) => (type === "SPEAKER" ? EMAILS : []));
});

describe("activity timeline: abstract and proposal emails need their read keys", () => {
  it("drops both without either key, keeping the other emails", async () => {
    const { items } = await buildSpeakerActivity("evt1", speaker, "org1", true, true, { abstracts: false, proposals: false });
    expect(ids(items)).toEqual(["email:e-inv"]);
    expect(JSON.stringify(items)).not.toContain("Accepted");
  });

  it("each key shows its own emails", async () => {
    const abstractsOnly = await buildSpeakerActivity("evt1", speaker, "org1", true, true, { abstracts: true, proposals: false });
    expect(ids(abstractsOnly.items)).toEqual(["email:e-abs", "email:e-agr", "email:e-inv"]);
    const proposalsOnly = await buildSpeakerActivity("evt1", speaker, "org1", true, true, { abstracts: false, proposals: true });
    expect(ids(proposalsOnly.items)).toEqual(["email:e-inv", "email:e-prop"]);
  });

  it("defaults closed when the caller does not say", async () => {
    const { items } = await buildSpeakerActivity("evt1", speaker, "org1", true, true);
    expect(ids(items)).toEqual(["email:e-inv"]);
  });

  it("a registration's timeline drops its linked speaker's abstract emails too", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "spk1" });
    const { items } = await buildRegistrationActivity("evt1", { id: "reg1", attendeeEmail: "spk@x.com" }, "org1", true, true, { abstracts: false, proposals: false });
    expect(ids(items)).toEqual(["email:e-inv"]);
  });
});
