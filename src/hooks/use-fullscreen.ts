"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { resolveFullscreenApi } from "@/lib/fullscreen";

export interface UseFullscreen {
  /** Native fullscreen OR the in-page fallback is active. */
  isFullscreen: boolean;
  /**
   * The in-page fallback is active. The browser could not make the element
   * fullscreen (iPhone Safari has no element fullscreen), so the caller pins
   * the element to the viewport itself, typically `fixed inset-0 z-50`.
   */
  isFallback: boolean;
  toggle: () => Promise<void>;
  exit: () => Promise<void>;
}

/**
 * Fullscreen for a player container, shared by the Zoom embed and the HLS
 * player.
 *
 * Native Fullscreen API when the browser allows it, otherwise the in-page
 * fallback, so the control works on a phone too. State follows the browser
 * (`fullscreenchange`) rather than the click: the HLS player used to flip its
 * flag optimistically, so leaving with Esc left the icon on "exit". Esc is
 * honoured in the fallback as well, and the page behind it stops scrolling.
 *
 * Unmounting while fullscreen leaves fullscreen: Zoom's own Leave button
 * unmounts the embed, and the attendee must not be left staring at a black
 * screen with no way back.
 */
export function useFullscreen(ref: RefObject<HTMLElement | null>): UseFullscreen {
  const [isNative, setIsNative] = useState(false);
  const [isFallback, setIsFallback] = useState(false);
  // The element we put into native fullscreen. Kept separately because React
  // clears `ref.current` before the unmount cleanup runs.
  const enteredRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onChange = () => {
      const el = ref.current;
      const api = el ? resolveFullscreenApi(el) : null;
      const active = Boolean(el && api && api.current() === el);
      setIsNative(active);
      if (!active) enteredRef.current = null;
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, [ref]);

  useEffect(() => {
    if (!isFallback) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsFallback(false);
    };
    window.addEventListener("keydown", onKey);
    const previous = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.documentElement.style.overflow = previous;
    };
  }, [isFallback]);

  useEffect(
    () => () => {
      const el = enteredRef.current;
      if (!el) return;
      const api = resolveFullscreenApi(el);
      if (!api || api.current() !== el) return;
      api.exit().catch((err) => console.warn("fullscreen:exit-on-unmount-failed", err));
    },
    [],
  );

  const exit = useCallback(async () => {
    setIsFallback(false);
    const el = enteredRef.current ?? ref.current;
    const api = el ? resolveFullscreenApi(el) : null;
    enteredRef.current = null;
    if (!api || !api.current()) return;
    try {
      await api.exit();
    } catch (err) {
      console.warn("fullscreen:exit-failed", err);
    }
  }, [ref]);

  const toggle = useCallback(async () => {
    if (isNative || isFallback) {
      await exit();
      return;
    }
    const el = ref.current;
    if (!el) return;
    const api = resolveFullscreenApi(el);
    if (api) {
      try {
        await api.request();
        enteredRef.current = el;
        return;
      } catch (err) {
        // Refused (policy, user gesture lost, unsupported after all): the
        // in-page fallback below still gives the viewer a big player.
        console.warn("fullscreen:native-refused", err);
      }
    }
    setIsFallback(true);
  }, [exit, isFallback, isNative, ref]);

  return { isFullscreen: isNative || isFallback, isFallback, toggle, exit };
}
