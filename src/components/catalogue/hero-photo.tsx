"use client";

import { useState } from "react";

/**
 * The catalogue hero's photo under its navy wash. If the file is gone (removed
 * from the media library, which does not track this reference) it removes
 * itself and the ECG pattern beneath shows instead of a broken image.
 */
export function HeroPhoto({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        fetchPriority="high"
        className="absolute inset-0 h-full w-full object-cover"
        onError={() => {
          console.warn("catalogue:hero-photo-failed", src);
          setFailed(true);
        }}
      />
      {/* The wash keeps the headline readable over any photo. */}
      <div className="absolute inset-0 bg-[linear-gradient(100deg,rgb(10_28_46/0.96)_0%,rgb(10_28_46/0.84)_40%,rgb(10_28_46/0.6)_70%,rgb(10_28_46/0.72)_100%)]" />
    </>
  );
}
