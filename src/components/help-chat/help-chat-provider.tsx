/**
 * Provider that mounts the help-chat drawer once at the dashboard
 * layout root and exposes a `useHelpChatLauncher()` hook so any nested
 * client component (the sidebar Help button in particular) can open it.
 *
 * Why a context rather than direct prop drilling: the trigger (sidebar)
 * and the drawer live in different places in the layout tree, and the
 * trigger doesn't care about the open/close state — it only needs to
 * fire "open". Keeping the state local to this provider keeps the
 * sidebar dumb (it doesn't carry chat state) and the dashboard layout
 * server-component clean (only this one client wrapper inside it).
 */

"use client";

import { createContext, useContext, useMemo, useState } from "react";
import { HelpChatSheet } from "./help-chat-sheet";

interface HelpChatLauncher {
  /** Open the help-chat drawer. Idempotent. */
  open: () => void;
}

const HelpChatContext = createContext<HelpChatLauncher | null>(null);

export function HelpChatProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  const launcher = useMemo<HelpChatLauncher>(
    () => ({ open: () => setIsOpen(true) }),
    [],
  );

  return (
    <HelpChatContext.Provider value={launcher}>
      {children}
      <HelpChatSheet open={isOpen} onOpenChange={setIsOpen} />
    </HelpChatContext.Provider>
  );
}

/**
 * Throws if used outside `HelpChatProvider` — fail-fast since a button
 * silently failing to open the drawer would be a confusing UX bug.
 */
export function useHelpChatLauncher(): HelpChatLauncher {
  const ctx = useContext(HelpChatContext);
  if (!ctx) {
    throw new Error(
      "useHelpChatLauncher must be used inside <HelpChatProvider>",
    );
  }
  // Identity is stable because `launcher` is memoized with [] above —
  // safe to pass `ctx.open` directly to onClick without re-rendering.
  return ctx;
}
