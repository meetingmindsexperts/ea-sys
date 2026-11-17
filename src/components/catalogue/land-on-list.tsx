"use client";

import { useEffect } from "react";

/**
 * Finishes a jump to the event list that the browser did not make.
 *
 * The search box is a plain GET form whose action carries the list's anchor
 * (`onList` in src/lib/catalogue.ts). The result opens at `/catalogue?q=...#events`,
 * but Chrome does not scroll to a fragment that came from a form's action: the
 * address shows it and the page stays at the top (measured Nov 17, 2026; a link
 * or a typed address with the same fragment does scroll). So when the page
 * opens with the anchor in its address and nothing is the browser's target,
 * this scrolls there. A link, which the browser or Next already handled, has a
 * target and is left alone.
 */
export function LandOnList({ anchor }: { anchor: string }) {
  useEffect(() => {
    if (window.location.hash !== `#${anchor}`) return;
    if (document.querySelector(":target")) return;
    // Honours the section's own scroll margin, as a link to it does.
    document.getElementById(anchor)?.scrollIntoView();
  }, [anchor]);
  return null;
}
