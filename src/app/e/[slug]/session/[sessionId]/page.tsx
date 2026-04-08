"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const LivePlayer = dynamic(
  () => import("@/components/zoom/live-player").then((m) => ({ default: m.LivePlayer })),
  { ssr: false },
);
import {
  Video,
  ExternalLink,
  Clock,
  MapPin,
  Users,
  Loader2,
  ArrowLeft,
  Calendar,
  Shield,
} from "lucide-react";
import { format } from "date-fns";
import Link from "next/link";
import Image from "next/image";

interface JoinInfo {
  mode: "sdk" | "url";
  sdkKey?: string;
  signature?: string;
  meetingNumber?: string;
  passcode?: string;
  joinUrl: string;
  meetingType: string;
  sessionName: string;
  liveStreamEnabled?: boolean;
  hlsPlaybackUrl?: string;
  streamStatus?: string;
}

interface SpeakerInfo {
  id: string;
  firstName: string;
  lastName: string;
  jobTitle?: string;
  organization?: string;
  photo?: string;
}

interface SessionDetail {
  name: string;
  description?: string;
  startTime: string;
  endTime: string;
  location?: string;
  capacity?: number;
  status: string;
  speakers: SpeakerInfo[];
  track?: { name: string; color: string };
}

interface EventDetail {
  name: string;
  slug: string;
  bannerImage?: string;
  organization?: { name: string; logo?: string };
}

export default function PublicSessionPage() {
  const params = useParams<{ slug: string; sessionId: string }>();
  const { slug, sessionId } = params;

  const [joinInfo, setJoinInfo] = useState<JoinInfo | null>(null);
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joinableAt, setJoinableAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        // Fetch join info and session details in parallel
        const [joinRes, detailRes] = await Promise.all([
          fetch(`/api/public/events/${slug}/sessions/${sessionId}/zoom-join`),
          fetch(`/api/public/events/${slug}/sessions/${sessionId}/detail`),
        ]);

        const joinData = await joinRes.json();

        if (joinRes.ok) {
          setJoinInfo(joinData);
        } else {
          // Not joinable yet — show the landing page anyway
          if (joinData.joinableAt) {
            setJoinableAt(joinData.joinableAt);
          }
        }

        if (detailRes.ok) {
          const detailData = await detailRes.json();
          setSession(detailData.session);
          setEvent(detailData.event);
        } else {
          // Fallback — try schedule API
          try {
            const scheduleRes = await fetch(`/api/public/events/${slug}/schedule`);
            if (scheduleRes.ok) {
              const scheduleData = await scheduleRes.json();
              setEvent({ name: scheduleData.name, slug: scheduleData.slug });
              const s = scheduleData.eventSessions?.find(
                (s: { id: string }) => s.id === sessionId,
              );
              if (s) {
                setSession({
                  name: s.name,
                  description: s.description,
                  startTime: s.startTime,
                  endTime: s.endTime,
                  location: s.location,
                  capacity: s.capacity,
                  status: s.status,
                  speakers: s.speakers?.map((sp: { speaker: SpeakerInfo }) => sp.speaker) || [],
                  track: s.track,
                });
              }
            }
          } catch {
            // Non-critical
          }
        }

        // If we have nothing at all
        if (!joinRes.ok && !detailRes.ok) {
          setError(joinData.error || "Session not found");
        }
      } catch {
        setError("Failed to load session. Please try again.");
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [slug, sessionId]);

  // Determine session timing status
  const now = Date.now();
  const startMs = session ? new Date(session.startTime).getTime() : 0;
  const endMs = session ? new Date(session.endTime).getTime() : 0;
  const isLive = session?.status === "LIVE" || (now >= startMs && now <= endMs);
  const isPast = now > endMs && endMs > 0;
  const isUpcoming = startMs > now;

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-slate-50 to-blue-50">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-10 w-10 animate-spin text-blue-600" />
          <p className="text-muted-foreground">Loading session...</p>
        </div>
      </div>
    );
  }

  if (error && !session) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-slate-50 to-blue-50">
        <Card className="max-w-md w-full mx-4 shadow-lg">
          <CardContent className="flex flex-col items-center gap-4 pt-8 pb-6 text-center">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
              <Video className="h-8 w-8 text-muted-foreground" />
            </div>
            <h2 className="text-lg font-semibold">Session Not Available</h2>
            <p className="text-sm text-muted-foreground">{error}</p>
            <Link href={`/e/${slug}/schedule`}>
              <Button variant="outline" className="gap-2">
                <ArrowLeft className="h-4 w-4" />
                Back to Schedule
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50">
      {/* Event banner / header */}
      <div className="bg-white border-b">
        {event?.bannerImage && (
          <div className="w-full h-32 md:h-48 relative overflow-hidden">
            <Image
              src={event.bannerImage}
              alt={event.name}
              fill
              className="object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
          </div>
        )}
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex items-center gap-3">
            <Link
              href={`/e/${slug}/schedule`}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div>
              {event?.organization?.name && (
                <p className="text-xs text-muted-foreground">{event.organization.name}</p>
              )}
              <p className="text-sm font-medium text-muted-foreground">{event?.name}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left — Session info + Join */}
          <div className="lg:col-span-2 space-y-6">
            {/* Session header */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                {isLive && (
                  <Badge className="bg-green-100 text-green-800 border-green-200 gap-1">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
                    Live Now
                  </Badge>
                )}
                {isUpcoming && !joinInfo && (
                  <Badge variant="outline" className="text-blue-700 border-blue-200 bg-blue-50">
                    Upcoming
                  </Badge>
                )}
                {isPast && (
                  <Badge variant="secondary">Ended</Badge>
                )}
                {session?.track && (
                  <Badge
                    variant="outline"
                    style={{ borderColor: session.track.color, color: session.track.color }}
                  >
                    {session.track.name}
                  </Badge>
                )}
                {joinInfo && (
                  <Badge variant="outline" className="text-blue-600 border-blue-200 gap-1">
                    <Video className="h-3 w-3" />
                    {joinInfo.meetingType === "WEBINAR" || joinInfo.meetingType === "WEBINAR_SERIES"
                      ? "Webinar"
                      : "Meeting"}
                  </Badge>
                )}
              </div>

              <h1 className="text-2xl md:text-3xl font-bold text-foreground">
                {session?.name || joinInfo?.sessionName || "Session"}
              </h1>

              {session && (
                <div className="flex flex-wrap items-center gap-4 mt-3 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Calendar className="h-4 w-4" />
                    {format(new Date(session.startTime), "EEEE, MMMM d, yyyy")}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Clock className="h-4 w-4" />
                    {format(new Date(session.startTime), "h:mm a")} &ndash;{" "}
                    {format(new Date(session.endTime), "h:mm a")}
                  </span>
                  {session.location && (
                    <span className="flex items-center gap-1.5">
                      <MapPin className="h-4 w-4" />
                      {session.location}
                    </span>
                  )}
                  {session.capacity && (
                    <span className="flex items-center gap-1.5">
                      <Users className="h-4 w-4" />
                      {session.capacity} seats
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Live stream player */}
            {joinInfo?.liveStreamEnabled && (
              <LivePlayer
                hlsUrl={joinInfo.hlsPlaybackUrl || ""}
                slug={slug}
                sessionId={sessionId}
                sessionName={session?.name || joinInfo.sessionName}
              />
            )}

            {/* Join button — prominent CTA (shown when no live stream, or as fallback) */}
            {joinInfo && (
              <Card className={`border-blue-200 bg-blue-50/50 shadow-sm ${joinInfo.liveStreamEnabled ? "mt-2" : ""}`}>
                <CardContent className="flex flex-col sm:flex-row items-center gap-4 py-6">
                  <div className="w-14 h-14 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                    <Video className="h-7 w-7 text-blue-600" />
                  </div>
                  <div className="flex-1 text-center sm:text-left">
                    <p className="font-semibold text-lg">
                      {joinInfo.liveStreamEnabled ? "Want to participate?" : "Ready to join?"}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {joinInfo.liveStreamEnabled
                        ? "Join via Zoom to interact with speakers (audio/video). Or watch the live stream above."
                        : joinInfo.meetingType === "WEBINAR" || joinInfo.meetingType === "WEBINAR_SERIES"
                          ? "This webinar will open in Zoom. You can watch as an attendee."
                          : "This meeting will open in Zoom. You can participate with audio and video."}
                    </p>
                  </div>
                  <Button
                    size="lg"
                    className="gap-2 bg-blue-600 hover:bg-blue-700 text-white px-8 shadow-md"
                    onClick={() => window.open(joinInfo.joinUrl, "_blank")}
                  >
                    <Video className="h-5 w-5" />
                    {joinInfo.liveStreamEnabled ? "Join in Zoom" : "Join Meeting"}
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Not yet joinable */}
            {!joinInfo && joinableAt && (
              <Card className="border-amber-200 bg-amber-50/50">
                <CardContent className="flex flex-col items-center gap-3 py-6 text-center">
                  <Clock className="h-8 w-8 text-amber-600" />
                  <p className="font-medium">Session hasn&apos;t started yet</p>
                  <p className="text-sm text-muted-foreground">
                    The join button will appear at{" "}
                    <strong>{format(new Date(joinableAt), "h:mm a 'on' MMM d")}</strong>
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Description */}
            {session?.description && (
              <div>
                <h2 className="text-lg font-semibold mb-2">About this session</h2>
                <p className="text-muted-foreground leading-relaxed">{session.description}</p>
              </div>
            )}
          </div>

          {/* Right sidebar */}
          <div className="space-y-4">
            {/* Speakers */}
            {session?.speakers && session.speakers.length > 0 && (
              <Card>
                <CardContent className="pt-5">
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
                    <Users className="h-4 w-4 text-blue-600" />
                    Speakers
                  </h3>
                  <div className="space-y-3">
                    {session.speakers.map((speaker) => (
                      <div key={speaker.id} className="flex items-center gap-3">
                        {speaker.photo ? (
                          <Image
                            src={speaker.photo}
                            alt={`${speaker.firstName} ${speaker.lastName}`}
                            width={40}
                            height={40}
                            className="rounded-full object-cover"
                          />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-white text-sm font-medium">
                            {speaker.firstName[0]}
                            {speaker.lastName[0]}
                          </div>
                        )}
                        <div>
                          <p className="text-sm font-medium">
                            {speaker.firstName} {speaker.lastName}
                          </p>
                          {(speaker.jobTitle || speaker.organization) && (
                            <p className="text-xs text-muted-foreground">
                              {[speaker.jobTitle, speaker.organization].filter(Boolean).join(" at ")}
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Meeting details */}
            {joinInfo && (
              <Card>
                <CardContent className="pt-5">
                  <h3 className="text-sm font-semibold mb-3">Meeting Details</h3>
                  <dl className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Type</dt>
                      <dd className="font-medium">
                        {joinInfo.meetingType === "WEBINAR" || joinInfo.meetingType === "WEBINAR_SERIES"
                          ? "Webinar"
                          : "Meeting"}
                      </dd>
                    </div>
                    {joinInfo.meetingNumber && (
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Meeting ID</dt>
                        <dd className="font-mono text-xs">{joinInfo.meetingNumber}</dd>
                      </div>
                    )}
                    {joinInfo.passcode && (
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Passcode</dt>
                        <dd className="font-mono text-xs">{joinInfo.passcode}</dd>
                      </div>
                    )}
                  </dl>
                </CardContent>
              </Card>
            )}

            {/* Info note */}
            <Card className="border-slate-200">
              <CardContent className="pt-5">
                <div className="flex gap-2">
                  <Shield className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                  <p className="text-xs text-muted-foreground">
                    This session is powered by Zoom. Clicking &ldquo;Join Meeting&rdquo; will open the Zoom app or web client.
                    You may need to sign in to your Zoom account.
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
