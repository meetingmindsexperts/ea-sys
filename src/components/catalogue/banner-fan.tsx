"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * The catalogue hero's banner fan (Nov 5, 2026): the next listed events'
 * own banners, fanned like printed programmes, the front one changing every
 * few seconds with its name and date underneath. The banners are the
 * organisers' artwork, so the hero changes as events are listed.
 *
 * Still for visitors who ask for reduced motion, paused while hovered or
 * focused and while the tab is hidden. Every banner is also a card further
 * down the page, so the fan is a showcase and never the only way in.
 */

export interface FanItem {
  slug: string;
  name: string;
  image: string;
  /** "15–17 Jan · Dubai" */
  caption: string;
}

const CYCLE_MS = 4500;

export function BannerFan({ items }: { items: FanItem[] }) {
  const [front, setFront] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused || items.length < 2) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => {
      if (!document.hidden) setFront((f) => (f + 1) % items.length);
    }, CYCLE_MS);
    return () => window.clearInterval(id);
  }, [paused, items.length]);

  const current = items[front];
  return (
    <div
      className="mx-auto w-full max-w-[520px]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className="relative h-[210px] sm:h-[300px]" aria-hidden="true">
        {items.map((item, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={item.slug}
            src={item.image}
            alt=""
            data-pos={fanPosition(i, front, items.length)}
            className="catalogue-fan-card"
            fetchPriority={i === 0 ? "high" : "auto"}
          />
        ))}
      </div>
      <p className="mt-4 min-h-[1.5em] text-center font-mono text-xs tracking-wide text-white/85" aria-live="polite">
        <Link href={`/e/${current.slug}`} className="underline-offset-4 hover:text-white hover:underline">
          <span className="text-[#7fd8f3]">{current.caption}</span>
          <span className="hidden sm:inline"> · </span>
          <span className="block truncate sm:inline">{current.name}</span>
        </Link>
      </p>
      {items.length > 1 && (
        <div className="mt-2 flex justify-center gap-1.5">
          {items.map((item, i) => (
            <button
              key={item.slug}
              type="button"
              onClick={() => setFront(i)}
              aria-label={`Show ${item.name}`}
              aria-pressed={i === front}
              className={`h-1.5 rounded-full transition-all duration-300 ${i === front ? "w-5 bg-[#39c6f0]" : "w-1.5 bg-white/30 hover:bg-white/60"}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** "front", "right", "left", or "back" (hidden) for card i when card `front` leads. */
function fanPosition(i: number, front: number, n: number): string {
  const offset = (i - front + n) % n;
  if (offset === 0) return "front";
  if (offset === 1) return "right";
  if (offset === n - 1) return "left";
  return "back";
}
