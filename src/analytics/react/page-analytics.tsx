"use client";

/**
 * Mounts the beacon for the public event subtree.
 *
 * Rendered once from src/app/e/[slug]/layout.tsx rather than added to each
 * measurable page. Remembering to add it is exactly the kind of thing that gets
 * forgotten on the next new page, and the allow-list means mounting it
 * everywhere is safe: on a route we may not measure it sends nothing at all.
 *
 * TWO HITS, NOT ONE, and the reason matters:
 *
 *   "pageview"        on arrival. This is the DENOMINATOR, the number the whole
 *                     feature exists to produce, so it is sent immediately
 *                     rather than held until the visitor leaves. Someone who
 *                     opens the register page and closes it two seconds later
 *                     is precisely the person we are trying to count.
 *
 *   "page_engagement" on leaving, carrying time on page and scroll depth.
 *                     Separate rather than an amended pageview, because
 *                     re-sending "pageview" would double the count and quietly
 *                     inflate the one number that has to be right.
 */

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { track, scrollDepthPercent } from "@/analytics/core/beacon";

/** Anything below this is a bounce or a mis-click; not worth a second request. */
const MIN_ENGAGEMENT_MS = 1000;

export function PageAnalytics({ site }: { site: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Refs, not state: none of this should ever cause a render. The component
  // exists to observe the page, not to participate in it.
  const arrivedAt = useRef<number>(0);
  const maxScroll = useRef<number>(0);
  const engagementSent = useRef<boolean>(false);

  useEffect(() => {
    if (!site || typeof window === "undefined") return;

    arrivedAt.current = Date.now();
    maxScroll.current = 0;
    engagementSent.current = false;

    const search = searchParams?.toString() ?? "";
    const location = { pathname, search: search ? `?${search}` : "" };

    track(
      site,
      "pageview",
      location,
      {},
      // Only an EXTERNAL referrer is of interest, and the server reduces it to
      // a host and drops our own. Passing it through unchanged here keeps the
      // decision in one place rather than half here and half there.
      typeof document !== "undefined" ? document.referrer : undefined,
    );

    const onScroll = () => {
      const pct = scrollDepthPercent({
        scrollY: window.scrollY,
        innerHeight: window.innerHeight,
        documentHeight: document.documentElement.scrollHeight,
      });
      if (pct > maxScroll.current) maxScroll.current = pct;
    };

    const sendEngagement = () => {
      // Guarded because both listeners can fire for one departure: a visitor
      // who backgrounds the tab and then closes it would otherwise be counted
      // twice, with the second duration wrong.
      if (engagementSent.current) return;
      const durationMs = Date.now() - arrivedAt.current;
      if (durationMs < MIN_ENGAGEMENT_MS) return;
      engagementSent.current = true;

      track(site, "page_engagement", location, {
        durationMs,
        scrollDepth: maxScroll.current,
      });
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") sendEngagement();
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    // pagehide as well as visibilitychange: Safari on iOS does not reliably
    // fire the latter when the tab is closed, and this is the one moment the
    // engagement hit has to survive.
    window.addEventListener("pagehide", sendEngagement);

    return () => {
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", sendEngagement);
      // A client-side navigation unmounts this effect without firing either
      // event, so the departure has to be reported here too.
      sendEngagement();
    };
    // searchParams is deliberately NOT a dependency. utm values are read once
    // on arrival, and re-running on an unrelated query change (a Stripe return,
    // a filter) would count a second pageview for the same visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site, pathname]);

  return null;
}
