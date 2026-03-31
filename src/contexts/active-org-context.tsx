"use client";

import { createContext, useContext, useState, useCallback, useSyncExternalStore } from "react";
import { useSession } from "next-auth/react";

interface ActiveOrgContextValue {
  /** The org ID to use for data scoping. null = user's own org. */
  activeOrgId: string | null;
  /** Switch to a different org (SUPER_ADMIN only). Pass null to reset to own org. */
  setActiveOrgId: (orgId: string | null) => void;
  /** The effective org ID (active override or session org). */
  effectiveOrgId: string | null;
  /** Whether the user is viewing a different org than their own. */
  isOrgOverride: boolean;
}

const ActiveOrgContext = createContext<ActiveOrgContextValue>({
  activeOrgId: null,
  setActiveOrgId: () => {},
  effectiveOrgId: null,
  isOrgOverride: false,
});

const STORAGE_KEY = "ea-sys:active-org-id";

// Use useSyncExternalStore for localStorage to avoid hydration mismatch
let listeners: Array<() => void> = [];

function subscribeStorage(cb: () => void) {
  listeners.push(cb);
  return () => { listeners = listeners.filter((l) => l !== cb); };
}

function getStorageValue() {
  return localStorage.getItem(STORAGE_KEY);
}

function getServerValue() {
  return null;
}

function setStorageValue(value: string | null) {
  if (value) {
    localStorage.setItem(STORAGE_KEY, value);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
  listeners.forEach((l) => l());
}

export function ActiveOrgProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const isSuperAdmin = session?.user?.role === "SUPER_ADMIN";

  const storedOrgId = useSyncExternalStore(subscribeStorage, getStorageValue, getServerValue);

  // Non-SUPER_ADMIN users never have an override
  const activeOrgId = isSuperAdmin ? storedOrgId : null;

  // If user lost SUPER_ADMIN status but still has a stored value, clear it
  const [cleared, setCleared] = useState(false);
  if (!isSuperAdmin && storedOrgId && !cleared) {
    setStorageValue(null);
    setCleared(true);
  }

  const setActiveOrgId = useCallback(
    (orgId: string | null) => {
      if (!isSuperAdmin) return;
      setStorageValue(orgId);
    },
    [isSuperAdmin]
  );

  const sessionOrgId = session?.user?.organizationId ?? null;
  const effectiveOrgId = activeOrgId || sessionOrgId;
  const isOrgOverride = isSuperAdmin && !!activeOrgId && activeOrgId !== sessionOrgId;

  return (
    <ActiveOrgContext.Provider value={{ activeOrgId, setActiveOrgId, effectiveOrgId, isOrgOverride }}>
      {children}
    </ActiveOrgContext.Provider>
  );
}

export function useActiveOrg() {
  return useContext(ActiveOrgContext);
}
