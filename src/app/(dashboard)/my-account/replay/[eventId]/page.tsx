import Link from "next/link";
import { ArrowLeft, Clock, ExternalLink, PlayCircle, VideoOff } from "lucide-react";
import { formatEventDateRange } from "@/lib/event-time";
import { apiLogger } from "@/lib/logger";
import { loadRegistrantPortal } from "@/lib/registrant-portal";
import { loadPortalReplay, type PortalReplay } from "@/lib/registrant-replays";
import { ConfirmEmailNotice } from "@/components/registrant/confirm-email-notice";
import { ReplayPlayer } from "@/components/webinar/replay-player";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/typography";

/**
 * A webinar's replay in the person's own portal (Nov 10, 2026): where the Watch replay button on
 * My events and the thank-you email's replay button lead.
 *
 * It lives in the portal because the webinar's public page stops answering once the organiser
 * marks the event Completed. Who may watch and which replay is registrant-replays.ts's answer,
 * read inside the portal's tenant lane; this page only shows it.
 */

/** An event id as the database mints them. Anything else is not looked up, and never reaches the sign-in return path. */
const EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export default async function ReplayPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId: raw } = await params;
  const eventId = EVENT_ID.test(raw) ? raw : null;
  const { scope, data: replay } = await loadRegistrantPortal<PortalReplay>(
    eventId ? `/my-account/replay/${eventId}` : "/my-account",
    async (s) => (eventId ? loadPortalReplay(s, eventId, new Date()) : { state: "not-registered" }),
  );

  if (replay.state === "not-registered") {
    apiLogger.warn({ msg: "registrant-replay:not-registered", eventId, userId: scope.userId });
  } else if (replay.state === "none") {
    apiLogger.warn({ msg: "registrant-replay:not-available", eventId, userId: scope.userId, expected: replay.expected });
  } else {
    apiLogger.info({ msg: "registrant-replay:served", eventId, userId: scope.userId, kind: replay.state });
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 sm:space-y-6 sm:py-2">
      <Link href="/my-account" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
        <ArrowLeft className="h-4 w-4" aria-hidden />
        My events
      </Link>

      {replay.state === "not-registered" ? (
        <>
          <PageHeader title="Replay" />
          {/* Registrations made earlier under this address appear once it is confirmed. */}
          {!scope.confirmed && <ConfirmEmailNotice email={scope.email} />}
          <Notice
            icon={VideoOff}
            title="We could not find this replay"
            text={`No confirmed registration for this webinar is linked to ${scope.email}.`}
          />
        </>
      ) : (
        <>
          <PageHeader
            title={replay.event.name}
            description={`Replay · ${formatEventDateRange(replay.event.startDate, replay.event.endDate, replay.event.timezone)}`}
          />
          <ReplayBody replay={replay} />
        </>
      )}
    </div>
  );
}

function ReplayBody({ replay }: { replay: Exclude<PortalReplay, { state: "not-registered" }> }) {
  if (replay.state === "embed") return <ReplayPlayer embedUrl={replay.embedUrl} title={replay.event.name} />;
  if (replay.state === "zoom") {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-10 text-center sm:flex-row sm:text-left">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-emerald-100">
            <PlayCircle className="h-7 w-7 text-emerald-700" aria-hidden />
          </span>
          <div className="flex-1 space-y-1">
            <p className="text-lg font-semibold">Recording available</p>
            <p className="text-sm text-muted-foreground">It opens on Zoom, in a new tab.</p>
            {replay.password && (
              <p className="text-sm text-muted-foreground">
                Passcode: <span className="font-mono text-foreground">{replay.password}</span>
              </p>
            )}
          </div>
          <Button asChild size="lg" className="h-11 w-full sm:w-auto">
            <a href={replay.url} target="_blank" rel="noopener noreferrer">
              <PlayCircle className="mr-1.5 h-5 w-5" aria-hidden />
              Watch replay
              <ExternalLink className="ml-1.5 h-4 w-4" aria-hidden />
            </a>
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (replay.expected) {
    return <Notice icon={Clock} title="The replay is not ready yet" text="The organiser is preparing it. Please check back later." />;
  }
  return <Notice icon={VideoOff} title="No replay is offered for this webinar" text="The organiser has not made a recording available." />;
}

function Notice({ icon: Icon, title, text }: { icon: typeof Clock; title: string; text: string }) {
  return (
    <Card>
      <CardContent className="space-y-2 py-12 text-center">
        <Icon className="mx-auto h-10 w-10 text-muted-foreground/40" aria-hidden />
        <p className="font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{text}</p>
      </CardContent>
    </Card>
  );
}
