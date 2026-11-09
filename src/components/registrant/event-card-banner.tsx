import { EventBanner } from "@/components/public/event-banner";

/**
 * An event's banner across the top of its card on the portal pages (My events,
 * My certificates, My abstracts), so an event is recognised before it is read.
 * The mobile banner on a phone, the web banner wider up, whichever exists when
 * only one does (EventBanner, as on the event's own pages). Capped in height
 * and never cropped: a banner carries its own text. Renders nothing without one.
 */
export function EventCardBanner({ event }: { event: { name: string; bannerImage?: string | null; bannerImageMobile?: string | null } }) {
  if (!event.bannerImage && !event.bannerImageMobile) return null;
  return (
    <div className="flex justify-center border-b bg-white">
      <EventBanner banner={event.bannerImage} bannerMobile={event.bannerImageMobile} name={event.name} className="block h-auto max-h-44 w-auto max-w-full sm:max-h-36" />
    </div>
  );
}

/** Whether the card should sit flush under a banner (no top padding). */
export function hasEventBanner(event: { bannerImage?: string | null; bannerImageMobile?: string | null }): boolean {
  return Boolean(event.bannerImage || event.bannerImageMobile);
}
