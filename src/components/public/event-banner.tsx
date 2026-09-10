/**
 * Public event banner with responsive art-direction.
 *
 * Renders a `<picture>`: when a mobile banner is set it's served on screens
 * below 576px (phones), and the main `banner` shows at 576px and above. With no
 * mobile banner it degrades to the main banner at every breakpoint — identical
 * to the previous single-`<img>` behaviour. Only the matching image downloads.
 *
 * A plain `<img>` (not next/image) is used deliberately: next/image can't do
 * `<picture>`/`<source media>` art-direction, and the auth pages already ran
 * their banners `unoptimized`, so nothing is lost. The caller keeps its own
 * wrapper + passes the img `className` so each page's layout is unchanged.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type EventBannerProps = {
  banner: string | null | undefined;
  bannerMobile?: string | null;
  name: string;
  /** Applied to the <img> — pass the same classes the page used before. */
  className?: string;
  /** Sets fetchPriority="high" (above-the-fold banners). */
  priority?: boolean;
};

export function EventBanner({ banner, bannerMobile, name, className, priority }: EventBannerProps) {
  // Desktop source is the main banner; fall back to the mobile one if that's
  // the only image provided so a banner still renders everywhere.
  const primary = banner || bannerMobile;
  if (!primary) return null;

  return (
    <picture>
      {bannerMobile && banner && (
        <source media="(max-width: 575.98px)" srcSet={bannerMobile} />
      )}
      <img
        src={primary}
        alt={name}
        className={className}
        {...(priority ? { fetchPriority: "high" as const } : {})}
      />
    </picture>
  );
}

/**
 * The banner strip at the top of every public page: the branding banner at its
 * natural aspect, capped at 1400px and centred, on a white band that runs the
 * full page width. The cap lives HERE and nowhere else. By August 2026 four
 * different widths had accumulated across the public pages (1400 / 1120 / 1024
 * / uncapped), and on September 10, 2026 the owner set one rule: 1400px,
 * centred, on every public page that shows the branding header. A page that
 * inlines its own `<EventBanner>` wrapper fails the drift test.
 *
 * Renders nothing when the event has no banner at all, so a caller that wants
 * a fallback (the thin gradient stripe) keeps its own conditional.
 */
export const PUBLIC_BANNER_MAX_WIDTH_CLASS = "max-w-[1400px]";

type EventBannerBandProps = {
  banner: string | null | undefined;
  bannerMobile?: string | null;
  name: string;
  /** Extra classes for the outer full-width strip (a border, `print:hidden`). */
  className?: string;
  /** Rendered inside the strip, below the image (an accent line, for example). */
  children?: ReactNode;
  /** Above-the-fold by default; pass false for a banner rendered lower down. */
  priority?: boolean;
};

export function EventBannerBand({
  banner,
  bannerMobile,
  name,
  className,
  children,
  priority = true,
}: EventBannerBandProps) {
  if (!banner && !bannerMobile) return null;
  return (
    <div className={cn("relative w-full bg-white", className)}>
      <div className={cn(PUBLIC_BANNER_MAX_WIDTH_CLASS, "mx-auto")}>
        <EventBanner
          banner={banner}
          bannerMobile={bannerMobile}
          name={name}
          className="block w-full h-auto"
          priority={priority}
        />
      </div>
      {children}
    </div>
  );
}
