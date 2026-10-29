/**
 * The paged Contacts / Accounts lists (Oct 29, 2026). Two things only a test
 * holds: their cache keys sit UNDER the contacts / companies prefixes, so the
 * writes that refresh those lists refresh the pages too; and the URL carries
 * paged=1, the filters, the sort and the cursor.
 */
import { describe, it, expect, vi } from "vitest";

const captured: Array<{ key: readonly unknown[]; url: string | null }> = [];

vi.mock("@tanstack/react-query", async (orig) => {
  const actual = await orig<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useInfiniteQuery: (opts: { queryKey: readonly unknown[]; queryFn: (c: { pageParam: string | null }) => unknown }) => {
      let url: string | null = null;
      const prev = globalThis.fetch;
      // @ts-expect-error test stub
      globalThis.fetch = vi.fn((input: string) => {
        url = input;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });
      try {
        void opts.queryFn({ pageParam: "CUR" });
      } finally {
        globalThis.fetch = prev;
      }
      captured.push({ key: opts.queryKey, url });
      return { data: undefined };
    },
  };
});

import { crmKeys, flattenPages, useCrmCompaniesPage, useCrmContactsPage } from "@/crm/hooks/use-crm-api";

const startsWith = (key: readonly unknown[], prefix: readonly unknown[]) => prefix.every((p, i) => key[i] === p);

describe("paged list hooks", () => {
  it("contacts: under the contacts prefix, with filters, sort and cursor in the URL", () => {
    captured.length = 0;
    useCrmContactsPage({ q: "abbott", archived: undefined }, { sort: "score", dir: "desc" });
    const { key, url } = captured[0]!;
    expect(startsWith(key, crmKeys.contactsPrefix)).toBe(true);
    const qs = new URL(url!, "http://x").searchParams;
    expect(Object.fromEntries(qs)).toEqual({ paged: "1", q: "abbott", sort: "score", dir: "desc", cursor: "CUR" });
  });

  it("accounts: under the companies prefix; no sort means the server default", () => {
    captured.length = 0;
    useCrmCompaniesPage({ needsReview: "true" }, {});
    const { key, url } = captured[0]!;
    expect(startsWith(key, crmKeys.companiesPrefix)).toBe(true);
    const qs = new URL(url!, "http://x").searchParams;
    expect(Object.fromEntries(qs)).toEqual({ paged: "1", needsReview: "true", cursor: "CUR" });
  });
});

describe("flattenPages", () => {
  it("joins pages and drops a row repeated across a boundary", () => {
    expect(flattenPages([[{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }]]).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(flattenPages(undefined)).toEqual([]);
  });
});
