"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";

export type MediaView = "grid" | "list";

/**
 * Per-user, persisted grid/list preference for the media libraries (event +
 * org). Stored in localStorage keyed by the signed-in user's id, so each user
 * keeps their own choice — even on a shared browser — and it survives
 * navigation/reload (not session-only).
 *
 * The saved value is applied at render time once the session resolves (React's
 * "adjust state during render" pattern — guarded by a ref-like state so it runs
 * once per user, never an effect, no hydration mismatch since it's gated on the
 * client-only userId).
 */
export function useMediaView(): [MediaView, (v: MediaView) => void] {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  const storageKey = userId ? `ea-sys:media-view:${userId}` : null;

  const [view, setView] = useState<MediaView>("grid");
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);

  if (typeof window !== "undefined" && storageKey && hydratedKey !== storageKey) {
    setHydratedKey(storageKey);
    const saved = window.localStorage.getItem(storageKey);
    if (saved === "grid" || saved === "list") setView(saved);
  }

  const changeView = (v: MediaView) => {
    setView(v);
    if (typeof window !== "undefined" && storageKey) {
      window.localStorage.setItem(storageKey, v);
    }
  };

  return [view, changeView];
}
