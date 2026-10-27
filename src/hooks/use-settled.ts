"use client";

import { useEffect, useState } from "react";

/**
 * A value that follows `value` once it has stopped changing for `ms`, so a
 * search box does not send a request per keystroke.
 */
export function useSettled<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}
