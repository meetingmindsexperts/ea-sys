import { EventAccessGate } from "@/components/permissions/event-access-gate";
import { DraftEventBanner } from "@/components/events/draft-event-banner";

/**
 * Every event page: an event the person cannot open says so (owner, Oct 5,
 * 2026), and a draft says it is one until published (owner, Oct 8, 2026).
 */
export default function EventLayout({ children }: { children: React.ReactNode }) {
  return (
    <EventAccessGate>
      <DraftEventBanner />
      {children}
    </EventAccessGate>
  );
}
