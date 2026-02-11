"use client";

import { useEffect, useState } from "react";

export function useDelayedLoading(isLoading: boolean, delayMs: number = 1000): boolean {
  const [showLoading, setShowLoading] = useState(false);

  useEffect(() => {
    if (!isLoading) {
      const resetTimeoutId = window.setTimeout(() => {
        setShowLoading(false);
      }, 0);

      return () => {
        window.clearTimeout(resetTimeoutId);
      };
    }

    const timeoutId = window.setTimeout(() => {
      setShowLoading(true);
    }, delayMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [delayMs, isLoading]);

  return showLoading;
}
