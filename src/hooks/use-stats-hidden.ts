"use client";

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "ea-sys:registrations-stats-hidden";

/**
 * Hide the Registrations page's stat cards (owner, Oct 26, 2026): at onsite
 * registration the laptop faces attendees, and the totals are not for them.
 *
 * Remembered on THIS browser, not per user, because the point is the desk
 * laptop staying hidden all day whoever signs in. Where storage is blocked
 * or throws, the toggle still works but is forgotten on reload.
 *
 * useSyncExternalStore with a server snapshot of "shown" (review L4): the
 * server render and the hydration render agree whatever the browser holds,
 * so a server-rendered stats block can never mismatch.
 */
const listeners = new Set<() => void>();
// Used only where storage throws: the toggle still works until the page reloads.
let inMemory = false;

function read(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return inMemory;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab on the same laptop changing it.
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function write(hidden: boolean): void {
  inMemory = hidden;
  try {
    if (hidden) window.localStorage.setItem(STORAGE_KEY, "1");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable: read() falls back to inMemory.
  }
  listeners.forEach((l) => l());
}

export function useStatsHidden(): [boolean, (hidden: boolean) => void] {
  const hidden = useSyncExternalStore(subscribe, read, () => false);
  return [hidden, write];
}
