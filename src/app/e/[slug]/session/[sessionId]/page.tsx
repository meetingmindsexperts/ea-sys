"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Video,
  ExternalLink,
  Clock,
  MapPin,
  Users,
  Loader2,
  ArrowLeft,
  Calendar,
  PlayCircle,
  Award,
  ListOrdered,
  LogIn,
  UserPlus,
} from "lucide-react";
import type { SponsorEntry } from "@/lib/webinar";
import { WaitingRoom } from "@/components/webinar/waiting-room";
import { formatPersonName } from "@/lib/utils";
import {
  DEFAULT_EVENT_TIMEZONE,
  formatDateInTz,
  formatTimeInTz,
  resolveTimezone,
  tzLabel,
} from "@/lib/event-time";
import { formatSessionRole, formatSessionType } from "@/lib/session-enums";

/**
 * "9:00 AM GST on Jun 15" — join-availability timestamps must render in the
 * EVENT's timezone like every other time on this page. They used to render
 * viewer-local, telling a New York attendee a Dubai 9:00 AM session "opens
 * at 1:00 AM" (L4, program/agenda review).
 */
function formatJoinOpens(instant: Date, timezone: string) {
  const monthDay = new Intl.DateTimeFormat("en-US", {
    timeZone: resolveTimezone(timezone),
    month: "short",
    day: "numeric",
  }).format(instant);
  const lbl = tzLabel(instant, timezone);
  return `${formatTimeInTz(instant, timezone)}${lbl ? ` ${lbl}` : ""} on ${monthDay}`;
}

// The live-stream player is client-only (hls.js pulls ArrayBuffer refs
// from window) so we dynamically import it. The Zoom Component View embed
// is ALSO dynamically imported to keep the ~3 MB SDK bundle out of this
// page's initial JS payload — users who never open a webinar never
// download it.
const LivePlayer = dynamic(
  () => import("@/components/zoom/live-player").then((m) => ({ default: m.LivePlayer })),
  { ssr: false },
);
const ZoomWebEmbed = dynamic(
  () =>
    import("@/components/zoom/zoom-web-embed").then((m) => ({
      default: m.ZoomWebEmbed,
    })),
  { ssr: false },
);

// ── Types mirroring the detail API response ──────────────────────

interface JoinInfo {
  mode: "sdk" | "url";
  sdkKey?: string;
  signature?: string;
  meetingNumber?: string;
  passcode?: string;
  joinUrl: string;
  meetingType: string;
  sessionName: string;
  userName?: string;
  userEmail?: string;
  liveStreamEnabled?: boolean;
  hlsPlaybackUrl?: string;
  streamStatus?: string;
}

type JoinAuthState =
  | { kind: "ok" }
  | { kind: "needs-login" }
  | { kind: "needs-registration" };

interface LobbyStatus {
  roomOpen: boolean;
  ended: boolean;
  viewingMode: "zoom" | "hls";
  lobbyVideoUrl: string | null;
  lobbyMessage: string | null;
  startsAt: string;
  endsAt: string;
}

interface SpeakerInfo {
  id: string;
  title?: string | null;
  firstName: string;
  lastName: string;
  jobTitle?: string | null;
  organization?: string | null;
  photo?: string | null;
  bio?: string | null;
  role?: string;
}

interface TopicInfo {
  id: string;
  title: string;
  sortOrder: number;
  duration: number | null;
  speakers: Array<{
    id: string;
    title?: string | null;
    firstName: string;
    lastName: string;
    photo?: string | null;
    jobTitle?: string | null;
    organization?: string | null;
  }>;
}

interface SessionDetail {
  id: string;
  name: string;
  description?: string | null;
  startTime: string;
  endTime: string;
  location?: string | null;
  capacity?: number | null;
  status: string;
  type?: string;
  speakers: SpeakerInfo[];
  topics: TopicInfo[];
  track?: { name: string; color: string } | null;
  zoomMeeting?: {
    // B2: recordingUrl + recordingPassword are no longer served by the public
    // detail route. They come from the registration-gated `../recording` route.
    recordingStatus:
      | "NOT_REQUESTED"
      | "PENDING"
      | "AVAILABLE"
      | "FAILED"
      | "EXPIRED";
  } | null;
}

interface EventDetail {
  name: string;
  slug: string;
  eventType?: string | null;
  bannerImage?: string;
  timezone?: string | null;
  organization?: { name: string; logo?: string };
}

const SPONSOR_TIER_ORDER: Record<string, number> = {
  platinum: 0,
  gold: 1,
  silver: 2,
  bronze: 3,
  partner: 4,
  exhibitor: 5,
};

const SPONSOR_TIER_LABELS: Record<string, string> = {
  platinum: "Platinum",
  gold: "Gold",
  silver: "Silver",
  bronze: "Bronze",
  partner: "Partners",
  exhibitor: "Exhibitors",
};

// ── Page ────────────────────────────────────────────────────────

export default function PublicSessionPage() {
  const params = useParams<{ slug: string; sessionId: string }>();
  const { slug, sessionId } = params;

  const [joinInfo, setJoinInfo] = useState<JoinInfo | null>(null);
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [sponsors, setSponsors] = useState<SponsorEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [joinableAt, setJoinableAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // "isJoining" means the user has clicked Join and the embed is mounted.
  // We don't auto-mount the embed on page load because we don't want to
  // pull the ~3 MB Zoom bundle for users just looking at session details.
  const [isJoining, setIsJoining] = useState(false);
  // B2: the recording URL + passcode are credentials. They're fetched on demand
  // from the registration-gated route, never shipped with the public payload.
  const [recording, setRecording] = useState<{ url: string; password: string | null } | null>(null);
  const [recordingLoading, setRecordingLoading] = useState(false);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  // Tracks whether the current viewer is allowed to pull an SDK signature.
  // The zoom-join endpoint is gated to logged-in registrants of the event,
  // so unauthenticated or unregistered visitors see a login / register CTA
  // in place of the Join button instead of an error screen.
  const [authState, setAuthState] = useState<JoinAuthState>({ kind: "ok" });
  // Webinar waiting-room state, polled from lobby-status. Null until the first
  // poll resolves (and only polled for WEBINAR events with a registered viewer).
  const [lobby, setLobby] = useState<LobbyStatus | null>(null);
  // Ensures the "room just opened → admit" side-effects fire once per opening.
  const admittedRef = useRef(false);

  useEffect(() => {
    async function fetchData() {
      try {
        const [joinRes, detailRes] = await Promise.all([
          fetch(`/api/public/events/${slug}/sessions/${sessionId}/zoom-join`),
          fetch(`/api/public/events/${slug}/sessions/${sessionId}/detail`),
        ]);

        const joinData = await joinRes.json();

        if (joinRes.ok) {
          setJoinInfo(joinData);
        } else if (joinRes.status === 401 || joinData.code === "UNAUTHENTICATED") {
          setAuthState({ kind: "needs-login" });
        } else if (joinData.code === "NOT_REGISTERED") {
          setAuthState({ kind: "needs-registration" });
        } else if (joinData.joinableAt) {
          setJoinableAt(joinData.joinableAt);
        }

        if (detailRes.ok) {
          const detailData = await detailRes.json();
          setSession(detailData.session);
          setEvent(detailData.event);
          if (Array.isArray(detailData.sponsors)) {
            setSponsors(detailData.sponsors);
          }
        } else if (!joinRes.ok) {
          console.error("session-page:load-failed", joinRes.status, detailRes.status);
          setError(joinData.error || "Session not found");
        }
      } catch (err) {
        console.error("session-page:load-failed", err);
        setError("Failed to load session. Please try again.");
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [slug, sessionId]);

  // Webinar waiting room: poll lobby-status to learn when the producer opens
  // the room. Only for WEBINAR events, and only once the viewer is a confirmed
  // registrant (authState "ok") — unregistered visitors see the sign-in CTA,
  // not the lobby. lobby-status is public + cached, so this scales to 5k.
  const isWebinarEvent = event?.eventType === "WEBINAR";
  useEffect(() => {
    if (!isWebinarEvent || authState.kind !== "ok") return;
    let active = true;
    async function poll() {
      try {
        const res = await fetch(
          `/api/public/events/${slug}/sessions/${sessionId}/lobby-status`,
        );
        if (res.ok && active) setLobby((await res.json()) as LobbyStatus);
      } catch {
        // transient — keep the last known state, retry next tick
      }
    }
    poll();
    // Jittered ~15–20s so a 5k crowd doesn't poll in lockstep.
    const id = setInterval(poll, 15000 + Math.floor(Math.random() * 5000));
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [isWebinarEvent, authState.kind, slug, sessionId]);

  const roomOpen = Boolean(lobby?.roomOpen);

  // Reset the once-per-open admit latch when the producer CLOSES the room, so a
  // subsequent re-open re-admits everyone still on the page, and demote anyone
  // currently in the embed back to the lobby/paused view (review #4).
  const prevRoomOpenRef = useRef(false);
  useEffect(() => {
    if (prevRoomOpenRef.current && !roomOpen) {
      admittedRef.current = false;
      setIsJoining(false);
    }
    prevRoomOpenRef.current = roomOpen;
  }, [roomOpen]);

  // When the room opens, admit the attendee: ALWAYS re-mint join creds (a
  // signature minted at page load is likely expired after a long lobby wait —
  // review #8), then for Zoom-embed mode auto-mount the embed (with the
  // "Join now" CTA as the gesture fallback). The HLS branch renders from the
  // refreshed joinInfo. On a failed re-fetch, release the latch so the next
  // lobby poll retries instead of dead-ending (review #M-2).
  useEffect(() => {
    if (!isWebinarEvent || !roomOpen || admittedRef.current) return;
    admittedRef.current = true;
    (async () => {
      try {
        const res = await fetch(
          `/api/public/events/${slug}/sessions/${sessionId}/zoom-join`,
        );
        if (res.ok) {
          setJoinInfo((await res.json()) as JoinInfo);
          if (lobby?.viewingMode === "zoom") setIsJoining(true);
        } else {
          admittedRef.current = false; // retry on the next lobby poll
        }
      } catch {
        admittedRef.current = false; // transient — retry on the next poll
      }
    })();
  }, [isWebinarEvent, roomOpen, lobby?.viewingMode, slug, sessionId]);

  // Presence heartbeat: while a registered attendee has the webinar page open,
  // beat every ~30–40s (jittered) so organizers see who's in the lobby / joined
  // in real time (within the 60s "present" window). Paused while the tab is
  // hidden; phase reflects whether they've been admitted. Read isJoining via a
  // ref so the interval stays stable across admit transitions.
  const isJoiningRef = useRef(isJoining);
  isJoiningRef.current = isJoining;
  useEffect(() => {
    if (!isWebinarEvent || authState.kind !== "ok") return;
    async function beat() {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        await fetch(
          `/api/public/events/${slug}/sessions/${sessionId}/presence`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phase: isJoiningRef.current ? "joined" : "lobby" }),
          },
        );
      } catch {
        // tolerate transient failures — next beat retries
      }
    }
    beat();
    const onVis = () => {
      if (document.visibilityState === "visible") beat();
    };
    document.addEventListener("visibilitychange", onVis);
    const id = setInterval(beat, 30000 + Math.floor(Math.random() * 10000));
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(id);
    };
  }, [isWebinarEvent, authState.kind, slug, sessionId]);

  // Determine session timing status
  const now = Date.now();
  const startMs = session ? new Date(session.startTime).getTime() : 0;
  const endMs = session ? new Date(session.endTime).getTime() : 0;
  const isLive = session?.status === "LIVE" || (now >= startMs && now <= endMs);
  const isPast = now > endMs && endMs > 0;
  const isUpcoming = startMs > now;
  // Webinars routinely overrun their scheduled slot. While the producer has the
  // room OPEN, don't tear the live view down just because wall-clock passed the
  // scheduled end time — keep the HLS/embed alive until they actually close the
  // room (review #9). Falls back to plain wall-clock when not a managed room.
  const liveWindowActive = !isPast || (isWebinarEvent && roomOpen);

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
            <Link href={`/e/${slug}/agenda`}>
              <Button variant="outline" className="gap-2">
                <ArrowLeft className="h-4 w-4" />
                Back to Agenda
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  /**
   * Fetch the recording credential from the registration-gated route and open
   * it. The tab is opened SYNCHRONOUSLY on the click so popup blockers don't
   * swallow it, then pointed at the URL once the fetch resolves (and closed if
   * the caller turns out not to be authorized).
   */
  async function handleWatchRecording() {
    if (recordingLoading) return;
    if (recording) {
      window.open(recording.url, "_blank");
      return;
    }
    const tab = window.open("", "_blank");
    setRecordingLoading(true);
    setRecordingError(null);
    try {
      const res = await fetch(
        `/api/public/events/${slug}/sessions/${sessionId}/recording`,
      );
      if (!res.ok) {
        tab?.close();
        const data = await res.json().catch(() => ({}) as { code?: string });
        if (res.status === 401) {
          setRecordingError("Please sign in to watch the recording.");
          window.location.href = `/e/${slug}/login?redirect=${encodeURIComponent(
            `/e/${slug}/session/${sessionId}`,
          )}`;
          return;
        }
        setRecordingError(
          data.code === "NOT_REGISTERED"
            ? "You must be registered for this event to watch the recording."
            : "Couldn't load the recording. Please try again.",
        );
        console.error("recording fetch failed", res.status, data);
        return;
      }
      const data: { recordingUrl: string; recordingPassword: string | null } = await res.json();
      setRecording({ url: data.recordingUrl, password: data.recordingPassword });
      if (tab) tab.location.href = data.recordingUrl;
      else window.open(data.recordingUrl, "_blank");
    } catch (err) {
      tab?.close();
      console.error("recording fetch error", err);
      setRecordingError("Couldn't load the recording. Please try again.");
    } finally {
      setRecordingLoading(false);
    }
  }

  const hasRecording = session?.zoomMeeting?.recordingStatus === "AVAILABLE";
  const isRecordingProcessing =
    isPast &&
    !hasRecording &&
    (session?.zoomMeeting?.recordingStatus === "PENDING" ||
      session?.zoomMeeting?.recordingStatus === "NOT_REQUESTED");

  // The zoom-join endpoint returns the real attendee name/email for the
  // authenticated registration. Fall back to "Attendee" only if the API
  // response was older or staff-initiated without an email on the user.
  const zoomUserName = joinInfo?.userName?.trim() || "Attendee";
  const zoomUserEmail = joinInfo?.userEmail || "";

  // Show the branded waiting room when: this is a webinar, the viewer is a
  // confirmed registrant, lobby state has loaded, the producer has NOT opened
  // the room, and we're not past the scheduled end / replayable. Keyed on
  // `!isPast` (wall-clock end), NOT `lobby.ended` — so a producer who CLOSES
  // the room mid-event (status COMPLETED before end time) sends attendees back
  // to the lobby (paused) rather than a dead-end, and a re-open re-admits them
  // (review #4).
  const showWaitingRoom =
    isWebinarEvent &&
    authState.kind === "ok" &&
    lobby !== null &&
    !roomOpen &&
    !isPast &&
    !hasRecording;

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
        <div className="max-w-5xl mx-auto px-4 py-4">
          <div className="flex items-center gap-3">
            <Link
              href={`/e/${slug}/agenda`}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div>
              <p className="text-sm font-medium text-muted-foreground">{event?.name}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {/* Session title + metadata */}
        <div>
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            {isLive && (
              <Badge className="bg-green-100 text-green-800 border-green-200 gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
                Live Now
              </Badge>
            )}
            {isUpcoming && (
              <Badge variant="outline" className="text-blue-700 border-blue-200 bg-blue-50">
                Upcoming
              </Badge>
            )}
            {isPast && <Badge variant="secondary">Ended</Badge>}
            {session?.track && (
              <Badge
                variant="outline"
                style={{ borderColor: session.track.color, color: session.track.color }}
              >
                {session.track.name}
              </Badge>
            )}
            {(session?.type === "WORKSHOP" || session?.type === "SYMPOSIUM") && (
              <Badge variant="secondary">{formatSessionType(session.type)}</Badge>
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
                {formatDateInTz(new Date(session.startTime), event?.timezone ?? DEFAULT_EVENT_TIMEZONE)}
              </span>
              <span className="flex items-center gap-1.5">
                <Clock className="h-4 w-4" />
                {formatTimeInTz(new Date(session.startTime), event?.timezone ?? DEFAULT_EVENT_TIMEZONE)} &ndash;{" "}
                {formatTimeInTz(new Date(session.endTime), event?.timezone ?? DEFAULT_EVENT_TIMEZONE)}
                {(() => {
                  const lbl = tzLabel(new Date(session.startTime), event?.timezone ?? DEFAULT_EVENT_TIMEZONE);
                  return lbl ? <span className="text-muted-foreground/70"> {lbl}</span> : null;
                })()}
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

        {/* Sticky CTA — stays pinned at the top of the content area so the
             primary action is always visible regardless of which tab the
             user scrolled to. `top-0 z-10` keeps it above the tabs while
             scrolling; the `-mx-4 px-4` bleed plus backdrop-blur prevents
             content from showing through when the user scrolls past the
             session header. */}
        <div className="sticky top-0 z-10 -mx-4 px-4 py-2 bg-gradient-to-br from-slate-50/90 to-blue-50/90 backdrop-blur-sm">
          <StickyCta
            slug={slug}
            sessionId={sessionId}
            isLive={isLive}
            isPast={isPast}
            isUpcoming={isUpcoming}
            joinableAt={joinableAt}
            timezone={event?.timezone ?? DEFAULT_EVENT_TIMEZONE}
            joinInfo={joinInfo}
            authState={authState}
            hasRecording={hasRecording}
            recordingPassword={recording?.password ?? null}
            recordingLoading={recordingLoading}
            onWatchRecording={handleWatchRecording}
            isJoining={isJoining}
            onJoin={() => setIsJoining(true)}
            onLeave={() => setIsJoining(false)}
          />
        </div>

        {/* Tabs */}
        <Tabs defaultValue="video" className="space-y-4">
          <TabsList>
            <TabsTrigger value="video" className="gap-2">
              <Video className="h-4 w-4" />
              Live Video
            </TabsTrigger>
            <TabsTrigger value="details" className="gap-2">
              <ListOrdered className="h-4 w-4" />
              Session Details
            </TabsTrigger>
            <TabsTrigger value="sponsors" className="gap-2">
              <Award className="h-4 w-4" />
              Sponsors
            </TabsTrigger>
          </TabsList>

          {/* Tab 1 — Live Video */}
          <TabsContent value="video" className="space-y-4">
            {showWaitingRoom && lobby ? (
              <WaitingRoom
                startsAt={lobby.startsAt}
                lobbyVideoUrl={lobby.lobbyVideoUrl}
                lobbyMessage={lobby.lobbyMessage}
                posterUrl={event?.bannerImage}
              />
            ) : (
              <>
            {/* Config-mismatch guard: organizer chose "Custom stream" but the
                 session has no live stream enabled / stream key, so neither the
                 HLS player nor the Zoom embed would render — show a clear
                 "stream not ready" state instead of a blank tab (review #5). */}
            {roomOpen &&
            lobby?.viewingMode === "hls" &&
            joinInfo &&
            !joinInfo.liveStreamEnabled &&
            liveWindowActive &&
            !hasRecording ? (
              <Card className="border-amber-200 bg-amber-50/50">
                <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
                  <Loader2 className="h-8 w-8 text-amber-600 animate-spin" />
                  <p className="font-medium text-lg">Getting the stream ready…</p>
                  <p className="text-sm text-muted-foreground max-w-md">
                    The live stream for this session isn&apos;t available yet. Please keep this
                    page open — it&apos;ll appear here automatically once it starts.
                  </p>
                </CardContent>
              </Card>
            ) : null}

            {/* HLS stream takes precedence when configured — it's the
                 branded full-screen experience. Stays mounted past the
                 scheduled end while the room is open (overrun, review #9). */}
            {joinInfo?.liveStreamEnabled && liveWindowActive && (
              <LivePlayer
                hlsUrl={joinInfo.hlsPlaybackUrl || ""}
                slug={slug}
                sessionId={sessionId}
                sessionName={session?.name || joinInfo.sessionName}
              />
            )}

            {/* Embedded Zoom — only mounts after user clicks Join in the
                 sticky CTA. This keeps the 3 MB SDK bundle off first load. */}
            {isJoining &&
              joinInfo?.mode === "sdk" &&
              joinInfo.sdkKey &&
              joinInfo.signature &&
              joinInfo.meetingNumber && (
                <ZoomWebEmbed
                  sdkKey={joinInfo.sdkKey}
                  signature={joinInfo.signature}
                  meetingNumber={joinInfo.meetingNumber}
                  passcode={joinInfo.passcode || ""}
                  userName={zoomUserName}
                  userEmail={zoomUserEmail}
                  joinUrl={joinInfo.joinUrl}
                  onLeave={() => setIsJoining(false)}
                />
              )}

            {/* Recording replay */}
            {hasRecording && !isJoining && (
              <Card className="border-emerald-200 bg-emerald-50/50 shadow-sm">
                <CardContent className="flex flex-col sm:flex-row items-center gap-4 py-6">
                  <div className="w-14 h-14 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
                    <PlayCircle className="h-7 w-7 text-emerald-600" />
                  </div>
                  <div className="flex-1 text-center sm:text-left">
                    <p className="font-semibold text-lg">Recording available</p>
                    <p className="text-sm text-muted-foreground">
                      Missed the live session? Watch the recording on Zoom.
                    </p>
                    {recordingError && (
                      <p className="text-xs text-red-600 mt-1">{recordingError}</p>
                    )}
                    {recording?.password && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Passcode:{" "}
                        <span className="font-mono">
                          {recording.password}
                        </span>
                      </p>
                    )}
                  </div>
                  <Button
                    size="lg"
                    className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-8 shadow-md"
                    onClick={handleWatchRecording}
                    disabled={recordingLoading}
                  >
                    <PlayCircle className="h-5 w-5" />
                    {recordingLoading ? "Loading…" : "Watch Replay"}
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Recording processing placeholder */}
            {isRecordingProcessing && !isJoining && (
              <Card className="border-amber-200 bg-amber-50/50">
                <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                  <Loader2 className="h-8 w-8 text-amber-600 animate-spin" />
                  <p className="font-medium">Recording processing</p>
                  <p className="text-sm text-muted-foreground">
                    The replay will be available here shortly. Check back in a few minutes.
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Upcoming session placeholder — no embed, no recording */}
            {isUpcoming && !joinInfo?.liveStreamEnabled && (
              <Card className="border-slate-200 bg-white">
                <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
                  <div className="w-16 h-16 rounded-full bg-blue-100 flex items-center justify-center">
                    <Clock className="h-8 w-8 text-blue-600" />
                  </div>
                  <p className="font-medium text-lg">Session hasn&apos;t started yet</p>
                  <p className="text-sm text-muted-foreground max-w-md">
                    {joinableAt
                      ? `You'll be able to join at ${formatJoinOpens(new Date(joinableAt), event?.timezone ?? DEFAULT_EVENT_TIMEZONE)}.`
                      : `Check back shortly before ${formatTimeInTz(new Date(startMs), event?.timezone ?? DEFAULT_EVENT_TIMEZONE)} ${tzLabel(new Date(startMs), event?.timezone ?? DEFAULT_EVENT_TIMEZONE)}.`}
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Live but user hasn't clicked Join yet — render a placeholder
                 that reinforces the CTA above rather than a blank space */}
            {(isLive || (isUpcoming && joinInfo)) &&
              !isJoining &&
              !joinInfo?.liveStreamEnabled &&
              !hasRecording &&
              !isRecordingProcessing && (
                <Card className="border-slate-200 bg-white">
                  <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
                    <div className="w-16 h-16 rounded-full bg-blue-100 flex items-center justify-center">
                      <Video className="h-8 w-8 text-blue-600" />
                    </div>
                    <p className="font-medium text-lg">Ready to join?</p>
                    <p className="text-sm text-muted-foreground max-w-md">
                      Click <strong>Join Webinar</strong> above to open the embedded
                      meeting right here on this page.
                    </p>
                  </CardContent>
                </Card>
              )}
              </>
            )}
          </TabsContent>

          {/* Tab 2 — Session Details */}
          <TabsContent value="details" className="space-y-6">
            {session?.description && (
              <section>
                <h2 className="text-lg font-semibold mb-2">About this session</h2>
                <p className="text-muted-foreground leading-relaxed whitespace-pre-wrap">
                  {session.description}
                </p>
              </section>
            )}

            {session && session.topics.length > 0 && (
              <section>
                <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
                  <ListOrdered className="h-5 w-5 text-blue-600" />
                  Topics
                </h2>
                <ol className="space-y-3">
                  {session.topics.map((topic, idx) => (
                    <li
                      key={topic.id}
                      className="border rounded-lg bg-white p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm">
                            <span className="text-muted-foreground mr-2">
                              {idx + 1}.
                            </span>
                            {topic.title}
                          </p>
                          {topic.duration ? (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {topic.duration} min
                            </p>
                          ) : null}
                        </div>
                      </div>
                      {topic.speakers.length > 0 && (
                        <div className="flex flex-wrap gap-2 mt-3">
                          {topic.speakers.map((sp) => (
                            <div
                              key={sp.id}
                              className="flex items-center gap-2 text-xs text-muted-foreground"
                            >
                              {sp.photo ? (
                                <Image
                                  src={sp.photo}
                                  alt={formatPersonName(sp.title, sp.firstName, sp.lastName)}
                                  width={20}
                                  height={20}
                                  className="rounded-full object-cover"
                                />
                              ) : (
                                <div className="w-5 h-5 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-white text-[10px] font-medium">
                                  {sp.firstName[0]}
                                </div>
                              )}
                              <span>
                                {formatPersonName(sp.title, sp.firstName, sp.lastName)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {session && session.speakers.length > 0 && (
              <section>
                <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
                  <Users className="h-5 w-5 text-blue-600" />
                  Speakers
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {session.speakers.map((speaker) => (
                    <div
                      key={speaker.id}
                      className="border rounded-lg bg-white p-4 flex gap-3"
                    >
                      {speaker.photo ? (
                        <Image
                          src={speaker.photo}
                          alt={formatPersonName(speaker.title, speaker.firstName, speaker.lastName)}
                          width={64}
                          height={64}
                          className="rounded-full object-cover h-16 w-16 shrink-0"
                        />
                      ) : (
                        <div className="w-16 h-16 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-white text-base font-medium shrink-0">
                          {speaker.firstName[0]}
                          {speaker.lastName[0]}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        {speaker.role && speaker.role !== "SPEAKER" && (
                          <span className="inline-block mb-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                            {formatSessionRole(speaker.role)}
                          </span>
                        )}
                        <p className="font-medium">
                          {formatPersonName(speaker.title, speaker.firstName, speaker.lastName)}
                        </p>
                        {(speaker.jobTitle || speaker.organization) && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {[speaker.jobTitle, speaker.organization]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        )}
                        {speaker.bio && (
                          <p className="text-xs text-muted-foreground mt-2 line-clamp-4">
                            {speaker.bio}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {!session?.description &&
              (!session || session.topics.length === 0) &&
              (!session || session.speakers.length === 0) && (
                <div className="text-center py-12 text-sm text-muted-foreground">
                  No additional details for this session yet.
                </div>
              )}
          </TabsContent>

          {/* Tab 3 — Sponsors */}
          <TabsContent value="sponsors">
            <SponsorsTab sponsors={sponsors} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

// ── Sticky CTA card ────────────────────────────────────────────

function StickyCta({
  slug,
  sessionId,
  isLive,
  isPast,
  isUpcoming,
  joinableAt,
  timezone,
  joinInfo,
  authState,
  hasRecording,
  recordingPassword,
  recordingLoading,
  onWatchRecording,
  isJoining,
  onJoin,
  onLeave,
}: {
  slug: string;
  sessionId: string;
  isLive: boolean;
  isPast: boolean;
  isUpcoming: boolean;
  joinableAt: string | null;
  timezone: string;
  joinInfo: JoinInfo | null;
  authState: JoinAuthState;
  hasRecording: boolean;
  recordingPassword: string | null;
  recordingLoading: boolean;
  onWatchRecording: () => void;
  isJoining: boolean;
  onJoin: () => void;
  onLeave: () => void;
}) {
  // Ended + recording → Watch Replay
  if (isPast && hasRecording) {
    return (
      <Card className="border-emerald-200 bg-emerald-50/70 shadow-sm">
        <CardContent className="flex flex-col sm:flex-row items-center gap-4 py-4">
          <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
            <PlayCircle className="h-6 w-6 text-emerald-600" />
          </div>
          <div className="flex-1 text-center sm:text-left">
            <p className="font-semibold">Recording available</p>
            {recordingPassword && (
              <p className="text-xs text-muted-foreground">
                Passcode: <span className="font-mono">{recordingPassword}</span>
              </p>
            )}
          </div>
          <Button
            className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
            onClick={onWatchRecording}
            disabled={recordingLoading}
          >
            <PlayCircle className="h-4 w-4" />
            {recordingLoading ? "Loading…" : "Watch Replay"}
            <ExternalLink className="h-4 w-4" />
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Ended + no recording → muted banner
  if (isPast) {
    return (
      <Card className="border-slate-200 bg-slate-50/70">
        <CardContent className="flex items-center gap-3 py-4">
          <Clock className="h-5 w-5 text-muted-foreground shrink-0" />
          <p className="text-sm text-muted-foreground flex-1">
            This session has ended.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Live or upcoming, but the viewer is not signed in — show a login CTA.
  // The zoom-join endpoint is gated to logged-in registrants, so there's
  // no way to get an SDK signature without this step.
  if (!joinInfo && authState.kind === "needs-login" && !isPast) {
    const redirectTarget = `/e/${slug}/session/${sessionId}`;
    return (
      <Card className="border-blue-200 bg-blue-50/70 shadow-sm">
        <CardContent className="flex flex-col sm:flex-row items-center gap-4 py-4">
          <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
            <LogIn className="h-6 w-6 text-blue-600" />
          </div>
          <div className="flex-1 text-center sm:text-left">
            <p className="font-semibold">Sign in to join</p>
            <p className="text-xs text-muted-foreground">
              This webinar is open to registered attendees only.
            </p>
          </div>
          <Link href={`/e/${slug}/login?redirect=${encodeURIComponent(redirectTarget)}`}>
            <Button
              size="lg"
              className="gap-2 bg-blue-600 hover:bg-blue-700 text-white"
            >
              <LogIn className="h-4 w-4" />
              Sign in
            </Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  // Live or upcoming, viewer is signed in but not registered for this event.
  if (!joinInfo && authState.kind === "needs-registration" && !isPast) {
    return (
      <Card className="border-amber-200 bg-amber-50/70 shadow-sm">
        <CardContent className="flex flex-col sm:flex-row items-center gap-4 py-4">
          <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
            <UserPlus className="h-6 w-6 text-amber-600" />
          </div>
          <div className="flex-1 text-center sm:text-left">
            <p className="font-semibold">Register to join</p>
            <p className="text-xs text-muted-foreground">
              You must be registered for this event before joining the webinar.
            </p>
          </div>
          <Link href={`/e/${slug}/register`}>
            <Button
              size="lg"
              className="gap-2 bg-amber-600 hover:bg-amber-700 text-white"
            >
              <UserPlus className="h-4 w-4" />
              Register
            </Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  // Upcoming, not yet joinable
  if (isUpcoming && !joinInfo) {
    return (
      <Card className="border-amber-200 bg-amber-50/70">
        <CardContent className="flex items-center gap-3 py-4">
          <Clock className="h-5 w-5 text-amber-600 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium">Session hasn&apos;t started yet</p>
            {joinableAt && (
              <p className="text-xs text-muted-foreground">
                Join opens at {formatJoinOpens(new Date(joinableAt), timezone)}
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  // Live or upcoming-and-joinable — Join CTA
  if (joinInfo) {
    const isWebinar =
      joinInfo.meetingType === "WEBINAR" ||
      joinInfo.meetingType === "WEBINAR_SERIES";
    const canEmbed = joinInfo.mode === "sdk" && joinInfo.sdkKey && joinInfo.signature;

    return (
      <Card className="border-blue-200 bg-blue-50/70 shadow-sm">
        <CardContent className="flex flex-col sm:flex-row items-center gap-4 py-4">
          <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
            {isLive ? (
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500"></span>
              </span>
            ) : (
              <Video className="h-6 w-6 text-blue-600" />
            )}
          </div>
          <div className="flex-1 text-center sm:text-left">
            <p className="font-semibold">
              {isLive ? "Live now" : "Ready to join"}
            </p>
            <p className="text-xs text-muted-foreground">
              {canEmbed
                ? `Join the ${isWebinar ? "webinar" : "meeting"} without leaving this page.`
                : `This ${isWebinar ? "webinar" : "meeting"} will open in Zoom.`}
            </p>
          </div>
          {isJoining ? (
            <div className="flex items-center gap-2">
              <Badge className="bg-green-100 text-green-800 border-green-200">
                In meeting
              </Badge>
              <Button
                size="sm"
                variant="outline"
                onClick={onLeave}
                title="Unmount the embed and return to the session page"
              >
                Leave
              </Button>
            </div>
          ) : canEmbed ? (
            <Button
              size="lg"
              className="gap-2 bg-blue-600 hover:bg-blue-700 text-white"
              onClick={onJoin}
            >
              <Video className="h-4 w-4" />
              {isWebinar ? "Join Webinar" : "Join Meeting"}
            </Button>
          ) : (
            <Button
              size="lg"
              className="gap-2 bg-blue-600 hover:bg-blue-700 text-white"
              onClick={() => window.open(joinInfo.joinUrl, "_blank")}
            >
              <Video className="h-4 w-4" />
              {isWebinar ? "Join Webinar" : "Join Meeting"}
              <ExternalLink className="h-4 w-4" />
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  return null;
}

// ── Sponsors tab ───────────────────────────────────────────────

function SponsorsTab({ sponsors }: { sponsors: SponsorEntry[] }) {
  if (sponsors.length === 0) {
    return (
      <div className="text-center py-16 text-sm text-muted-foreground">
        <Award className="h-10 w-10 mx-auto mb-2 opacity-40" />
        No sponsors for this event yet.
      </div>
    );
  }

  // Group by tier for visual priority
  const grouped = new Map<string, SponsorEntry[]>();
  for (const sponsor of sponsors) {
    const tier = sponsor.tier ?? "partner";
    const list = grouped.get(tier) ?? [];
    list.push(sponsor);
    grouped.set(tier, list);
  }

  const tierOrder = Array.from(grouped.keys()).sort(
    (a, b) => (SPONSOR_TIER_ORDER[a] ?? 999) - (SPONSOR_TIER_ORDER[b] ?? 999),
  );

  return (
    <div className="space-y-8">
      {tierOrder.map((tier) => {
        const tierSponsors = grouped.get(tier) ?? [];
        return (
          <section key={tier}>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
              {SPONSOR_TIER_LABELS[tier] ?? tier}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
              {tierSponsors.map((sponsor) => {
                const card = (
                  <div className="border rounded-lg bg-white p-4 h-full flex flex-col items-center text-center hover:border-blue-300 hover:shadow-md transition-all">
                    {sponsor.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={sponsor.logoUrl}
                        alt={sponsor.name}
                        className="h-16 object-contain mb-3"
                      />
                    ) : (
                      <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center mb-3">
                        <Award className="h-6 w-6 text-muted-foreground" />
                      </div>
                    )}
                    <p className="font-semibold">{sponsor.name}</p>
                    {sponsor.description && (
                      <p className="text-xs text-muted-foreground mt-2 line-clamp-3">
                        {sponsor.description}
                      </p>
                    )}
                  </div>
                );
                return sponsor.websiteUrl ? (
                  <a
                    key={sponsor.id}
                    href={sponsor.websiteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block"
                  >
                    {card}
                  </a>
                ) : (
                  <div key={sponsor.id}>{card}</div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
