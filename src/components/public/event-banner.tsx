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
