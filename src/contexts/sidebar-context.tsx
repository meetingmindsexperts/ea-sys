"use client";

import { createContext, useContext, useSyncExternalStore, ReactNode } from "react";

interface SidebarContextType {
  isCollapsed: boolean;
  toggleSidebar: () => void;
  setIsCollapsed: (collapsed: boolean) => void;
}

const SidebarContext = createContext<SidebarContextType | undefined>(undefined);

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

function getSnapshot(): boolean {
  return localStorage.getItem("sidebar-collapsed") === "true";
}

function getServerSnapshot(): boolean {
  return false;
}

function writeSidebar(value: boolean) {
  localStorage.setItem("sidebar-collapsed", String(value));
  // Notify same-tab subscribers (storage event only fires cross-tab natively)
  window.dispatchEvent(new Event("storage"));
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const isCollapsed = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggleSidebar = () => writeSidebar(!isCollapsed);
  const handleSetIsCollapsed = (collapsed: boolean) => writeSidebar(collapsed);

  return (
    <SidebarContext.Provider
      value={{
        isCollapsed,
        toggleSidebar,
        setIsCollapsed: handleSetIsCollapsed,
      }}
    >
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  const context = useContext(SidebarContext);
  if (context === undefined) {
    throw new Error("useSidebar must be used within a SidebarProvider");
  }
  return context;
}
