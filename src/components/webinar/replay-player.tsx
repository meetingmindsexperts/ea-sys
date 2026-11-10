"use client";

/**
 * The organiser's uploaded replay, played in the page (Nov 10, 2026). The address comes from the
 * registration-gated recording route and is always a Vimeo player built from a parsed video id
 * (webinar/replay-video.ts), never pasted text.
 *
 * The referrer is sent on purpose: Vimeo's "embed on specific domains" privacy setting, which
 * keeps the video from playing anywhere but this site, reads it.
 */
import { useEffect, useRef } from "react";
import { Card } from "@/components/ui/card";

export function ReplayPlayer({
  embedUrl,
  title,
  bringIntoView = false,
}: {
  embedUrl: string;
  title: string;
  /** The webinar page loads it from a button that can sit below the fold. Elsewhere it is the
   *  page's own content and scrolling to it would push the title away. */
  bringIntoView?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (bringIntoView) ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [embedUrl, bringIntoView]);

  return (
    // Never taller than the window: at full width on a wide screen a 16:9 frame would be, and the
    // controls would sit below the fold. Capped by height, so a phone keeps the full width.
    <Card ref={ref} className="mx-auto w-full max-w-[calc(80vh*16/9)] gap-0 overflow-hidden py-0 shadow-sm">
      <div className="relative aspect-video w-full bg-black">
        <iframe
          src={embedUrl}
          title={`Replay of ${title}`}
          className="absolute inset-0 h-full w-full"
          // encrypted-media is required, not a nicety: without it Vimeo's player loads and then
          // answers Play with "Unable to play video" (seen in the browser, Nov 10, 2026; its own page
          // plays the same video). `allow` alone: with it set, the browser ignores, and warns about,
          // allowFullScreen.
          allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    </Card>
  );
}
