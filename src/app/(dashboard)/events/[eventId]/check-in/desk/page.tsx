"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { LogOut, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEvent, useOrgBranding, useRegistrations } from "@/hooks/use-api";
import { DeskPanel } from "../desk-panel";

/**
 * The onsite desk on a page of its own (owner, Oct 29 2026): full screen, no
 * dashboard sidebar, so temp and in-house staff have one screen with two jobs,
 * find someone and admit them, or register a walk-in. Same confinement as the
 * rest of /check-in (src/lib/route-confinement.ts); every action goes through
 * the same routes as before. It opens from the Registrations page, and Exit
 * returns there. Branded (owner, Oct 29 2026): the organisation's logo in the
 * header and the event's banner above the desk, so staff and the people at the
 * desk see whose event this is.
 */
export default function DeskPage() {
  const eventId = useParams().eventId as string;
  const { data: event, isError } = useEvent(eventId);
  const { data: registrations = [] } = useRegistrations(eventId);
  const { data: branding } = useOrgBranding();
  // A banner whose file is missing is hidden rather than left as a strip of alt text.
  const [bannerFailed, setBannerFailed] = useState(false);

  const checkedIn = registrations.filter((r) => r.status === "CHECKED_IN").length;
  const total = registrations.filter((r) => r.status !== "CANCELLED").length;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-10 border-b bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            {branding?.logo && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={branding.logo}
                alt={branding.name || "Organisation"}
                className="h-10 max-w-[96px] shrink-0 object-contain border-r pr-3"
              />
            )}
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Registration desk</p>
              <h1 className="truncate text-lg font-semibold">{event?.name ?? (isError ? "Event not available" : "Loading…")}</h1>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-4">
            <div className="flex items-center gap-2 text-sm" aria-label="Checked in">
              <Users className="h-4 w-4 text-primary" />
              <span className="font-semibold tabular-nums text-primary">{checkedIn}</span>
              <span className="tabular-nums text-muted-foreground">/ {total} checked in</span>
            </div>
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <Link href={`/events/${eventId}/registrations`}>
                <LogOut className="h-4 w-4" /> Exit
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-4 px-4 py-4">
        {event?.bannerImage && !bannerFailed && (
          // Up to 224px tall, centred (owner, Oct 29 2026: 144px cut the top and
          // bottom off; the whole image is not needed, a taller band is).
          <picture className="block">
            {event.bannerImageMobile && <source media="(max-width: 575px)" srcSet={event.bannerImageMobile} />}
            <img
              src={event.bannerImage}
              alt={event.name}
              className="block max-h-56 w-full rounded-lg object-cover object-center shadow-sm"
              onError={() => setBannerFailed(true)}
            />
          </picture>
        )}
        {/* An event outside the person's grant (an ONSITE user not assigned to
            it) answers 404; say so rather than "Loading…" forever. */}
        {isError && !event && (
          <p className="rounded-lg border bg-white p-6 text-sm text-muted-foreground">
            This event could not be opened. You may not be assigned to it; ask an organiser, or use Exit.
          </p>
        )}
        {event && (
          <DeskPanel
            eventId={eventId}
            eventSlug={event.slug}
            tax={{ taxRate: event.taxRate == null ? null : Number(event.taxRate), taxLabel: event.taxLabel ?? null }}
            registrations={registrations}
          />
        )}
      </main>
    </div>
  );
}
