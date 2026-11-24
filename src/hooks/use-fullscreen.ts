"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  lockDocumentScroll,
  lockLandscape,
  resolveFullscreenApi,
  resolveVideoFullscreen,
  unlockOrientation,
} from "@/lib/fullscreen";

export interface UseFullscreen {
  /** Native fullscreen OR the in-page fallback is active. */
  isFullscreen: boolean;
  /**
   * The in-page fallback is active. The browser could not make the element
   * fullscreen (iPhone Safari has no element fullscreen), so the caller pins
   * the element to the viewport itself, typically `fixed inset-0 z-50`.
   */
  isFallback: boolean;
  /**
   * The video is in Apple's own full screen player (iPhone; only with the
   * `video` option). The page's own controls are not on screen meanwhile.
   */
  isVideoFullscreen: boolean;
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
 *
 * Two options for a player of a 16:9 video (the HLS player; Nov 24, 2026,
 * owner: "mobile full screen can be improved"), left off for the Zoom embed,
 * whose panel is not a video:
 * - `video`: where the element cannot go fullscreen (iPhone), hand the video
 *   to Apple's own full screen player before falling back to the in-page box.
 * - `landscape`: once fullscreen, turn a phone sideways (Android), so the
 *   picture fills the screen instead of a third of it.
 */
export function useFullscreen(
  ref: RefObject<HTMLElement | null>,
  options: { video?: RefObject<HTMLVideoElement | null>; landscape?: boolean } = {},
): UseFullscreen {
  const { video: videoRef, landscape = false } = options;
  const [isNative, setIsNative] = useState(false);
  const [isFallback, setIsFallback] = useState(false);
  const [isVideoFullscreen, setIsVideoFullscreen] = useState(false);
  // We turned the phone sideways and owe it an unlock on the way out.
  const lockedRef = useRef(false);
  // The element we put into native fullscreen. Kept separately because React
  // clears `ref.current` before the unmount cleanup runs.
  const enteredRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onChange = () => {
      const el = ref.current;
      const api = el ? resolveFullscreenApi(el) : null;
      const active = Boolean(el && api && api.current() === el);
      setIsNative(active);
      if (active) return;
      enteredRef.current = null;
      if (lockedRef.current) {
        lockedRef.current = false;
        unlockOrientation(window);
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, [ref]);

  // Apple's player says when it opens and closes; Done, a swipe down or the
  // phone's own controls all close it without asking us.
  useEffect(() => {
    const video = videoRef?.current;
    if (!video) return;
    const onBegin = () => setIsVideoFullscreen(true);
    const onEnd = () => {
      setIsVideoFullscreen(false);
      // Some iPhones pause the video on Done. A live broadcast has nothing to
      // pause for (the player has no Pause button), so it carries on inline.
      if (video.paused) video.play().catch((err) => console.warn("fullscreen:resume-after-video-fullscreen-failed", err));
    };
    video.addEventListener("webkitbeginfullscreen", onBegin);
    video.addEventListener("webkitendfullscreen", onEnd);
    return () => {
      video.removeEventListener("webkitbeginfullscreen", onBegin);
      video.removeEventListener("webkitendfullscreen", onEnd);
    };
  }, [videoRef]);

  useEffect(() => {
    if (!isFallback) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsFallback(false);
    };
    window.addEventListener("keydown", onKey);
    // Body-pinning lock: `overflow: hidden` on the document does not stop
    // touch scrolling on iOS Safari, the platform this fallback exists for
    // (review, Oct 1, 2026).
    const unlock = lockDocumentScroll(document, window);
    return () => {
      window.removeEventListener("keydown", onKey);
      unlock();
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
    const videoApi = resolveVideoFullscreen(videoRef?.current ?? null);
    if (videoApi?.active()) videoApi.exit();
    if (lockedRef.current) {
      lockedRef.current = false;
      unlockOrientation(window);
    }
    const el = enteredRef.current ?? ref.current;
    const api = el ? resolveFullscreenApi(el) : null;
    enteredRef.current = null;
    if (!api || !api.current()) return;
    try {
      await api.exit();
    } catch (err) {
      console.warn("fullscreen:exit-failed", err);
    }
  }, [ref, videoRef]);

  const toggle = useCallback(async () => {
    if (isNative || isFallback || isVideoFullscreen) {
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
        if (landscape) lockedRef.current = await lockLandscape(window);
        return;
      } catch (err) {
        // Refused (policy, user gesture lost, unsupported after all): the
        // in-page fallback below still gives the viewer a big player.
        console.warn("fullscreen:native-refused", err);
      }
    }
    const videoApi = resolveVideoFullscreen(videoRef?.current ?? null);
    if (videoApi) {
      try {
        videoApi.enter();
        return;
      } catch (err) {
        console.warn("fullscreen:video-fullscreen-refused", err);
      }
    }
    setIsFallback(true);
  }, [exit, isFallback, isNative, isVideoFullscreen, landscape, ref, videoRef]);

  return { isFullscreen: isNative || isFallback || isVideoFullscreen, isFallback, isVideoFullscreen, toggle, exit };
}
