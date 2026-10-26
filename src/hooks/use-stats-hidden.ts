"use client";

import { useState } from "react";

const STORAGE_KEY = "ea-sys:registrations-stats-hidden";

/**
 * Hide the Registrations page's stat cards (owner, Oct 26, 2026): at onsite
 * registration the laptop faces attendees, and the totals are not for them.
 *
 * Remembered on THIS browser, not per user, because the point is the desk
 * laptop staying hidden all day whoever signs in. Read once at render time
 * (the use-media-view pattern, no effect); storage can be blocked or throw
 * (private windows), in which case the cards simply show.
 */
export function useStatsHidden(): [boolean, (hidden: boolean) => void] {
  const [hidden, setHidden] = useState(false);
  const [read, setRead] = useState(false);

  if (typeof window !== "undefined" && !read) {
    setRead(true);
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === "1") setHidden(true);
    } catch {
      // Storage unavailable: show the cards.
    }
  }

  const change = (next: boolean) => {
    setHidden(next);
    try {
      if (next) window.localStorage.setItem(STORAGE_KEY, "1");
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage unavailable: the choice lasts until the page reloads.
    }
  };

  return [hidden, change];
}
