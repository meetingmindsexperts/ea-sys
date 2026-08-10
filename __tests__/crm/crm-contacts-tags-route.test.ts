/**
 * CRM contacts — the tag filter + the distinct-tags endpoint that feeds it.
 *
 * Pins: the list GET turns `?tags=a,b` into a `hasSome` where (any-of) and omits
 * the predicate entirely when no tag is passed (so the filter can't silently
 * narrow every list); and GET /contacts/tags returns the org's tags deduped +
 * sorted (exact stored strings, so the Select value always matches on `hasSome`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: { crmContact: { findMany: vi.fn(), count: vi.fn(async () => 0) } },
}));

vi.mock("@/crm/lib/crm-route", () => ({
  requireCrmRead: vi.fn(async () => ({
    ctx: { organizationId: "org-1", userId: "u-1", role: "ADMIN", fromApiKey: false },
  })),
}));

import { db } from "@/lib/db";
import { GET as listContacts } from "@/app/api/crm/contacts/route";
import { GET as listTags } from "@/app/api/crm/contacts/tags/route";

beforeEach(() => vi.clearAllMocks());

/** The list GET maps over rows stripping `deals`, so every row needs it. */
const row = (tags: string[]) => ({
  id: "c-1", firstName: "Jane", lastName: "Doe", email: "j@x.com", jobTitle: null,
  phone: null, mobile: null, country: null, lifecycleStage: null, status: null,
  tags, createdAt: new Date(), company: null, owner: null, contactId: null,
  archivedAt: null, _count: { deals: 0 }, deals: [],
});

const whereOf = () => vi.mocked(db.crmContact.findMany).mock.calls[0]![0]!.where as Record<string, unknown>;

describe("GET /api/crm/contacts — tag filter", () => {
  it("turns ?tags=a,b into a hasSome any-of predicate", async () => {
    vi.mocked(db.crmContact.findMany).mockResolvedValue([row(["mecomed"])] as never);
    await listContacts(new Request("http://x/api/crm/contacts?tags=mecomed,gold-prospect"));
    expect(whereOf().tags).toEqual({ hasSome: ["mecomed", "gold-prospect"] });
  });

  it("trims + drops blanks in the tag list", async () => {
    vi.mocked(db.crmContact.findMany).mockResolvedValue([] as never);
    await listContacts(new Request("http://x/api/crm/contacts?tags=%20mecomed%20,,"));
    expect(whereOf().tags).toEqual({ hasSome: ["mecomed"] });
  });

  it("omits the tags predicate entirely when none is passed", async () => {
    vi.mocked(db.crmContact.findMany).mockResolvedValue([] as never);
    await listContacts(new Request("http://x/api/crm/contacts"));
    expect(whereOf().tags).toBeUndefined();
  });
});

describe("GET /api/crm/contacts/tags — distinct tags", () => {
  it("returns the org's tags deduped + sorted", async () => {
    vi.mocked(db.crmContact.findMany).mockResolvedValue([
      { tags: ["gold-prospect", "mecomed"] },
      { tags: ["mecomed", "abbott"] },
      { tags: [] },
    ] as never);
    const res = await listTags(new Request("http://x/api/crm/contacts/tags"));
    expect(await res.json()).toEqual({ tags: ["abbott", "gold-prospect", "mecomed"] });
  });

  it("scopes to the org's non-archived contacts", async () => {
    vi.mocked(db.crmContact.findMany).mockResolvedValue([] as never);
    await listTags(new Request("http://x/api/crm/contacts/tags"));
    expect(whereOf()).toEqual({ organizationId: "org-1", archivedAt: null });
  });
});
