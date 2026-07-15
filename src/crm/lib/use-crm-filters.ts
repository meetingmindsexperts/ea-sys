"use client";

/**
 * URL-backed filter state for the CRM lists.
 *
 * Filters live in the query string, NOT React state — deliberately, and for the
 * same reason the CRM tabs are links: a filtered board is then shareable ("here's
 * every open Abbott deal closing this quarter"), bookmarkable, and survives a
 * refresh or a back-button. Local state loses all three the moment you navigate.
 *
 * `set` uses router.replace (not push), so tweaking a filter doesn't stack a dozen
 * history entries you have to click back through. Passing null/"" removes the key,
 * which keeps the URL clean and makes `active` (any filter set?) trivial.
 */
import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export function useCrmFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const get = useCallback((key: string) => params.get(key) ?? "", [params]);

  const set = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value == null || value === "") next.delete(key);
        else next.set(key, value);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  const clear = useCallback(
    (keys: string[]) => set(Object.fromEntries(keys.map((k) => [k, null]))),
    [set],
  );

  /** True when any of `keys` is set — powers the "Clear filters" affordance. */
  const anyActive = useCallback(
    (keys: string[]) => keys.some((k) => (params.get(k) ?? "") !== ""),
    [params],
  );

  return useMemo(() => ({ get, set, clear, anyActive }), [get, set, clear, anyActive]);
}
