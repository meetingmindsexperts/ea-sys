import { EventAccessGate } from "@/components/permissions/event-access-gate";

/** Every event page: an event the person cannot open says so (owner, Oct 5, 2026). */
export default function EventLayout({ children }: { children: React.ReactNode }) {
  return <EventAccessGate>{children}</EventAccessGate>;
}
