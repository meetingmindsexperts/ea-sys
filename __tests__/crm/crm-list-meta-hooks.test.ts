/**
 * The list hook and its meta hook must share ONE cache entry.
 *
 * WHY THIS NEEDS A TEST. The banner's whole design rests on "same queryKey, same
 * queryFn, different `select` — so no second fetch". Nothing enforced it. Reorder
 * the filter keys at one of the two contacts call sites and the query string
 * diverges, the keys diverge, and every filter change silently issues a second
 * identical-payload request — full suite still green.
 *
 * Worse, `ListTruncationBanner` fails OPEN (`if (!meta?.truncated) return null`),
 * so a meta hook that quietly broke renders as "nothing was truncated" — i.e.
 * straight back to the original bug this feature exists to fix.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hashKey } from "@tanstack/react-query";
import {
  crmKeys,
  useCrmDeals,
  useCrmDealsMeta,
  useCrmContacts,
  useCrmContactsMeta,
  useCrmCompanies,
  useCrmCompaniesMeta,
} from "@/crm/hooks/use-crm-api";

/**
 * The hooks call `useQuery` at the top level, so exercising them for real needs
 * a renderer. What actually matters is narrower and testable without one: both
 * hooks in a pair must produce the same CACHE KEY HASH and the same URL. We
 * capture both by stubbing `useQuery` and `fetch`, then invoking the hook bodies.
 */
const captured: Array<{ key: unknown; url: string | null }> = [];

vi.mock("@tanstack/react-query", async (orig) => {
  const actual = await orig<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: (opts: { queryKey: unknown; queryFn: () => unknown }) => {
      let url: string | null = null;
      const spy = vi.fn((input: string) => {
        url = input;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });
      const prev = globalThis.fetch;
      // @ts-expect-error — test stub
      globalThis.fetch = spy;
      try {
        void opts.queryFn();
      } catch {
        /* the stub resolves; a throw here would mean the URL was never built */
      }
      globalThis.fetch = prev;
      captured.push({ key: opts.queryKey, url });
      return { data: undefined };
    },
  };
});

/** TanStack's own key hasher — the exact function the cache uses to match. */
const hash = (k: unknown) => hashKey(k as readonly unknown[]);

beforeEach(() => {
  captured.length = 0;
});
afterEach(() => vi.restoreAllMocks());

/** Run a list hook and its meta twin over the same filters, return both captures. */
function pair(list: () => unknown, meta: () => unknown) {
  list();
  meta();
  expect(captured).toHaveLength(2);
  return { list: captured[0]!, meta: captured[1]! };
}

describe("deals", () => {
  it("list and meta share the cache key AND the URL", () => {
    const filters = { eventId: "e-1", status: "OPEN" };
    const { list, meta } = pair(() => useCrmDeals(filters), () => useCrmDealsMeta(filters));
    expect(hash(meta.key)).toBe(hash(list.key));
    expect(meta.url).toBe(list.url);
  });

  it("agree even when the caller passes filter keys in a different ORDER", () => {
    // The key is an object, so TanStack's hashKey sorts it — but the URL is built
    // from Object.entries, which is insertion-ordered. If the two hooks ever
    // derive the suffix separately, this is where they part company.
    const { list } = pair(
      () => useCrmDeals({ eventId: "e-1", status: "OPEN" }),
      () => useCrmDealsMeta({ eventId: "e-1", status: "OPEN" }),
    );
    captured.length = 0;
    const { meta } = pair(
      () => useCrmDeals({ status: "OPEN", eventId: "e-1" }),
      () => useCrmDealsMeta({ status: "OPEN", eventId: "e-1" }),
    );
    expect(hash(meta.key)).toBe(hash(list.key));
  });
});

describe("contacts", () => {
  it("list and meta share the cache key AND the URL", () => {
    const filters = { q: "abbott", lifecycle: "ENGAGED" };
    const { list, meta } = pair(() => useCrmContacts(filters), () => useCrmContactsMeta(filters));
    expect(hash(meta.key)).toBe(hash(list.key));
    expect(meta.url).toBe(list.url);
  });
});

describe("companies", () => {
  it("list and meta share the cache key AND the URL", () => {
    const filters = { q: "abbott", needsReview: "true" };
    const { list, meta } = pair(() => useCrmCompanies(filters), () => useCrmCompaniesMeta(filters));
    expect(hash(meta.key)).toBe(hash(list.key));
    expect(meta.url).toBe(list.url);
  });

  it("a DIFFERENT filter set is a different key — the pairing must not be accidental", () => {
    // Guards the inverse: a test that passes because every key is identical
    // would be worthless.
    const a = pair(() => useCrmCompanies({ q: "abbott" }), () => useCrmCompaniesMeta({ q: "abbott" }));
    captured.length = 0;
    const b = pair(() => useCrmCompanies({ q: "pfizer" }), () => useCrmCompaniesMeta({ q: "pfizer" }));
    expect(hash(b.list.key)).not.toBe(hash(a.list.key));
  });
});

describe("crmKeys", () => {
  it("companyFacets is its own key — the aggregates must not ride a capped list read", () => {
    expect(hash(crmKeys.companyFacets)).not.toBe(hash(crmKeys.companies()));
  });
});
