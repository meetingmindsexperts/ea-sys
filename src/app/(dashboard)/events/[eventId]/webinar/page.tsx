"use client";

import { useCan } from "@/hooks/use-can";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DEFAULT_EVENT_TIMEZONE, formatTimeInTz, tzLabel } from "@/lib/event-time";
import { useParams } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Video,
  Copy,
  PlayCircle,
  ExternalLink,
  RotateCw,
  AlertCircle,
  Loader2,
  Calendar,
  Mail,
  CheckCircle2,
  Clock,
  XCircle,
  Users,
  Download,
  UserPlus,
  Trash2,
  BarChart3,
  MessageSquare,
  Wrench,
  LineChart,
  Film,
  Settings as SettingsIcon,
  CircleDot,
  CheckCircle,
  Radio,
  Eye,
  EyeOff,
  ThumbsUp,
  Plus,
  X,
  FileText,
  Upload,
  ArrowUp,
  ArrowDown,
  Palette,
  ClipboardList,
} from "lucide-react";
import { StreamDelay } from "@/components/webinar/stream-delay";
import { ChatModerationPanel } from "@/components/webinar/chat-moderation-panel";
import { PartnerStreamCard, partnerSignalLabel } from "@/components/webinar/partner-stream-card";
import type { PlayerTimingSample } from "@/components/zoom/live-player";
import { useServerClock } from "@/hooks/use-server-clock";
import {
  MAX_POLL_OPTIONS,
  MIN_POLL_OPTIONS,
  POLL_OPTION_MAX,
  POLL_QUESTION_MAX,
  percentOf,
} from "@/lib/webinar/live-polls";
import {
  HANDOUT_ACCEPT,
  MAX_HANDOUTS,
  MAX_HANDOUT_MB,
  formatHandoutSize,
  type WebinarHandout,
} from "@/lib/webinar/handouts";
import {
  useWebinar,
  useUpdateWebinarSettings,
  useToggleWebinarRoom,
  useWebinarLiveStream,
  useWebinarStreamPreview,
  useWebinarPartnerStream,
  useWebinarViewerQuestions,
  type WebinarViewerQuestionRow,
  type WebinarRemovedViewer,
  useUpdateWebinarViewerQuestion,
  useWebinarPresence,
  useSetWebinarViewerRemoved,
  useWebinarStreamTimeline,
  type WebinarStreamTimelineEntry,
  useEventSurveys,
  useUploadWebinarHandout,
  useLivePolls,
  useCreateLivePoll,
  useUpdateLivePoll,
  useDeleteLivePoll,
  type LivePollRow,
  useReorderWebinarHandouts,
  useDeleteWebinarHandout,
  useProvisionWebinar,
  useWebinarSequence,
  useScheduleWebinarSequence,
  useFetchWebinarRecording,
  useSyncWebinarAttendance,
  useSyncWebinarEngagement,
  useWebinarPanelists,
  useAddWebinarPanelist,
  useRemoveWebinarPanelist,
  useSyncSpeakersToPanelists,
  useResendPanelistInvite,
  OPTIMISTIC_PANELIST_PREFIX,
  type WebinarConsoleData,
  type WebinarSequenceRow,
  type WebinarPanelist,
} from "@/hooks/use-api";
import { PHASE_RULES, SEQUENCE_PHASES, defaultPhaseChoices, describePhaseTime, type PhaseChoice, type SequencePhase } from "@/lib/webinar-sequence-plan";
import { toast } from "sonner";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import { isValidLobbyVideoUrl } from "@/lib/webinar/lobby-video";
import { parseReplayVideo, REPLAY_LINK_MESSAGE } from "@/lib/webinar/replay-video";
import { ReplayPlayer } from "@/components/webinar/replay-player";
import { isHttpsLink } from "@/lib/webinar-exit-link";
import { webinarRoomEnded } from "@/lib/webinar-page-layout";
import { consoleActiveTab, consoleOpeningTab, consoleTabs, roomReopens, webinarStatusFromTimes } from "@/lib/webinar/console-rules";
import { WebinarAnalyticsSection } from "@/components/webinar/webinar-analytics";
import {
  afterSessionTitle,
  CardEmpty,
  CardLoading,
  ConsoleTitle,
  EventTzContext,
  fmtTz,
  useEventTz,
} from "@/components/webinar/console-ui";
import { BrandingImageField } from "@/components/events/branding-image-field";

type AutoRecording = "none" | "local" | "cloud";

function formatDateTime(iso: string | undefined, tz: string): string {
  if (!iso) return "–";
  try {
    return fmtTz(iso, tz);
  } catch {
    return iso;
  }
}

export default function WebinarConsolePage() {
  const params = useParams();
  const eventId = params.eventId as string;

  const { data, isLoading, isFetching, error } = useWebinar(eventId);
  const viewerQuestionsQuery = useWebinarViewerQuestions(eventId, true);
  const showLoader = useDelayedLoading(isLoading, 500);
  const provision = useProvisionWebinar(eventId);
  const [pickedTab, setPickedTab] = useState<string | null>(null);

  const status = useMemo(
    () =>
      webinarStatusFromTimes(
        data?.anchorSession?.startTime,
        data?.anchorSession?.endTime,
        data?.anchorSession?.status,
      ),
    [data?.anchorSession?.startTime, data?.anchorSession?.endTime, data?.anchorSession?.status],
  );

  const hasZoom = Boolean(data?.zoomMeeting);
  const canSeeAnalytics = useCan("analytics.read", eventId) === "allowed";
  const eventIsWebinar = data?.event?.eventType === "WEBINAR";
  // Streamed by a partner from their own platform (Nov 16, 2026): no Zoom webinar of ours, so the
  // Partner stream card takes the place of the Zoom controls.
  const partner = data?.videoSource === "external";

  // The opening tab is decided once, when the data first arrives (consoleOpeningTab). Set during
  // render, the pattern React documents for state taken from a first value; it runs once, because
  // pickedTab is set from then on.
  if (data && pickedTab === null) setPickedTab(consoleOpeningTab(status));

  const handleCopy = async (value: string | null | undefined, label: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? `Failed to copy ${label}: ${err.message}`
          : `Failed to copy ${label}`,
      );
    }
  };

  const handleProvision = async () => {
    try {
      const result = await provision.mutateAsync();
      if (!result.ok) {
        toast.error(result.reason || "Provisioning failed");
        return;
      }
      if (result.zoomStatus === "created") {
        toast.success("Webinar provisioned. Zoom meeting ready");
      } else if (result.zoomStatus === "already-attached") {
        toast.success("Webinar already provisioned");
      } else if (result.zoomStatus === "not-configured") {
        toast.warning("Anchor session created. Zoom isn't configured for this organisation");
      } else if (result.zoomStatus === "failed") {
        toast.error("Anchor session created, but Zoom webinar creation failed");
      } else if (result.zoomStatus === "external-source") {
        toast.success("This webinar's video comes from a partner, so no Zoom webinar is created");
      } else {
        toast.success("Provisioner ran");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to provision");
    }
  };

  if (showLoader) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-red-600">Failed to load webinar console.</p>
        </CardContent>
      </Card>
    );
  }

  if (data && !eventIsWebinar) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-amber-500" />
            Not a Webinar Event
          </CardTitle>
          <CardDescription>
            This event&apos;s type is not <strong>Webinar</strong>. Change the
            event type to Webinar in{" "}
            <Link
              href={`/events/${eventId}/settings`}
              className="text-primary underline"
            >
              Settings
            </Link>{" "}
            to use the Webinar Console.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const anchor = data?.anchorSession;
  const zoom = data?.zoomMeeting;
  // Viewer questions get their own tab (owner, Oct 1, 2026). Polled here so
  // the tab's badge counts new questions while the producer is on any tab.
  // Shown in Custom stream mode, and in any mode while questions exist, so a
  // switch back to Zoom embed never strands questions nobody can see.
  const viewerQuestions = viewerQuestionsQuery.data?.questions ?? [];
  const newViewerQuestions = viewerQuestions.filter((q) => q.status === "NEW").length;
  const showViewerQaTab = data?.webinar?.viewingMode === "hls" || viewerQuestions.length > 0;
  // Controlled, not `defaultValue`: that was read on the first render, usually before the data
  // arrived, so an ended webinar opened on Setup (UX review, Nov 16, 2026). The opening tab is set
  // once (above); a tab that disappears while selected falls back to Setup (console-rules.ts).
  // ONE list decides which tabs exist: the triggers, the panels and the fallback all read it (review
  // of fbaf43f2: a trigger added to the JSX alone would snap back to Setup on every click).
  const visibleTabs = consoleTabs({ partner, viewerTabs: showViewerQaTab });
  const activeTab = consoleActiveTab(pickedTab, visibleTabs);

  return (
    <EventTzContext.Provider value={data?.event?.timezone || DEFAULT_EVENT_TIMEZONE}>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
            <Video className="h-6 w-6 shrink-0 text-primary" />
            Webinar Console
          </h1>
          {/* A div, not a p: ReloadingSpinner renders divs, and a div inside a
              p is invalid HTML (React logged a hydration error on every
              background refetch, Sep 30, 2026). */}
          <div className="text-muted-foreground mt-1">
            {data?.event?.name}
            {isFetching && !isLoading && (
              <ReloadingSpinner className="ml-2 inline-block" />
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!partner && (
            <GlobalRefreshButton
              eventId={eventId}
              sessionEnded={status === "ended"}
              hasZoom={hasZoom}
            />
          )}
          {/* Attendance, how people watched, polls and Q&A: on the event's Analytics page (Nov 23, 2026). */}
          {canSeeAnalytics && (
            <Button variant="outline" asChild>
              <Link href={`/events/${eventId}/analytics#webinar`}>
                <LineChart className="h-4 w-4 mr-2" />
                Analytics
              </Link>
            </Button>
          )}
          <Button
            variant="outline"
            onClick={handleProvision}
            disabled={provision.isPending}
          >
            {provision.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RotateCw className="h-4 w-4 mr-2" />
            )}
            Re-run provisioner
          </Button>
        </div>
      </div>

      {/* Sticky status bar — pinned to the top of the scroll area so the room
          state + primary action never scroll away (the bar's own bg carries a
          backdrop blur so content sliding under it stays legible). */}
      <div className="sticky top-0 z-20">
        <WebinarStatusBar
          eventId={eventId}
          status={status}
          anchor={anchor ?? null}
          zoom={zoom ?? null}
          eventSlug={data?.event?.slug ?? null}
          hasZoom={hasZoom}
          partner={partner}
          provisionPending={provision.isPending}
          onProvision={handleProvision}
          onCopy={handleCopy}
        />
      </div>

      {/* Tabs — collapse 7 cards of equal weight into 3 grouped views */}
      <Tabs value={activeTab} onValueChange={setPickedTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="setup" className="flex items-center gap-2">
            <Wrench className="h-4 w-4" />
            Setup
          </TabsTrigger>
          {/* Panelists are Zoom's: a partner's webinar has none of ours. */}
          {visibleTabs.includes("panelists") && (
            <TabsTrigger value="panelists" className="flex items-center gap-2">
              <UserPlus className="h-4 w-4" />
              Panelists
            </TabsTrigger>
          )}
          <TabsTrigger value="recording" className="flex items-center gap-2">
            <Film className="h-4 w-4" />
            Recording
          </TabsTrigger>
          {visibleTabs.includes("qa") && (
            <TabsTrigger value="qa" className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4" />
              Q&amp;A
              {newViewerQuestions > 0 && (
                <span
                  className="ml-1 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground"
                  aria-label={`${newViewerQuestions} new questions`}
                >
                  {newViewerQuestions}
                </span>
              )}
            </TabsTrigger>
          )}
          {visibleTabs.includes("polls") && (
            <TabsTrigger value="polls" className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              Polls
            </TabsTrigger>
          )}
          {visibleTabs.includes("chat") && (
            <TabsTrigger value="chat" className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4" />
              Chat
            </TabsTrigger>
          )}
          <TabsTrigger value="branding" className="flex items-center gap-2">
            <Palette className="h-4 w-4" />
            Branding
          </TabsTrigger>
          <TabsTrigger value="settings" className="flex items-center gap-2">
            <SettingsIcon className="h-4 w-4" />
            Settings
          </TabsTrigger>
        </TabsList>

        <TabsContent value="setup" className="space-y-6 mt-4">
          {/* Two-zone layout: the wide column is the configuration work area,
              the narrow rail is go-live, monitoring + comms. Panelists have
              their own tab. items-start stops the columns stretching to each
              other's height. */}
          <div className="grid items-start gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              {partner && (
                <PartnerStreamCard
                  eventId={eventId}
                  timezone={data?.event?.timezone || DEFAULT_EVENT_TIMEZONE}
                  webinar={{
                    eventName: data?.event?.name ?? "",
                    eventSlug: data?.event?.slug ?? null,
                    eventStatus: data?.event?.status,
                    sessionId: anchor?.id ?? null,
                    scheduledStart: anchor?.startTime ?? null,
                  }}
                />
              )}
              <OverviewCard
                status={status}
                anchor={anchor ?? null}
                zoom={zoom ?? null}
                eventSlug={data?.event?.slug ?? null}
                hasZoom={hasZoom}
                partner={partner}
                provisionPending={provision.isPending}
                onProvision={handleProvision}
                onCopy={handleCopy}
              />
              <LobbyCard
                // The card copies the saved settings into form state ONCE, on
                // mount. It used to mount before the console data arrived, so
                // the dropdown sat on the "Zoom embed" default while the saved
                // mode was Custom stream (owner screenshot, Oct 1, 2026).
                // Remount when the data loads and whenever the saved mode
                // changes, so the form always starts from what is saved.
                key={`${data ? "loaded" : "loading"}:${data?.webinar?.viewingMode ?? "zoom"}`}
                eventId={eventId}
                eventSlug={data?.event?.slug ?? null}
                webinar={data?.webinar ?? {}}
                anchor={anchor ?? null}
                partner={partner}
              />
              <EndSurveyCard
                key={`end-survey:${data?.webinar?.endSurveyId ?? ""}:${data?.webinar?.thankYouSurveyLink !== false}`}
                eventId={eventId}
                endSurveyId={data?.webinar?.endSurveyId ?? ""}
                emailLink={data?.webinar?.thankYouSurveyLink !== false}
              />
              <ExitButtonCard
                key={`exit:${data ? "loaded" : "loading"}:${data?.webinar?.exitUrl ?? ""}`}
                eventId={eventId}
                exitUrl={data?.webinar?.exitUrl ?? ""}
                orgWebsite={data?.orgWebsite ?? null}
              />
            </div>
            <div className="space-y-6">
              <GoLiveCard
                eventId={eventId}
                webinar={data?.webinar ?? {}}
                anchor={anchor ?? null}
                eventStatus={data?.event?.status}
                partner={partner}
              />
              <LiveNowCard
                eventId={eventId}
                live={anchor?.status === "LIVE" || status === "live"}
              />
              <StreamTimelineCard eventId={eventId} live={anchor?.status === "LIVE"} />
              {/* Handouts in the right rail (owner, Oct 6, 2026). */}
              <HandoutsCard eventId={eventId} handouts={data?.webinar?.handouts ?? []} />
              {/* A partner's webinar sends the same emails: they link our session page, never Zoom. */}
              <EmailSequenceCard eventId={eventId} hasZoom={hasZoom || partner} />
            </div>
          </div>
        </TabsContent>

        {/* Panelists on their own tab (owner, Oct 6, 2026): a wide table and
            add form that would be cramped in the Setup tab's right rail. */}
        {visibleTabs.includes("panelists") && (
          <TabsContent value="panelists" className="mt-4">
            <PanelistsCard eventId={eventId} hasZoom={hasZoom} />
          </TabsContent>
        )}

        {/* The reports that were this tab moved to the event's Analytics page (Nov 23, 2026); the
            recording stays, because the replay link is a setting the producer makes after the event. */}
        <TabsContent value="recording" className="space-y-6 mt-4">
          <RecordingCard
            // Remounts when the saved link changes, so the field shows what is stored.
            key={`recording:${data ? "loaded" : "loading"}:${data?.webinar?.replayUrl ?? ""}`}
            eventId={eventId}
            zoom={data?.zoomMeeting ?? null}
            sessionEnded={status === "ended"}
            shown={data?.webinar?.showRecording === true}
            replayUrl={data?.webinar?.replayUrl ?? ""}
          />
          {/* Someone who may see the webinar's reports but not the event's Analytics page (a custom role
              with Webinar attendance and not Event analytics) keeps them here (review of f0597c424). */}
          {!canSeeAnalytics && <WebinarAnalyticsSection eventId={eventId} heading={false} />}
        </TabsContent>

        <TabsContent value="branding" className="mt-4 max-w-3xl">
          {/* Copies the saved images into form state once: remount when the
              console data arrives so it never starts from the empty default. */}
          <BrandingCard key={data ? "loaded" : "loading"} eventId={eventId} webinar={data?.webinar ?? {}} />
        </TabsContent>

        {visibleTabs.includes("qa") && (
          <TabsContent value="qa" className="mt-4">
            <ViewerQuestionsPanel eventId={eventId} upvote={data?.webinar?.qaUpvote !== false} />
          </TabsContent>
        )}

        {visibleTabs.includes("polls") && (
          <TabsContent value="polls" className="mt-4">
            <LivePollsPanel eventId={eventId} enabled={data?.webinar?.livePolls === true} />
          </TabsContent>
        )}

        {visibleTabs.includes("chat") && (
          <TabsContent value="chat" className="mt-4">
            <ChatModerationPanel eventId={eventId} />
          </TabsContent>
        )}

        <TabsContent value="settings" className="mt-4">
          {data ? (
            <WebinarSettingsCard
              eventId={eventId}
              initialSettings={data.webinar || {}}
            />
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
    </EventTzContext.Provider>
  );
}

// Shape aliases — exactly what WebinarConsoleData returns for the two fields.
// Extracted so the status bar + overview card both use the same types.
type AnchorSession = NonNullable<
  ReturnType<typeof useWebinar>["data"]
>["anchorSession"];
type ZoomMeetingLite = NonNullable<
  ReturnType<typeof useWebinar>["data"]
>["zoomMeeting"];

type WebinarStatus = "scheduled" | "live" | "ended";

// ── Section-title system: one colored icon chip per card so each section has a
// consistent, scannable anchor (hierarchy via size + contrast, not text alone).
// The attendee HLS player, reused for the console's stream preview. Loaded on
// demand: hls.js is heavy and only needed once the preview is opened.
const LivePlayer = dynamic(
  () => import("@/components/zoom/live-player").then((m) => ({ default: m.LivePlayer })),
  { ssr: false },
);

function formatSessionWindow(
  start: string | undefined,
  end: string | undefined,
  tz: string,
): string {
  if (!start || !end) return "";
  try {
    const startDate = new Date(start);
    const endDate = new Date(end);
    const thisYear = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" }).format(new Date());
    const startYear = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" }).format(startDate);
    const dateLabel = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      month: "short",
      day: "numeric",
      year: startYear !== thisYear ? "numeric" : undefined,
    }).format(startDate);
    const label = tzLabel(startDate, tz);
    return `${dateLabel} · ${formatTimeInTz(startDate, tz)} – ${formatTimeInTz(endDate, tz)}${label ? ` ${label}` : ""}`;
  } catch {
    return "";
  }
}

const STATUS_BAR_CLASS: Record<WebinarStatus, string> = {
  // py-0: the card's own padding doubled the content's, and the sticky bar stood twice the
  // height it needs on a 13-inch laptop (UX review, Nov 16, 2026).
  live: "border-red-200 bg-red-50/90 shadow-md backdrop-blur-sm py-0",
  ended: "border-gray-200 bg-card/95 shadow-md backdrop-blur-sm py-0",
  scheduled: "border-blue-200 bg-blue-50/90 shadow-md backdrop-blur-sm py-0",
};

function StatusBarIcon({ status }: { status: WebinarStatus }) {
  if (status === "live") return <CircleDot className="h-4 w-4 text-red-600 animate-pulse" />;
  if (status === "ended") return <CheckCircle className="h-4 w-4 text-gray-500" />;
  return <Clock className="h-4 w-4 text-blue-600" />;
}

// ── Sticky status bar — always visible summary + primary action ────
function WebinarStatusBar({
  eventId,
  status,
  anchor,
  zoom,
  eventSlug,
  hasZoom,
  partner,
  provisionPending,
  onProvision,
  onCopy,
}: {
  eventId: string;
  status: WebinarStatus;
  anchor: AnchorSession;
  zoom: ZoomMeetingLite;
  eventSlug: string | null;
  hasZoom: boolean;
  partner: boolean;
  provisionPending: boolean;
  onProvision: () => void;
  onCopy: (value: string | null | undefined, label: string) => void;
}) {
  // Room state belongs in the ALWAYS-VISIBLE bar (organizer feedback, Aug 10
  // 2026). Starting the webinar is two steps — "Start as Host" begins the
  // broadcast, "Open the room" admits attendees out of the waiting room — and
  // only the first one lived up here. So the control that does NOT let anyone
  // in was permanently on screen, and the one that does was a scroll away in
  // the Lobby card. The predictable outcome: producer sits in an empty Zoom
  // while the audience watches a countdown.
  const roomOpen = anchor?.status === "LIVE";
  const toggleRoom = useToggleWebinarRoom(eventId);
  const liveStream = useWebinarLiveStream(eventId);
  const eventTz = useEventTz();
  const [confirmStartOpen, setConfirmStartOpen] = useState(false);

  // "Start as Host" opens the room a moment after the Zoom tab, before the
  // host has actually started the webinar, so Zoom refuses the custom-stream
  // start that opening the room attempts. Keep asking every 30 s (Zoom's own
  // spacing) for about two and a half minutes, then hand over to the button.
  // Stops at once (final review, Oct 2, 2026) when the room is closed or the
  // console unmounts, so Zoom never starts pushing into a closed room, and
  // when Zoom gives an answer no retry can fix (e.g. the webinar is gone).
  const roomOpenRef = useRef(roomOpen);
  useEffect(() => {
    roomOpenRef.current = roomOpen;
  }, [roomOpen]);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const retryStreamStart = async () => {
    for (let attempt = 0; attempt < STREAM_START_RETRIES; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, STREAM_START_RETRY_MS));
      if (!mountedRef.current || !roomOpenRef.current) {
        console.info("webinar-console:stream-start-retry-stopped", { attempt, roomOpen: roomOpenRef.current });
        return;
      }
      try {
        await liveStream.mutateAsync("start");
        toast.success("Custom stream started");
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("webinar-console:stream-start-retry", attempt + 1, message);
        // Retry only the two answers that time can fix: not live yet, and
        // Zoom's one-start-per-30-seconds limit.
        if (!/not live in Zoom yet|still handling the previous start/i.test(message)) {
          toast.error(message);
          return;
        }
      }
    }
    toast.warning("The stream still has not started. Check that the webinar is running in Zoom, then press Start stream in the Waiting Room card.");
  };

  // The Zoom tab is opened from the CLICK HANDLER, synchronously, before any
  // await — a popup blocker kills a window.open() that happens after one.
  const openHostTab = () => {
    if (zoom?.startUrl) window.open(zoom.startUrl, "_blank", "noopener,noreferrer");
  };

  const startAndOpenRoom = async () => {
    openHostTab();
    setConfirmStartOpen(false);
    try {
      const res = await toggleRoom.mutateAsync(true);
      toast.success("Room opened: attendees are being let in");
      if (res.stream && !res.stream.ok) {
        toast.info("Waiting for Zoom to start the webinar, then starting the custom stream…");
        void retryStreamStart();
      } else {
        announceStreamResult(res.stream, true);
      }
    } catch (err) {
      // The host tab already opened, so this must NOT read as a failed start.
      toast.error(
        err instanceof Error
          ? `Started, but opening the room failed: ${err.message}`
          : "Started, but opening the room failed. Use the Lobby card",
      );
    }
  };
  // A partner's webinar never has a Zoom webinar: its bar shows the room and the partner's signal.
  if (partner) {
    return <PartnerStatusBar eventId={eventId} status={status} anchor={anchor} eventSlug={eventSlug} onCopy={onCopy} />;
  }
  // No Zoom attached → collapse to a "Configure Zoom" banner with provisioner retry.
  if (!hasZoom || !zoom) {
    return (
      <Card className="border-amber-200 bg-amber-50/90 shadow-md backdrop-blur-sm">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="flex items-center gap-3 min-w-0">
            <AlertCircle className="h-5 w-5 text-amber-600 shrink-0" />
            <div className="min-w-0">
              <p className="font-medium text-sm">Zoom webinar not provisioned</p>
              <p className="text-xs text-muted-foreground">
                Either Zoom isn&apos;t configured for this organization, or the
                provisioner hasn&apos;t run yet.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/settings">Configure Zoom</Link>
            </Button>
            <Button
              size="sm"
              onClick={onProvision}
              disabled={provisionPending}
            >
              {provisionPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              Run provisioner
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const hasRecording = zoom.recordingStatus === "AVAILABLE" && zoom.recordingUrl;
  const sessionWindow = formatSessionWindow(anchor?.startTime, anchor?.endTime, eventTz);

  // Room already open (or no anchor to open) → plain link, nothing
  // to confirm. Room closed → confirm, because starting alone
  // leaves every attendee in the waiting room.
  const renderStartAsHost = (startUrl: string) =>
    roomOpen || !anchor ? (
      <Button asChild>
        <a href={startUrl} target="_blank" rel="noopener noreferrer">
          <PlayCircle className="h-4 w-4 mr-2" />
          Start as Host
        </a>
      </Button>
    ) : (
      <Button onClick={() => setConfirmStartOpen(true)}>
        <PlayCircle className="h-4 w-4 mr-2" />
        Start as Host
      </Button>
    );

  return (
    <Card
      className={
        // /90 tints + backdrop blur: the bar is sticky, so content scrolling
        // beneath it must not bleed through; shadow-md lifts it off the page.
        STATUS_BAR_CLASS[status]
      }
    >
      <CardContent className="py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          {/* Status pill */}
          <div className="flex items-center gap-2 shrink-0">
            <StatusBarIcon status={status} />
            <StatusBadge status={status} />
          </div>

          {/* Session window */}
          {sessionWindow ? (
            <div className="text-sm text-muted-foreground shrink-0">
              {sessionWindow}
            </div>
          ) : null}

          {/* The link attendees are sent: our page, which checks their registration and payment.
              It was Zoom's join link and passcode, which skip both (UX review, Nov 16, 2026); those
              are in the Overview card's Zoom details now, for hosts and panelists. */}
          <AttendeePageLink eventSlug={eventSlug} sessionId={anchor?.id ?? null} onCopy={onCopy} />

          {/* Context-aware primary action */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Room state, always visible next to the start control — the two
                are a pair and were previously separated by a scroll. */}
            {anchor && status !== "ended" ? (
              <Badge
                variant="outline"
                className={
                  roomOpen
                    ? "bg-red-100 text-red-800 border-red-200 shrink-0"
                    : "text-muted-foreground shrink-0"
                }
                title={
                  roomOpen
                    ? "Attendees are being let in"
                    : "Attendees are held in the waiting room"
                }
              >
                {roomOpen ? "Room OPEN" : "Room closed"}
              </Badge>
            ) : null}
            {status === "ended" && hasRecording ? (
              <Button asChild>
                <a
                  href={zoom.recordingUrl!}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <PlayCircle className="h-4 w-4 mr-2" />
                  Watch Replay
                </a>
              </Button>
            ) : null}
            {!(status === "ended" && hasRecording) && zoom.startUrl ? renderStartAsHost(zoom.startUrl) : null}
            {eventSlug && anchor ? (
              <Button asChild variant="outline" size="icon" title="Open public session page">
                <Link
                  href={`/e/${eventSlug}/session/${anchor.id}`}
                  target="_blank"
                >
                  <ExternalLink className="h-4 w-4" />
                </Link>
              </Button>
            ) : null}
          </div>
        </div>

        <AlertDialog open={confirmStartOpen} onOpenChange={setConfirmStartOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Open the room for attendees too?</AlertDialogTitle>
              <AlertDialogDescription>
                Starting as host begins the broadcast, but attendees stay in the
                waiting room until the room is opened. Open it now unless you
                want a private rehearsal first.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              {/* Start-only stays available on purpose: rehearsing with
                  panelists before letting the audience in is a real workflow,
                  and it is what the producer got by default until today. */}
              <Button
                variant="outline"
                onClick={() => {
                  openHostTab();
                  setConfirmStartOpen(false);
                }}
              >
                Start only
              </Button>
              <Button onClick={startAndOpenRoom} disabled={toggleRoom.isPending}>
                Start and open the room
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

const readSiteOrigin = () => window.location.origin;

/** The attendee page's full address: our session page, the link attendees are sent. */
function useAttendeePageUrl(eventSlug: string | null, sessionId: string | null): string | null {
  const origin = useSyncExternalStore(subscribeToNothing, readSiteOrigin, () => "");
  if (!eventSlug || !sessionId || !origin) return null;
  return `${origin}/e/${eventSlug}/session/${sessionId}`;
}

function AttendeePageLink({
  eventSlug,
  sessionId,
  onCopy,
}: {
  eventSlug: string | null;
  sessionId: string | null;
  onCopy: (value: string | null | undefined, label: string) => void;
}) {
  const url = useAttendeePageUrl(eventSlug, sessionId);
  if (!url) return <div className="flex-1" />;
  return (
    <div className="flex items-center gap-2 flex-1 min-w-[260px]">
      <span className="shrink-0 text-xs font-medium text-muted-foreground">Attendee page</span>
      <Input value={url} readOnly className="font-mono text-xs h-9" aria-label="Attendee page link" />
      <Button
        type="button"
        size="icon"
        variant="outline"
        onClick={() => onCopy(url, "Attendee page link")}
        title="Copy the attendee page link"
      >
        <Copy className="h-4 w-4" />
      </Button>
    </div>
  );
}

/**
 * The sticky bar on a partner's webinar (Nov 16, 2026): status, time, the room
 * and whether the partner's video is arriving. There is no "Start as Host":
 * the partner starts their own stream, and the room opens from Go live.
 */
function PartnerStatusBar({
  eventId,
  status,
  anchor,
  eventSlug,
  onCopy,
}: {
  eventId: string;
  status: WebinarStatus;
  anchor: AnchorSession;
  eventSlug: string | null;
  onCopy: (value: string | null | undefined, label: string) => void;
}) {
  const eventTz = useEventTz();
  // The link attendees are sent, copyable here as on a Zoom webinar's bar (review of c1b4ae83).
  const attendeeUrl = useAttendeePageUrl(eventSlug, anchor?.id ?? null);
  const canManage = useCan("webinar.manage", eventId) === "allowed";
  const partnerStream = useWebinarPartnerStream(eventId, canManage);
  const roomOpen = anchor?.status === "LIVE";
  const sessionWindow = formatSessionWindow(anchor?.startTime, anchor?.endTime, eventTz);
  const stream = partnerStream.data?.partnerStream ?? null;
  const signal = stream ? partnerSignalLabel(partnerStream.data?.signal ?? null, stream.enabled) : null;

  return (
    <Card className={STATUS_BAR_CLASS[status]}>
      <CardContent className="py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="flex items-center gap-2 shrink-0">
            <StatusBarIcon status={status} />
            <StatusBadge status={status} />
          </div>
          {sessionWindow ? <div className="text-sm text-muted-foreground shrink-0">{sessionWindow}</div> : null}
          <div className="flex flex-1 items-center gap-2 min-w-[200px] text-sm">
            <Radio className="h-4 w-4 text-violet-600 shrink-0" />
            <span className="font-medium">Partner stream</span>
            {signal ? (
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${signal.tone}`}>{signal.text}</span>
            ) : (
              // Said only once the answer is in: while loading it would claim there is no key.
              <span className="text-muted-foreground">{canManage && partnerStream.isSuccess ? "No key issued yet" : ""}</span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {anchor && status !== "ended" ? (
              <Badge
                variant="outline"
                className={roomOpen ? "bg-red-100 text-red-800 border-red-200 shrink-0" : "text-muted-foreground shrink-0"}
              >
                {roomOpen ? "Room OPEN" : "Room closed"}
              </Badge>
            ) : null}
            {attendeeUrl ? (
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => onCopy(attendeeUrl, "Attendee page link")}
                title="Copy the attendee page link"
                aria-label="Copy the attendee page link"
              >
                <Copy className="h-4 w-4" />
              </Button>
            ) : null}
            {eventSlug && anchor ? (
              <Button asChild variant="outline" size="icon" title="Open public session page">
                <Link href={`/e/${eventSlug}/session/${anchor.id}`} target="_blank">
                  <ExternalLink className="h-4 w-4" />
                </Link>
              </Button>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Overview card — combines Anchor Session + Zoom Meeting details ──
// Previously two separate cards; merged so the Setup tab isn't visually split.
function OverviewCard({
  status,
  anchor,
  zoom,
  eventSlug,
  hasZoom,
  partner,
  provisionPending,
  onProvision,
  onCopy,
}: {
  status: WebinarStatus;
  anchor: AnchorSession;
  zoom: ZoomMeetingLite;
  eventSlug: string | null;
  hasZoom: boolean;
  partner: boolean;
  provisionPending: boolean;
  onProvision: () => void;
  onCopy: (value: string | null | undefined, label: string) => void;
}) {
  const eventTz = useEventTz();
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <ConsoleTitle icon={Calendar} tone="sky">
            Overview
          </ConsoleTitle>
          <StatusBadge status={status} />
        </div>
        <CardDescription>
          {partner
            ? "The webinar's session. Its video comes from the partner's stream above."
            : "Anchor session and Zoom webinar details for this event."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Anchor session details */}
        {anchor ? (
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <Label className="text-muted-foreground text-xs uppercase tracking-wide">
                Session Name
              </Label>
              <p className="font-medium">{anchor.name}</p>
            </div>
            <div>
              <Label className="text-muted-foreground text-xs uppercase tracking-wide">
                Status
              </Label>
              <p className="font-medium capitalize">{status}</p>
            </div>
            <div>
              <Label className="text-muted-foreground text-xs uppercase tracking-wide">
                Starts
              </Label>
              <p className="font-medium">{formatDateTime(anchor.startTime, eventTz)}</p>
            </div>
            <div>
              <Label className="text-muted-foreground text-xs uppercase tracking-wide">
                Ends
              </Label>
              <p className="font-medium">{formatDateTime(anchor.endTime, eventTz)}</p>
            </div>
          </div>
        ) : (
          <EmptyAnchorState onProvision={onProvision} pending={provisionPending} />
        )}

        {/* Zoom details, only when attached. Folded away and labelled for hosts: the join link and
            passcode skip our registration check, so they are not for attendees (UX review, Nov 16,
            2026). Not "panelists" either: they join from their own link in Zoom's panelist
            invitation (review of c1b4ae83). */}
        {hasZoom && zoom ? (
          <div className="pt-5 border-t space-y-4">
            <details className="rounded-lg border p-3 text-sm">
              <summary className="cursor-pointer font-medium">Zoom details (hosts only)</summary>
              <p className="mt-2 text-xs text-muted-foreground">
                Attendees join through the attendee page, which checks their registration. Do not send this
                link or passcode to attendees.
              </p>
              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label className="text-muted-foreground text-xs uppercase tracking-wide">Meeting Type</Label>
                  <p className="font-medium">{zoom.meetingType}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground text-xs uppercase tracking-wide">Duration</Label>
                  <p className="font-medium">{zoom.duration ?? "–"} min</p>
                </div>
                <div className="md:col-span-2">
                  <Label className="text-muted-foreground text-xs uppercase tracking-wide">Zoom join link</Label>
                  <div className="flex items-center gap-2 mt-1">
                    <Input value={zoom.joinUrl} readOnly className="font-mono text-xs" aria-label="Zoom join link" />
                    <Button type="button" size="icon" variant="outline" onClick={() => onCopy(zoom.joinUrl, "Zoom join link")}>
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                {zoom.passcode ? (
                  <div>
                    <Label className="text-muted-foreground text-xs uppercase tracking-wide">Passcode</Label>
                    <div className="flex items-center gap-2 mt-1">
                      <Input value={zoom.passcode} readOnly className="font-mono" aria-label="Zoom passcode" />
                      <Button type="button" size="icon" variant="outline" onClick={() => onCopy(zoom.passcode, "Passcode")}>
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            </details>

            <div className="flex flex-wrap gap-2 pt-2 border-t">
              {zoom.startUrl ? (
                <Button asChild>
                  <a href={zoom.startUrl} target="_blank" rel="noopener noreferrer">
                    <PlayCircle className="h-4 w-4 mr-2" />
                    Start as Host
                  </a>
                </Button>
              ) : null}
              {eventSlug && anchor ? (
                <Button asChild variant="outline">
                  <Link
                    href={`/e/${eventSlug}/session/${anchor.id}`}
                    target="_blank"
                  >
                    <ExternalLink className="h-4 w-4 mr-2" />
                    Open Public Page
                  </Link>
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <TroubleshootingLink />
      </CardContent>
    </Card>
  );
}

// The webinar team's guide to what can go wrong (docs/WEBINAR_TROUBLESHOOTING.html), served by the
// shared doc route. Who can open it is that route's rule: the operator, and anyone once the operator
// switches the doc to public in Admin > Docs.
const TROUBLESHOOTING_GUIDE_URL = "/admin/docs/docs/WEBINAR_TROUBLESHOOTING.html";

function TroubleshootingLink() {
  return (
    <div className="pt-4 border-t text-sm text-muted-foreground">
      Something not working?{" "}
      <a
        href={TROUBLESHOOTING_GUIDE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
      >
        Open the troubleshooting guide
        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      </a>
    </div>
  );
}

function refreshAllTitle(hasZoom: boolean, sessionEnded: boolean): string {
  if (!hasZoom) return "Attach a Zoom webinar first";
  if (!sessionEnded) return "Session hasn't ended, so some sources will be pending";
  return "Refresh recording + attendance + polls/Q&A";
}

// ── Global refresh button — fires recording + attendance + engagement in parallel
function GlobalRefreshButton({
  eventId,
  sessionEnded,
  hasZoom,
}: {
  eventId: string;
  sessionEnded: boolean;
  hasZoom: boolean;
}) {
  const fetchRecording = useFetchWebinarRecording(eventId);
  const syncAttendance = useSyncWebinarAttendance(eventId);
  const syncEngagement = useSyncWebinarEngagement(eventId);

  // Only meaningful post-event — before the session ends, the three syncs
  // all return `pending` and hitting the button produces three useless
  // toasts. Disable and let the tooltip explain why.
  const canRefresh = hasZoom && sessionEnded;

  const pending =
    fetchRecording.isPending || syncAttendance.isPending || syncEngagement.isPending;

  const handleRefresh = async () => {
    const results = await Promise.allSettled([
      fetchRecording.mutateAsync(),
      syncAttendance.mutateAsync(),
      syncEngagement.mutateAsync(),
    ]);

    // Summarize in one toast. Each sub-sync logs its own detail internally
    // via its hook; this is just the top-line summary.
    const [rec, att, eng] = results;
    const parts: string[] = [];

    if (rec.status === "fulfilled") {
      parts.push(
        rec.value.status === "available"
          ? "recording ready"
          : `recording: ${rec.value.status}`,
      );
    } else {
      parts.push("recording failed");
    }

    if (att.status === "fulfilled") {
      parts.push(
        att.value.status === "synced"
          ? `attendance ${att.value.fetched ?? 0} rows`
          : `attendance: ${att.value.status}`,
      );
    } else {
      parts.push("attendance failed");
    }

    if (eng.status === "fulfilled") {
      if (eng.value.status === "synced") {
        const pollCount = eng.value.pollResponsesPersisted ?? 0;
        const qaCount = eng.value.questionsPersisted ?? 0;
        parts.push(`polls ${pollCount}, Q&A ${qaCount}`);
      } else {
        parts.push(`engagement: ${eng.value.status}`);
      }
    } else {
      parts.push("engagement failed");
    }

    const anyFailed = results.some((r) => r.status === "rejected");
    if (anyFailed) {
      toast.warning(`Refreshed with errors: ${parts.join(" · ")}`);
    } else {
      toast.success(`Refreshed · ${parts.join(" · ")}`);
    }
  };

  return (
    <Button
      variant="outline"
      size="default"
      onClick={handleRefresh}
      disabled={pending || !canRefresh}
      title={refreshAllTitle(hasZoom, sessionEnded)}
    >
      {pending ? (
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
      ) : (
        <RotateCw className="h-4 w-4 mr-2" />
      )}
      Refresh
    </Button>
  );
}

type TimeUnit = "minutes" | "hours" | "days";
const UNIT_MINUTES: Record<TimeUnit, number> = { minutes: 1, hours: 60, days: 24 * 60 };

function unitFor(minutes: number): TimeUnit {
  if (minutes > 0 && minutes % UNIT_MINUTES.days === 0) return "days";
  if (minutes > 0 && minutes % UNIT_MINUTES.hours === 0) return "hours";
  return "minutes";
}

/**
 * The webinar's email sequence, chosen by the organiser (Nov 25, 2026; owner: "make it manual, let
 * the organiser decide"). Pre-filled with the five usual emails; nothing goes out until Schedule is
 * pressed. A webinar that already had a sequence queued keeps it and can change it here.
 */
function EmailSequenceCard({
  eventId,
  hasZoom,
}: {
  eventId: string;
  hasZoom: boolean;
}) {
  const { data, isLoading } = useWebinarSequence(eventId);
  const schedule = useScheduleWebinarSequence(eventId);
  const canManage = useCan("webinar.manage", eventId) === "allowed";
  const [draft, setDraft] = useState<Record<SequencePhase, PhaseChoice> | null>(null);
  const [units, setUnits] = useState<Partial<Record<SequencePhase, TimeUnit>>>({});

  const saved = data?.plan?.phases ?? defaultPhaseChoices();
  const phases = draft ?? saved;
  const scheduled = data?.plan?.scheduled ?? false;
  const changed = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);

  const setPhase = (phase: SequencePhase, next: Partial<PhaseChoice>) =>
    setDraft({ ...phases, [phase]: { ...phases[phase], ...next } });

  const handleSchedule = async () => {
    try {
      const result = await schedule.mutateAsync(phases);
      setDraft(null);
      if (result.skipped === "no-anchor-session") {
        toast.error("No anchor session. Run the provisioner first");
      } else if (result.skipped === "no-future-phases") {
        toast.warning("Saved, but every chosen time is in the past, so nothing was queued");
      } else if (result.skipped === "no-actor") {
        toast.error("No admin user found to create the emails");
      } else {
        toast.success(`Scheduled: ${result.created} email${result.created === 1 ? "" : "s"} queued`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not schedule the emails");
    }
  };

  const rows = data?.rows ?? [];

  return (
    <Card>
      <CardHeader>
        <ConsoleTitle icon={Mail} tone="emerald">
          Email Sequence
        </ConsoleTitle>
        <CardDescription>
          Choose which emails go to confirmed registrants and when, then press Schedule. Nothing goes out until you do.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? <CardLoading /> : null}
        {!isLoading && !scheduled && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Not scheduled yet: no reminder, live or thank-you email will be sent for this webinar until you press Schedule.
            The usual five are filled in below.
          </p>
        )}
        {!isLoading && (
          <div className="divide-y rounded-lg border">
            {SEQUENCE_PHASES.map((phase) => {
              const rule = PHASE_RULES[phase];
              const choice = phases[phase];
              const unit = rule.anchor === "before-start" ? (units[phase] ?? unitFor(choice.minutes)) : "minutes";
              const shown = Math.round((choice.minutes / UNIT_MINUTES[unit]) * 100) / 100;
              return (
                <div key={phase} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <Switch
                    checked={choice.enabled}
                    disabled={!canManage}
                    onCheckedChange={(on) => setPhase(phase, { enabled: on })}
                    aria-label={`Send the ${rule.label} email`}
                  />
                  <div className="min-w-[9rem] flex-1">
                    <p className={choice.enabled ? "text-sm font-medium" : "text-sm font-medium text-muted-foreground line-through"}>{rule.label}</p>
                    <p className="text-xs text-muted-foreground">{choice.enabled ? describePhaseTime(phase, choice.minutes) : "Not sent"}</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      className="h-8 w-20"
                      min={0}
                      step={unit === "minutes" ? 1 : 0.5}
                      value={shown}
                      disabled={!canManage || !choice.enabled}
                      aria-label={`${rule.label}: time`}
                      onChange={(e) => {
                        const raw = Number(e.target.value);
                        if (!Number.isFinite(raw)) return;
                        const minutes = Math.min(rule.max, Math.max(rule.min, Math.round(raw * UNIT_MINUTES[unit])));
                        setPhase(phase, { minutes });
                      }}
                    />
                    {rule.anchor === "before-start" ? (
                      <Select value={unit} onValueChange={(v) => setUnits({ ...units, [phase]: v as TimeUnit })} disabled={!canManage || !choice.enabled}>
                        <SelectTrigger className="h-8 w-[6.5rem]" aria-label={`${rule.label}: unit`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="minutes">minutes</SelectItem>
                          <SelectItem value="hours">hours</SelectItem>
                          <SelectItem value="days">days</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="text-xs text-muted-foreground">min</span>
                    )}
                    <span className="hidden text-xs text-muted-foreground sm:inline">
                      {rule.anchor === "before-start" ? "before" : "after"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {!isLoading && (
          <p className="text-xs text-muted-foreground">
            Each email keeps its own wording under Communications, Email Templates. The reminders say
            &ldquo;tomorrow&rdquo;, &ldquo;in 1 hour&rdquo; and &ldquo;in 15 minutes&rdquo;: if you change a time, change its wording to match.
            The thank-you follows the room: it goes that long after you close it.
          </p>
        )}
        {canManage && !isLoading && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {changed && (
              <Button variant="ghost" size="sm" onClick={() => setDraft(null)} disabled={schedule.isPending}>
                Discard changes
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => void handleSchedule()}
              disabled={schedule.isPending || !hasZoom || (scheduled && !changed)}
              title={!hasZoom ? "Attach a Zoom webinar first" : undefined}
            >
              {schedule.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCw className="mr-2 h-4 w-4" />}
              {scheduled ? "Save and reschedule" : "Schedule"}
            </Button>
          </div>
        )}
        {!isLoading && rows.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Queued and sent</p>
            <div className="divide-y">
              {rows.map((row) => (
                <SequenceRowView key={row.id} row={row} />
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SequenceRowView({ row }: { row: WebinarSequenceRow }) {
  const eventTz = useEventTz();
  const label = (
    {
      "webinar-confirmation": "Confirmation",
      "webinar-reminder-24h": PHASE_RULES["webinar-reminder-24h"].label,
      "webinar-reminder-1h": PHASE_RULES["webinar-reminder-1h"].label,
      "webinar-reminder-15m": PHASE_RULES["webinar-reminder-15m"].label,
      "webinar-live-now": PHASE_RULES["webinar-live-now"].label,
      "webinar-thank-you": PHASE_RULES["webinar-thank-you"].label,
    } as Record<string, string>
  )[row.emailType] ?? row.emailType;

  const { Icon, colorClass } = statusVisuals(row.status);
  return (
    <div className="flex items-center justify-between py-3 gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <Icon className={`h-5 w-5 shrink-0 ${colorClass}`} />
        <div className="min-w-0">
          <p className="font-medium text-sm truncate">{label}</p>
          <p className="text-xs text-muted-foreground">
            {row.status === "SENT" && row.sentAt
              ? `Sent ${fmtTz(row.sentAt, eventTz)}`
              : `Scheduled for ${fmtTz(row.scheduledFor, eventTz)}`}
          </p>
        </div>
      </div>
      <div className="text-right text-xs text-muted-foreground shrink-0">
        {row.status === "SENT" && row.totalCount != null ? (
          <div>
            {row.successCount}/{row.totalCount} sent
            {row.failureCount ? (
              <span className="text-red-600 ml-1">({row.failureCount} failed)</span>
            ) : null}
          </div>
        ) : null}
        {!(row.status === "SENT" && row.totalCount != null) && row.status === "FAILED" && row.lastError ? (
          <div className="text-red-600 truncate max-w-[240px]" title={row.lastError}>
            {row.lastError}
          </div>
        ) : null}
        {!(row.status === "SENT" && row.totalCount != null) && !(row.status === "FAILED" && row.lastError) ? (
          <StatusPill status={row.status} />
        ) : null}
      </div>
    </div>
  );
}

function statusVisuals(
  status: WebinarSequenceRow["status"],
): { Icon: typeof Clock; colorClass: string } {
  switch (status) {
    case "SENT":
      return { Icon: CheckCircle2, colorClass: "text-green-600" };
    case "FAILED":
      return { Icon: XCircle, colorClass: "text-red-600" };
    case "CANCELLED":
      return { Icon: XCircle, colorClass: "text-gray-400" };
    case "PROCESSING":
      return { Icon: Loader2, colorClass: "text-blue-600 animate-spin" };
    case "PENDING":
    default:
      return { Icon: Clock, colorClass: "text-muted-foreground" };
  }
}

function StatusPill({ status }: { status: WebinarSequenceRow["status"] }) {
  const variants: Record<WebinarSequenceRow["status"], string> = {
    PENDING: "bg-gray-100 text-gray-700",
    PROCESSING: "bg-blue-100 text-blue-700",
    SENT: "bg-green-100 text-green-700",
    FAILED: "bg-red-100 text-red-700",
    CANCELLED: "bg-gray-100 text-gray-500",
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wide ${variants[status]}`}>
      {status}
    </span>
  );
}

function RecordingCard({
  eventId,
  zoom,
  sessionEnded,
  shown,
  replayUrl,
}: {
  eventId: string;
  zoom:
    | {
        recordingUrl: string | null;
        recordingPassword: string | null;
        recordingDuration: number | null;
        recordingFetchedAt: string | null;
        recordingStatus: "NOT_REQUESTED" | "PENDING" | "AVAILABLE" | "FAILED" | "EXPIRED";
      }
    | null;
  sessionEnded: boolean;
  /** Whether the attendee page offers the recording (off unless turned on, Oct 28, 2026). */
  shown: boolean;
  /** The organiser's uploaded replay, a Vimeo video link, or "" (Nov 10, 2026). */
  replayUrl: string;
}) {
  const eventTz = useEventTz();
  const fetchRecording = useFetchWebinarRecording(eventId);
  const updateSettings = useUpdateWebinarSettings(eventId);
  // A settings write: shown only to producers, so a read-only viewer never flips it into a 403.
  const canManage = useCan("webinar.manage", eventId) === "allowed";

  const toggleShown = async (next: boolean) => {
    try {
      await updateSettings.mutateAsync({ showRecording: next });
      toast.success(next ? "Attendees can now watch the recording" : "Recording hidden from attendees");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change the recording setting");
    }
  };

  // The uploaded replay (Nov 10, 2026): a Vimeo link the attendee page plays once the webinar is over.
  const [replayValue, setReplayValue] = useState(replayUrl);
  const replayTrimmed = replayValue.trim();
  const replayInvalid = replayTrimmed.length > 0 && parseReplayVideo(replayTrimmed) === null;
  // The SAVED link as attendees will get it, played here on request: the only way to know a
  // pasted link plays on this site (a Vimeo link can be valid and still refuse to play here).
  const savedReplay = parseReplayVideo(replayUrl);
  const [previewing, setPreviewing] = useState(false);
  // The site's own address, for the Vimeo embed setting. Not known on the server, so it is read as
  // an external value: the browser's on the client, a neutral phrase while rendering there.
  const siteHost = useSyncExternalStore(subscribeToNothing, readSiteHost, () => "this site's address");

  const saveReplay = async () => {
    if (replayInvalid) {
      toast.error(REPLAY_LINK_MESSAGE);
      return;
    }
    try {
      // The link only. It never flips "Show the recording to attendees": that switch also shows
      // Zoom's recording, so a link pasted and later removed would leave a recording the organiser
      // had hidden on offer (review of 40aded04). The line under the field says when it is off.
      await updateSettings.mutateAsync({ replayUrl: replayTrimmed });
      toast.success(replaySavedMessage(replayTrimmed, shown));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the replay link");
    }
  };

  const handleFetch = async () => {
    try {
      const result = await fetchRecording.mutateAsync();
      if (result.status === "available") {
        toast.success("Recording fetched");
      } else if (result.status === "pending") {
        toast.warning(result.reason || "Recording not ready yet");
      } else if (result.status === "expired") {
        toast.error("Recording fetch window expired (>7 days after session)");
      } else {
        toast.error(result.reason || "Failed to fetch recording");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to fetch recording");
    }
  };

  const handleCopy = async (value: string | null, label: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? `Failed to copy ${label}: ${err.message}`
          : `Failed to copy ${label}`,
      );
    }
  };

  const canFetch = sessionEnded && !!zoom;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <ConsoleTitle icon={PlayCircle} tone="violet">
              Recording
            </ConsoleTitle>
            <CardDescription>
              Your uploaded replay, or the Zoom cloud recording, which is checked automatically after the session ends.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleFetch}
            disabled={fetchRecording.isPending || !canFetch}
            title={afterSessionTitle(!!zoom, sessionEnded)}
          >
            {fetchRecording.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RotateCw className="h-4 w-4 mr-2" />
            )}
            Refetch now
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {canManage ? (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
            <label htmlFor="show-recording" className="space-y-0.5">
              <span className="block text-sm font-medium">Show the recording to attendees</span>
              <span className="block text-xs text-muted-foreground">
                Off by default. When on, registered attendees see &quot;Recording available&quot; and a Watch Replay
                button on the webinar page: your replay link below if there is one, else the Zoom recording once
                it is fetched.
              </span>
            </label>
            <Switch
              id="show-recording"
              checked={shown}
              disabled={updateSettings.isPending}
              onCheckedChange={(next) => void toggleShown(next)}
            />
          </div>
        ) : null}
        {canManage ? (
          <div className="mb-4 space-y-2 rounded-md border p-3">
            <Label htmlFor="replay-url">Replay link (Vimeo)</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="replay-url"
                name="replayUrl"
                type="url"
                inputMode="url"
                autoComplete="off"
                value={replayValue}
                onChange={(e) => setReplayValue(e.target.value)}
                maxLength={500}
                placeholder="https://vimeo.com/123456789"
                aria-invalid={replayInvalid}
                aria-describedby="replay-url-help"
              />
              <Button
                onClick={() => void saveReplay()}
                disabled={updateSettings.isPending || replayTrimmed === replayUrl.trim()}
                className="shrink-0"
              >
                {updateSettings.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                Save
              </Button>
            </div>
            <p id="replay-url-help" className={replayInvalid ? "text-xs text-red-600" : "text-xs text-muted-foreground"}>
              {replayInvalid
                ? `${REPLAY_LINK_MESSAGE}.`
                : "Upload the recording to Vimeo and paste the video's link. Once the webinar is over, registered attendees can watch it under My events and on the webinar page, in place of the Zoom recording, which expires."}
            </p>
            <p className="text-xs text-muted-foreground">
              In Vimeo, set the video&apos;s privacy to hidden from vimeo.com (embed only) and allow embedding only on{" "}
              <span className="font-mono text-foreground">{siteHost}</span>. Without both, anyone an attendee shares the
              Vimeo link with can watch it. Removing the link here does not remove the video from Vimeo.
            </p>
            {replayUrl && !shown ? (
              <p className="text-xs font-medium text-amber-700">
                Attendees cannot see this replay: switch on &quot;Show the recording to attendees&quot; above.
              </p>
            ) : null}
            {savedReplay ? (
              <div className="space-y-2 pt-1">
                <Button type="button" variant="outline" size="sm" onClick={() => setPreviewing((on) => !on)}>
                  <PlayCircle className="h-4 w-4 mr-2" />
                  {previewing ? "Hide preview" : "Preview the saved replay"}
                </Button>
                {previewing ? (
                  <>
                    {/* A check that it plays, not a viewing room: kept small. */}
                    <div className="max-w-xl">
                      <ReplayPlayer embedUrl={savedReplay.embedUrl} title="the saved replay" />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Press play. If Vimeo shows an error here, attendees will see it too: check the link and the
                      video&apos;s embed settings.
                    </p>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {!zoom ? (
          <CardEmpty message="No Zoom webinar attached yet." />
        ) : null}
        {zoom && zoom.recordingStatus === "AVAILABLE" && zoom.recordingUrl ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label className="text-muted-foreground text-xs uppercase tracking-wide">
                  Status
                </Label>
                <p>
                  {/* Its own word: the email list's "SENT" pill read as if the recording had been emailed. */}
                  <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Available</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {zoom.recordingFetchedAt
                      ? `Fetched ${fmtTz(zoom.recordingFetchedAt, eventTz)}`
                      : null}
                  </span>
                </p>
              </div>
              {zoom.recordingDuration ? (
                <div>
                  <Label className="text-muted-foreground text-xs uppercase tracking-wide">
                    Duration
                  </Label>
                  <p className="font-medium">
                    {Math.round(zoom.recordingDuration / 60)} min
                  </p>
                </div>
              ) : null}
              <div className="md:col-span-2">
                <Label className="text-muted-foreground text-xs uppercase tracking-wide">
                  Play URL
                </Label>
                <div className="flex items-center gap-2 mt-1">
                  <Input value={zoom.recordingUrl} readOnly className="font-mono text-xs" />
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    onClick={() => handleCopy(zoom.recordingUrl, "Recording URL")}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              {zoom.recordingPassword ? (
                <div>
                  <Label className="text-muted-foreground text-xs uppercase tracking-wide">
                    Passcode
                  </Label>
                  <div className="flex items-center gap-2 mt-1">
                    <Input value={zoom.recordingPassword} readOnly className="font-mono" />
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      onClick={() => handleCopy(zoom.recordingPassword, "Recording passcode")}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
            <div className="pt-2 border-t">
              <Button asChild>
                <a href={zoom.recordingUrl} target="_blank" rel="noopener noreferrer">
                  <PlayCircle className="h-4 w-4 mr-2" />
                  Watch Replay
                  <ExternalLink className="h-4 w-4 ml-2" />
                </a>
              </Button>
            </div>
          </div>
        ) : null}
        {zoom && zoom.recordingStatus === "PENDING" ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-6 text-center">
            <Loader2 className="h-6 w-6 text-amber-600 animate-spin mx-auto mb-2" />
            <p className="text-sm font-medium">Recording processing</p>
            <p className="text-xs text-muted-foreground mt-1">
              Zoom is still finalizing the recording. The cron worker will keep polling every 5 min for up to 7 days.
            </p>
          </div>
        ) : null}
        {zoom && zoom.recordingStatus === "FAILED" ? (
          <div className="rounded-lg border border-red-200 bg-red-50/50 p-6 text-center">
            <XCircle className="h-6 w-6 text-red-600 mx-auto mb-2" />
            <p className="text-sm font-medium">Fetch failed</p>
            <p className="text-xs text-muted-foreground mt-1">
              Click Refetch to try again. Clicking Refetch resets the status so the cron can retry too.
            </p>
          </div>
        ) : null}
        {zoom && zoom.recordingStatus === "EXPIRED" ? (
          <div className="rounded-lg border border-gray-200 bg-gray-50/50 p-6 text-center">
            <XCircle className="h-6 w-6 text-gray-500 mx-auto mb-2" />
            <p className="text-sm font-medium">Fetch window expired</p>
            <p className="text-xs text-muted-foreground mt-1">
              More than 7 days have passed since the session. Click Refetch to try one more time if the recording is still on Zoom.
            </p>
          </div>
        ) : null}
        {zoom && !(zoom.recordingStatus === "AVAILABLE" && zoom.recordingUrl) && zoom.recordingStatus !== "PENDING" && zoom.recordingStatus !== "FAILED" && zoom.recordingStatus !== "EXPIRED" ? (
          // NOT_REQUESTED — session not ended yet, or cloud recording is off
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {sessionEnded
              ? "Cloud recording not yet polled. Click Refetch to start."
              : "Recording will be fetched automatically after the session ends (if cloud recording is enabled)."}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ── Panelists ──────────────────────────────────────────────────────

function PanelistsCard({
  eventId,
  hasZoom,
}: {
  eventId: string;
  hasZoom: boolean;
}) {
  const canManageWebinar = useCan("webinar.manage", eventId) === "allowed";
  const { data, isLoading, error } = useWebinarPanelists(eventId, canManageWebinar);
  const addPanelist = useAddWebinarPanelist(eventId);
  const removePanelist = useRemoveWebinarPanelist(eventId);
  const syncSpeakers = useSyncSpeakersToPanelists(eventId);
  const resendInvite = useResendPanelistInvite(eventId);
  const [pendingResendId, setPendingResendId] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");

  const panelists: WebinarPanelist[] = data?.panelists ?? [];
  const disabled = !hasZoom;

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newEmail.trim()) return;
    const name = newName.trim();
    const email = newEmail.trim();
    // Clear the form immediately — the optimistic update (via onMutate in
    // the hook) already inserts a greyed-out row, so the user sees the row
    // appear and the form reset at the same moment.
    setNewName("");
    setNewEmail("");
    try {
      const result = await addPanelist.mutateAsync({ name, email });
      toast.success(
        result.invitesQueued
          ? `Added ${name}. Invite email sent`
          : `Added ${name} as panelist`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add panelist");
      // Restore form so the user doesn't have to retype on failure
      setNewName(name);
      setNewEmail(email);
    }
  };

  const handleRemove = async (panelist: WebinarPanelist) => {
    try {
      await removePanelist.mutateAsync(panelist.id);
      toast.success(`Removed ${panelist.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove panelist");
    }
  };

  const handleCopyJoinUrl = async (panelist: WebinarPanelist) => {
    if (!panelist.join_url) return;
    try {
      await navigator.clipboard.writeText(panelist.join_url);
      toast.success(`Copied join link for ${panelist.name}`);
    } catch {
      toast.error("Failed to copy link. Try again");
    }
  };

  const handleResendInvite = async (panelist: WebinarPanelist) => {
    setPendingResendId(panelist.id);
    try {
      await resendInvite.mutateAsync(panelist.id);
      toast.success(`Invite resent to ${panelist.email}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to resend invite");
    } finally {
      setPendingResendId(null);
    }
  };

  const handleSyncSpeakers = async () => {
    try {
      const result = await syncSpeakers.mutateAsync();
      if (result.added > 0) {
        const skipNotes: string[] = [];
        if (result.skippedNoEmail) skipNotes.push(`${result.skippedNoEmail} no email`);
        if (result.skippedAlreadyPanelist) {
          skipNotes.push(`${result.skippedAlreadyPanelist} already panelist`);
        }
        const skipped = skipNotes.length ? ` (${skipNotes.join(", ")})` : "";
        const invited = result.invitesQueued
          ? `, ${result.invitesQueued} invite${result.invitesQueued === 1 ? "" : "s"} sent`
          : "";
        toast.success(
          `Added ${result.added} speaker${result.added === 1 ? "" : "s"} as panelist${result.added === 1 ? "" : "s"}${skipped}${invited}`,
        );
      } else {
        toast.warning(result.reason ?? "No speakers to import");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to import speakers");
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <ConsoleTitle icon={UserPlus} tone="amber">
              Panelists
            </ConsoleTitle>
            <CardDescription>
              Panelists get a privileged Zoom join link and can present on screen.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSyncSpeakers}
            disabled={disabled || syncSpeakers.isPending}
            title={disabled ? "Attach a Zoom webinar first" : "Import all session speakers with an email address"}
          >
            {syncSpeakers.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Users className="h-4 w-4 mr-2" />
            )}
            Import from Speakers
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!hasZoom ? (
          <CardEmpty message="No Zoom webinar attached yet." />
        ) : null}
        {hasZoom && isLoading ? (
          <CardLoading />
        ) : null}
        {hasZoom && !isLoading && error ? (
          <div className="rounded-lg border border-red-200 bg-red-50/50 p-4 text-sm text-red-700">
            {error instanceof Error ? error.message : "Failed to load panelists"}
          </div>
        ) : null}
        {hasZoom && !isLoading && !error ? (
          <>
            <form onSubmit={handleAdd} className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-2">
              <Input
                placeholder="Name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                disabled={disabled}
              />
              <Input
                type="email"
                placeholder="Email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                disabled={disabled}
              />
              <Button
                type="submit"
                disabled={disabled || !newName.trim() || !newEmail.trim()}
              >
                <UserPlus className="h-4 w-4 mr-2" />
                Add
              </Button>
            </form>

            {panelists.length === 0 ? (
              <CardEmpty message="No panelists yet. Add one above or import from speakers." />
            ) : (
              <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wide">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Name</th>
                      <th className="px-3 py-2 text-left font-medium">Email</th>
                      <th className="px-3 py-2 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {panelists.map((p) => {
                      const isOptimistic = p.id.startsWith(OPTIMISTIC_PANELIST_PREFIX);
                      const isResending =
                        pendingResendId === p.id && resendInvite.isPending;
                      return (
                        <tr
                          key={p.id}
                          className={
                            isOptimistic
                              ? "bg-muted/20 text-muted-foreground italic"
                              : "hover:bg-muted/30"
                          }
                          title={isOptimistic ? "Saving…" : undefined}
                        >
                          <td className="px-3 py-2 font-medium">
                            {p.name}
                            {isOptimistic ? (
                              <Loader2 className="inline-block h-3 w-3 ml-2 animate-spin" />
                            ) : null}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">{p.email}</td>
                          <td className="px-3 py-2">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleCopyJoinUrl(p)}
                                disabled={isOptimistic || !p.join_url}
                                title={
                                  p.join_url
                                    ? "Copy privileged panelist join link"
                                    : "Join link not available yet"
                                }
                              >
                                <Copy className="h-4 w-4" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleResendInvite(p)}
                                disabled={isOptimistic || isResending}
                                title="Resend the panelist invitation email"
                              >
                                {isResending ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Mail className="h-4 w-4" />
                                )}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleRemove(p)}
                                disabled={removePanelist.isPending || isOptimistic}
                                className="text-red-600 hover:text-red-700 hover:bg-red-50"
                                title="Remove panelist"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ── Polls ──────────────────────────────────────────────────────────

// ── Q&A ────────────────────────────────────────────────────────────

/** Viewers removed from the webinar, with Let back in (Nov 25, 2026). */
function RemovedViewersList({
  removed,
  canManage,
  pending,
  onLetBackIn,
}: {
  removed: WebinarRemovedViewer[];
  canManage: boolean;
  pending: boolean;
  onLetBackIn: (r: WebinarRemovedViewer) => void;
}) {
  return (
    <div className="max-h-48 divide-y overflow-y-auto rounded-lg border border-red-100 bg-red-50/30">
      {removed.map((r) => (
        <div key={r.registrationId} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
          <div className="min-w-0">
            <p className="truncate font-medium">{r.name}</p>
            <p className="truncate text-xs text-muted-foreground">{r.email ?? ""}</p>
          </div>
          {canManage && (
            <Button size="sm" variant="outline" className="h-7 shrink-0 px-2 text-xs" disabled={pending} onClick={() => onLetBackIn(r)}>
              Let back in
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

function LiveNowCard({ eventId, live }: { eventId: string; live: boolean }) {
  // Polled while the room is live; read once otherwise, so the removed list (and Let back in) stays
  // reachable after the room closes (review of eeebe2b2b: the block also covers the replay).
  const { data, isLoading } = useWebinarPresence(eventId, true, live);
  // Remove a viewer (owner, Nov 25, 2026): block this webinar only, their page stops within ~30 s.
  const canManage = useCan("webinar.manage", eventId) === "allowed";
  const setRemoved = useSetWebinarViewerRemoved(eventId);
  const [confirmRemove, setConfirmRemove] = useState<{ registrationId: string; name: string } | null>(null);
  const changeRemoved = async (registrationId: string, removed: boolean, name: string) => {
    try {
      await setRemoved.mutateAsync({ registrationId, removed });
      toast.success(removed ? `${name} removed from the webinar` : `${name} can watch again`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change the viewer");
    }
  };

  if (!live) {
    const removedOnly = data?.removed ?? [];
    if (removedOnly.length === 0) return null;
    return (
      <Card>
        <CardHeader>
          <ConsoleTitle icon={CircleDot} tone="red">
            Removed from this webinar
          </ConsoleTitle>
          <CardDescription>
            They cannot watch, ask, chat or open the replay on our pages. Let someone back in here; they see it when they
            next open or reload the page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RemovedViewersList
            removed={removedOnly}
            canManage={canManage}
            pending={setRemoved.isPending}
            onLetBackIn={(r) => void changeRemoved(r.registrationId, false, r.name)}
          />
        </CardContent>
      </Card>
    );
  }


  return (
    <Card>
      <CardHeader>
        <ConsoleTitle icon={CircleDot} tone="red" pulse>
          Live now
        </ConsoleTitle>
        <CardDescription>
          Registrants currently on the webinar page (heartbeat in the last 60s), and everyone who has opened it
          so far: lobby-page presence, distinct from the post-event attendance report.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <CardLoading />
        ) : null}
        {!isLoading && (!data || data.total === 0) ? (
          <CardEmpty message={data?.opened ? `No attendees on the page right now. ${data.opened} opened it so far.` : "No attendees on the page right now."} />
        ) : null}
        {!isLoading && data && data.total !== 0 ? (
          <>
            <div className="mb-4 flex gap-3">
              <div className="flex-1 rounded-lg border p-3 text-center">
                <p className="text-2xl font-bold">{data.lobby}</p>
                <p className="text-xs text-muted-foreground">In lobby</p>
              </div>
              <div className="flex-1 rounded-lg border border-emerald-200 bg-emerald-50/50 p-3 text-center">
                <p className="text-2xl font-bold text-emerald-700">{data.joined}</p>
                <p className="text-xs text-muted-foreground">Joined</p>
              </div>
              {/* Everyone who has ever opened the page, here now or not (owner, Nov 25, 2026); the same
                  set as the attendance report's "Opened the page". `?? "-"`: an older container's answer
                  has no count during a deploy. */}
              <div className="flex-1 rounded-lg border p-3 text-center" title="Everyone who has opened the webinar page so far, counted once per registration">
                <p className="text-2xl font-bold">{data.opened ?? "-"}</p>
                <p className="text-xs text-muted-foreground">Opened so far</p>
              </div>
            </div>
            <div className="max-h-72 divide-y overflow-y-auto rounded-lg border">
              {data.rows.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{r.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {r.email ?? ""}
                      {r.serialId != null ? ` · #${String(r.serialId).padStart(3, "0")}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge
                      variant={r.phase === "joined" ? undefined : "outline"}
                      className={
                        r.phase === "joined"
                          ? "bg-emerald-100 text-emerald-800 border-emerald-200"
                          : ""
                      }
                    >
                      {r.phase === "joined" ? "Joined" : "Lobby"}
                    </Badge>
                    {canManage && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs text-red-600 hover:bg-red-50 hover:text-red-700"
                        disabled={setRemoved.isPending}
                        onClick={() => setConfirmRemove({ registrationId: r.registrationId, name: r.name })}
                        aria-label={`Remove ${r.name} from the webinar`}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : null}
        {(data?.removed?.length ?? 0) > 0 && (
          <div className="mt-4 space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Removed from this webinar ({data?.removed.length})</p>
            <RemovedViewersList
              removed={data?.removed ?? []}
              canManage={canManage}
              pending={setRemoved.isPending}
              onLetBackIn={(r) => void changeRemoved(r.registrationId, false, r.name)}
            />
          </div>
        )}
      </CardContent>
      <AlertDialog open={confirmRemove !== null} onOpenChange={(open) => !open && setConfirmRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {confirmRemove?.name} from the webinar?</AlertDialogTitle>
            <AlertDialogDescription>
              Their page stops the video within about 30 seconds and tells them they were removed, and on our pages they can no
              longer watch, ask questions, chat, vote or open the replay. Their registration is not changed, and they still get
              the webinar emails (a Zoom recording link in one still works). What they already posted stays: delete it from
              the Q&amp;A and Chat tabs if needed. You can let them back in from this card.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep watching</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={setRemoved.isPending}
              onClick={() => {
                const target = confirmRemove;
                setConfirmRemove(null);
                if (target) void changeRemoved(target.registrationId, true, target.name);
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/** Grace window after the scheduled end during which the overdue alert still shows. */
const ROOM_OVERDUE_GRACE_MS = 30 * 60_000;

type ViewerQuestionFilter = "NEW" | "SHOWN" | "ANSWERED" | "DISMISSED" | "ALL";

const VIEWER_QUESTION_FILTERS: { key: ViewerQuestionFilter; label: string }[] = [
  { key: "NEW", label: "New" },
  { key: "SHOWN", label: "Shown to attendees" },
  { key: "ANSWERED", label: "Answered" },
  { key: "DISMISSED", label: "Dismissed" },
  { key: "ALL", label: "All" },
];

function matchesViewerFilter(q: WebinarViewerQuestionRow, filter: ViewerQuestionFilter): boolean {
  if (filter === "ALL") return true;
  if (filter === "SHOWN") return q.isPublic && q.status !== "DISMISSED";
  return q.status === filter;
}

const POLL_STATUS_LABEL: Record<LivePollRow["status"], string> = { DRAFT: "Draft", OPEN: "Open", CLOSED: "Closed" };

/**
 * Live polls (Oct 6, 2026; docs/WEBINAR_INTERACTION_PLAN.md §5). The
 * organiser's "Enable live polls" switch (off by default), drafts prepared
 * ahead, Launch (closes any other open poll), Close, show results to
 * attendees, live counts refreshed every 5 seconds, and a CSV per poll.
 * Producers (webinar.manage) change things; others watch.
 */
function LivePollsPanel({ eventId, enabled }: { eventId: string; enabled: boolean }) {
  const canManage = useCan("webinar.manage", eventId) === "allowed";
  const canExport = useCan("webinar.attendance.export", eventId) === "allowed";
  const { data: polls = [], isLoading, isError } = useLivePolls(eventId, true);
  const updateSettings = useUpdateWebinarSettings(eventId);
  const create = useCreateLivePoll(eventId);
  const update = useUpdateLivePoll(eventId);
  const remove = useDeleteLivePoll(eventId);
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<LivePollRow | null>(null);

  const toggleEnabled = async (next: boolean) => {
    try {
      await updateSettings.mutateAsync({ livePolls: next });
      toast.success(next ? "Live polls are on for this webinar" : "Live polls are off");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change live polls");
    }
  };

  const saveDraft = async () => {
    try {
      await create.mutateAsync({ question, options: options.map((o) => o.trim()), allowMultiple });
      setQuestion("");
      setOptions(["", ""]);
      setAllowMultiple(false);
      toast.success("Poll saved as a draft");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the poll");
    }
  };

  const act = async (pollId: string, body: { action: "launch" | "close" } | { showResults: boolean }, done: string) => {
    try {
      await update.mutateAsync({ pollId, ...body });
      toast.success(done);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the poll");
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await remove.mutateAsync(pendingDelete.id);
      toast.success("Poll deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete the poll");
    } finally {
      setPendingDelete(null);
    }
  };

  const draftReady =
    question.trim().length >= 3 && options.filter((o) => o.trim()).length === options.length && options.length >= MIN_POLL_OPTIONS;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <ConsoleTitle icon={BarChart3} tone="sky">
            Live polls
          </ConsoleTitle>
          <CardDescription>
            Ask the audience a question during the webinar. Attendees answer beside the video, once; you see the counts
            here as they come in, and choose whether attendees see the results.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-md border p-3">
            <label htmlFor="live-polls-enabled" className="space-y-0.5">
              <span className="block text-sm font-medium">Enable live polls</span>
              <span className="block text-xs text-muted-foreground">
                Off: nothing reaches attendees and no poll can be launched. Drafts can still be prepared.
              </span>
            </label>
            <Switch
              id="live-polls-enabled"
              checked={enabled}
              disabled={!canManage || updateSettings.isPending}
              onCheckedChange={(next) => void toggleEnabled(next)}
            />
          </div>

          {canManage && (
            <div className="space-y-3 rounded-md border p-3">
              <p className="text-sm font-medium">New poll</p>
              <div className="space-y-1.5">
                <Label htmlFor="poll-question">Question</Label>
                <Input
                  id="poll-question"
                  value={question}
                  maxLength={POLL_QUESTION_MAX}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="Which treatment do you use first?"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Options</Label>
                {options.map((o, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={o}
                      maxLength={POLL_OPTION_MAX}
                      onChange={(e) => setOptions((prev) => prev.map((p, j) => (j === i ? e.target.value : p)))}
                      placeholder={`Option ${i + 1}`}
                      aria-label={`Option ${i + 1}`}
                    />
                    {options.length > MIN_POLL_OPTIONS && (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-9 w-9 shrink-0"
                        onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))}
                        aria-label={`Remove option ${i + 1}`}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
                {options.length < MAX_POLL_OPTIONS && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => setOptions((prev) => [...prev, ""])}>
                    <Plus className="h-4 w-4 mr-1" />
                    Add option
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={allowMultiple} onCheckedChange={setAllowMultiple} aria-label="Allow more than one answer" />
                  Allow more than one answer
                </label>
                <Button size="sm" onClick={() => void saveDraft()} disabled={!draftReady || create.isPending}>
                  {create.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                  Save draft
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {isError && <p className="text-sm text-red-600">Could not load the polls. Retrying…</p>}
      {!isLoading && polls.length === 0 && (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No polls yet.</p>
      )}

      <ul className="space-y-3">
        {polls.map((p) => (
          <li key={p.id} className={`rounded-lg border p-4 ${p.status === "OPEN" ? "border-primary/50 bg-primary/5" : ""}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <Badge variant={p.status === "OPEN" ? "default" : "outline"}>{POLL_STATUS_LABEL[p.status]}</Badge>
                  {p.allowMultiple && <span className="text-xs text-muted-foreground">Several answers allowed</span>}
                  {p.showResults && p.status === "OPEN" && (
                    <span className="text-xs font-medium text-primary">Results shown to attendees who answered</span>
                  )}
                </div>
                <p className="font-medium whitespace-pre-wrap break-words">{p.question}</p>
              </div>
              <span className="text-sm tabular-nums text-muted-foreground">
                {p.tally.voters} {p.tally.voters === 1 ? "answer" : "answers"}
              </span>
            </div>
            <ul className="mt-3 space-y-2">
              {p.options.map((o) => {
                const count = p.tally.counts[o.id] ?? 0;
                const pct = percentOf(count, p.tally.voters);
                return (
                  <li key={o.id} className="space-y-1">
                    <div className="flex justify-between gap-2 text-sm">
                      <span>{o.label}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {count} · {pct}%
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
              {canManage && p.status !== "OPEN" && (
                <Button
                  size="sm"
                  disabled={update.isPending || !enabled}
                  title={enabled ? undefined : "Turn on Enable live polls first"}
                  onClick={() => void act(p.id, { action: "launch" }, p.status === "CLOSED" ? "Poll reopened" : "Poll launched")}
                >
                  {p.status === "CLOSED" ? "Reopen" : "Launch"}
                </Button>
              )}
              {canManage && p.status === "OPEN" && (
                <Button size="sm" variant="outline" disabled={update.isPending} onClick={() => void act(p.id, { action: "close" }, "Poll closed")}>
                  Close poll
                </Button>
              )}
              {/* Only while open: a closed poll leaves the attendee page at once,
                  results and all (Nov 5, 2026), so the switch would do nothing. */}
              {canManage && p.status === "OPEN" && (
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={p.showResults}
                    disabled={update.isPending}
                    onCheckedChange={(next) =>
                      void act(p.id, { showResults: next }, next ? "Results shown to attendees" : "Results hidden from attendees")
                    }
                    aria-label="Show results to attendees who answered"
                  />
                  Show results to attendees who answered
                </label>
              )}
              <span className="flex-1" />
              {canExport && p.tally.voters > 0 && (
                <Button size="sm" variant="ghost" asChild>
                  <a href={`/api/events/${eventId}/webinar/polls/${encodeURIComponent(p.id)}/export`}>
                    <Download className="h-4 w-4 mr-1" />
                    CSV
                  </a>
                </Button>
              )}
              {canManage && p.tally.voters === 0 && p.status !== "OPEN" && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-red-600 hover:text-red-700"
                  onClick={() => setPendingDelete(p)}
                  aria-label={`Delete poll ${p.question}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this poll?</AlertDialogTitle>
            <AlertDialogDescription>&quot;{pendingDelete?.question}&quot; has no answers and will be removed.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * The console's Q&A tab (owner, Oct 1, 2026): questions from custom-stream
 * viewers, who are not in Zoom, at full width with filters. Newest first,
 * refreshed every 10 seconds (the same query the tab badge reads, so React
 * Query shares one poll). Only questions shown here appear in the attendees'
 * Q&A panel beside the video, anonymously (attendees never see who asked).
 */
function ViewerQuestionsPanel({ eventId, upvote }: { eventId: string; upvote: boolean }) {
  const eventTz = useEventTz();
  const { data, isLoading, isError } = useWebinarViewerQuestions(eventId, true);
  const update = useUpdateWebinarViewerQuestion(eventId);
  const updateSettings = useUpdateWebinarSettings(eventId);
  // The upvote switch is a settings write: shown only to producers, so a
  // read-only viewer never flips it into a 403 (review of upvotes).
  const canManage = useCan("webinar.manage", eventId) === "allowed";
  const [filter, setFilter] = useState<ViewerQuestionFilter>("NEW");
  const [byVotes, setByVotes] = useState(false);
  const questions = data?.questions ?? [];
  const filtered = questions.filter((q) => matchesViewerFilter(q, filter));
  // Most-wanted first: votes, then newest (the list arrives newest first).
  const shown = byVotes ? [...filtered].sort((a, b) => b.voteCount - a.voteCount) : filtered;

  const toggleUpvote = async (next: boolean) => {
    try {
      await updateSettings.mutateAsync({ qaUpvote: next });
      toast.success(next ? "Attendees can upvote shown questions" : "Upvotes switched off");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change upvotes");
    }
  };

  const mark = async (id: string, change: { status?: "NEW" | "ANSWERED" | "DISMISSED"; isPublic?: boolean }) => {
    try {
      await update.mutateAsync({ id, ...change });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the question");
    }
  };

  return (
    <Card>
      <CardHeader>
        <ConsoleTitle icon={MessageSquare} tone="violet">
          Viewer questions
        </ConsoleTitle>
        <CardDescription>
          From people watching the custom stream, newest first, refreshed every 10 seconds. Only
          questions you show appear in the Q&amp;A panel beside the attendees&apos; video, without the asker&apos;s name;
          dismissing a question also hides it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canManage && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
          <label htmlFor="qa-upvote" className="space-y-0.5">
            <span className="block text-sm font-medium">Let attendees upvote shown questions</span>
            <span className="block text-xs text-muted-foreground">
              One vote per person per question, so the most-wanted question is easy to pick.
            </span>
          </label>
          <Switch
            id="qa-upvote"
            checked={upvote}
            disabled={updateSettings.isPending}
            onCheckedChange={(next) => void toggleUpvote(next)}
          />
        </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filter questions">
          {VIEWER_QUESTION_FILTERS.map((f) => {
            const count = questions.filter((q) => matchesViewerFilter(q, f.key)).length;
            const active = filter === f.key;
            return (
              <Button
                key={f.key}
                size="sm"
                variant={active ? "default" : "outline"}
                className="h-8"
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                <span className={`ml-1.5 text-xs ${active ? "opacity-90" : "text-muted-foreground"}`}>{count}</span>
              </Button>
            );
          })}
        </div>
          <Button
            size="sm"
            variant={byVotes ? "secondary" : "ghost"}
            className="h-8 text-xs"
            aria-pressed={byVotes}
            onClick={() => setByVotes((v) => !v)}
          >
            <ThumbsUp className="h-3.5 w-3.5 mr-1" />
            {byVotes ? "Sorted by votes" : "Sort by votes"}
          </Button>
        </div>

        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {isError && <p className="text-sm text-red-600">Could not load questions. Retrying…</p>}
        {!isLoading && shown.length === 0 && (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            {filter === "NEW" ? "No new questions." : "Nothing here."}
          </p>
        )}

        <ul className="space-y-2">
          {shown.map((q) => (
            <li
              key={q.id}
              className={`rounded-md border p-4 ${q.status === "DISMISSED" ? "opacity-60" : ""} ${q.isPublic && q.status !== "DISMISSED" ? "border-primary/40 bg-primary/5" : ""}`}
            >
              <p className="whitespace-pre-wrap break-words">{q.question}</p>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {q.askerName} · {fmtTz(q.createdAt, eventTz, { short: true })}
                  {q.status === "ANSWERED" ? <span className="ml-1 font-medium">· Answered</span> : null}
                  {q.status === "DISMISSED" ? <span className="ml-1 font-medium">· Dismissed</span> : null}
                  {q.isPublic && q.status !== "DISMISSED" ? (
                    <span className="ml-1 font-medium text-primary">· Shown to attendees</span>
                  ) : null}
                  {q.voteCount > 0 ? (
                    <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-medium text-foreground">
                      <ThumbsUp className="h-3 w-3" />
                      {q.voteCount}
                    </span>
                  ) : null}
                </span>
                <div className="flex flex-wrap gap-1">
                  {q.status !== "DISMISSED" && (
                    <Button
                      size="sm"
                      variant={q.isPublic ? "secondary" : "outline"}
                      className="h-8 text-xs"
                      disabled={update.isPending}
                      onClick={() => void mark(q.id, { isPublic: !q.isPublic })}
                      title={q.isPublic ? "Hide from the attendees' Q&A panel" : "Show in the attendees' Q&A panel"}
                    >
                      {q.isPublic ? <EyeOff className="h-3.5 w-3.5 mr-1" /> : <Eye className="h-3.5 w-3.5 mr-1" />}
                      {q.isPublic ? "Hide" : "Show to attendees"}
                    </Button>
                  )}
                  {q.status === "NEW" ? (
                    <>
                      <Button size="sm" variant="outline" className="h-8 text-xs" disabled={update.isPending} onClick={() => void mark(q.id, { status: "ANSWERED" })}>
                        Answered
                      </Button>
                      <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={update.isPending} onClick={() => void mark(q.id, { status: "DISMISSED" })}>
                        Dismiss
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={update.isPending} onClick={() => void mark(q.id, { status: "NEW" })}>
                      Undo
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// Zoom accepts one custom-stream start request per 30 seconds and answers
// 429 to anything faster (prod logs, Oct 1, 2026), so retry on that beat:
// five tries, about two and a half minutes.
const STREAM_START_RETRIES = 5;
const STREAM_START_RETRY_MS = 30_000;

function customStreamToggledText(open: boolean): string {
  return open ? "Custom stream started" : "Custom stream stopped";
}

/** After a room toggle in custom-stream mode, say what happened to the stream. */
function announceStreamResult(
  stream: { ok: true; alreadyLive?: true } | { ok: false; error: string } | undefined,
  open: boolean,
) {
  if (!stream) return;
  if (stream.ok) {
    toast.success(
      stream.alreadyLive ? "The stream was already running" : customStreamToggledText(open),
    );
    return;
  }
  toast.warning(
    open
      ? `The room is open, but the stream did not start: ${stream.error}`
      : `The room is closed, but the stream did not stop: ${stream.error}`,
  );
}

function streamArrivalLabel(state: "checking" | "active" | "idle" | "ended"): { text: string; tone: string } {
  if (state === "active") return { text: "Stream is arriving", tone: "bg-green-100 text-green-800" };
  if (state === "checking") return { text: "Checking…", tone: "bg-slate-100 text-slate-700" };
  return { text: "No stream yet", tone: "bg-amber-100 text-amber-800" };
}

/**
 * The producer's stream check (owner feedback, Oct 2, 2026): the same player
 * attendees get, inside the console, so the team sees whether the video is
 * arriving before opening the room instead of testing on the public page.
 * Closed by default so the console does not load hls.js or poll the stream
 * until someone asks. Starts muted, like the attendee player.
 */
function StreamPreview({
  eventId,
  eventSlug,
  sessionId,
  partner = false,
}: {
  eventId: string;
  eventSlug: string;
  sessionId: string;
  /** A partner's stream: nothing to send to Zoom, the fix is issuing their key. */
  partner?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"checking" | "active" | "idle" | "ended">("checking");
  const preview = useWebinarStreamPreview(eventId, open);
  const hlsUrl = preview.data?.hlsPreviewUrl ?? null;
  const timezone = useEventTz();
  // Delay measurement (Oct 2, 2026): the player reports timing about once a
  // second; the clock offset puts both ends on the server's clock.
  const { offsetMs, status: clockStatus } = useServerClock(open);
  const videoBoxRef = useRef<HTMLDivElement>(null);
  const latestSampleRef = useRef<PlayerTimingSample | null>(null);
  const [sample, setSample] = useState<PlayerTimingSample | null>(null);
  const onTimingSample = useCallback((s: PlayerTimingSample) => {
    latestSampleRef.current = s;
    setSample(s);
  }, []);

  const label = streamArrivalLabel(state);

  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">Preview</p>
          {open && hlsUrl && (
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${label.tone}`}>{label.text}</span>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setState("checking");
            setOpen((v) => !v);
          }}
          className="gap-2"
        >
          {open ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          {open ? "Hide preview" : "Preview the stream"}
        </Button>
      </div>
      {open && (
        <>
          {preview.isLoading && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading the preview…
            </p>
          )}
          {preview.isError && (
            <p className="text-sm text-red-600">
              {preview.error instanceof Error ? preview.error.message : "Could not load the preview"}
            </p>
          )}
          {preview.data && !hlsUrl && (
            <p className="text-sm text-muted-foreground">
              {partner
                ? "No partner key has been issued yet. Issue it in the Partner stream card."
                : "The stream is not set up for this session yet. Press Re-send stream settings to Zoom."}
            </p>
          )}
          {hlsUrl && (
            <>
              <div ref={videoBoxRef}>
                <LivePlayer
                  hlsUrl={hlsUrl}
                  slug={eventSlug}
                  sessionId={sessionId}
                  onStreamStatusChange={setState}
                  onTimingSample={onTimingSample}
                  measurable
                />
              </div>
              <p className="text-xs text-muted-foreground">
                What attendees will see once the room is open. It checks again every 10 seconds, so
                leave it open {partner ? "while the partner starts their stream" : "after pressing Start stream"}.
              </p>
              <StreamDelay
                videoBoxRef={videoBoxRef}
                latestSampleRef={latestSampleRef}
                sample={sample}
                offsetMs={offsetMs}
                clockStatus={clockStatus}
                timezone={timezone}
                playing={state === "active"}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

const STREAM_ACTION_SUCCESS: Record<"sync" | "start" | "stop", string> = {
  sync: "Stream settings sent to Zoom",
  start: "Zoom is starting the stream; attendees see it within about 20 seconds",
  stop: "Stream stopped",
};

function LobbyCard({
  eventId,
  eventSlug,
  webinar,
  anchor,
  partner,
}: {
  eventId: string;
  eventSlug: string | null;
  webinar: WebinarConsoleData["webinar"];
  anchor: WebinarConsoleData["anchorSession"];
  /** Streamed by a partner: always the custom stream, and nothing to ask Zoom. */
  partner: boolean;
}) {
  const updateSettings = useUpdateWebinarSettings(eventId);
  const liveStream = useWebinarLiveStream(eventId);

  const runStreamAction = async (action: "sync" | "start" | "stop") => {
    try {
      const res = await liveStream.mutateAsync(action);
      if (res.notRunning) {
        toast.info("No stream was running", {
          description: "The webinar has not started in Zoom yet, so there was nothing to stop.",
        });
        return;
      }
      toast.success(STREAM_ACTION_SUCCESS[action]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Stream control failed");
    }
  };

  const [viewingMode, setViewingMode] = useState<"zoom" | "hls">(
    () => webinar.viewingMode ?? "zoom",
  );
  const [lobbyVideoUrl, setLobbyVideoUrl] = useState(() => webinar.lobbyVideoUrl ?? "");
  const [lobbyImageUrl, setLobbyImageUrl] = useState(() => webinar.lobbyImageUrl ?? "");
  const [lobbyMessage, setLobbyMessage] = useState(() => webinar.lobbyMessage ?? "");

  const roomOpen = anchor?.status === "LIVE";

  const videoInvalid =
    lobbyVideoUrl.trim().length > 0 && !isValidLobbyVideoUrl(lobbyVideoUrl.trim());

  const handleSave = async () => {
    if (videoInvalid) {
      toast.error("Holding video must be a YouTube or Vimeo link");
      return;
    }
    try {
      await updateSettings.mutateAsync({
        viewingMode,
        lobbyVideoUrl: lobbyVideoUrl.trim(),
        lobbyImageUrl,
        lobbyMessage: lobbyMessage.trim(),
      });
      toast.success("Lobby settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save lobby settings");
    }
  };

  if (!anchor) {
    return (
      <Card>
        <CardHeader>
          <ConsoleTitle icon={PlayCircle} tone="violet">
            Waiting Room
          </ConsoleTitle>
          <CardDescription>
            Run the provisioner to create the webinar session first.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <ConsoleTitle icon={PlayCircle} tone="violet">
              Waiting Room
            </ConsoleTitle>
            <CardDescription>
              Hold registered attendees in a lobby, then admit them from the Go live card. The logo, background and footer are on the Branding tab.
            </CardDescription>
          </div>
          <Badge
            variant={roomOpen ? undefined : "outline"}
            className={roomOpen ? "bg-red-100 text-red-800 border-red-200" : ""}
          >
            {roomOpen ? "Room OPEN" : "Room closed"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">

        {/* A partner's webinar is always watched as the custom stream, and the partner starts it. */}
        {partner && (
          <div className="space-y-3 rounded-lg border p-4">
            <div>
              <p className="font-medium">How attendees watch</p>
              <p className="text-sm text-muted-foreground">
                The partner&apos;s stream, in our player, with questions in the box under the video. The partner
                starts and stops their own stream; check the preview before you open the room.
              </p>
            </div>
            {eventSlug && anchor && (
              <StreamPreview eventId={eventId} eventSlug={eventSlug} sessionId={anchor.id} partner />
            )}
          </div>
        )}

        {/* Viewing mode */}
        {!partner && (
        <div className="space-y-2">
          <Label>How attendees watch</Label>
          <Select value={viewingMode} onValueChange={(v) => setViewingMode(v as "zoom" | "hls")}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* The chosen mode is shaded in the theme colour, not just ticked. */}
              <SelectItem value="zoom" className="data-[state=checked]:bg-primary/10 data-[state=checked]:text-primary data-[state=checked]:font-medium">
                Zoom embed: interactive, native Q&amp;A/chat
              </SelectItem>
              <SelectItem value="hls" className="data-[state=checked]:bg-primary/10 data-[state=checked]:text-primary data-[state=checked]:font-medium">
                Custom stream: one-way broadcast, scales to thousands
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            {viewingMode === "zoom"
              ? "Counts against your Zoom webinar capacity; supports Q&A moderation."
              : "One full-width video for unlimited viewers; questions come in through the box under the video. Saving sets the stream up in Zoom for you."}
          </p>
        </div>
        )}

        {/* Custom stream controls. Shown for the SAVED mode, so the buttons
            match what attendees actually get. Zoom only starts pushing once
            the host has started the webinar; opening the room tries it too. */}
        {webinar.viewingMode === "hls" && !partner && (
          <div className="space-y-3 rounded-lg border p-4">
            <div>
              <p className="font-medium">Custom stream</p>
              <p className="text-sm text-muted-foreground">
                Start the webinar as host in Zoom first, then press Start stream and check the
                preview below before you open the room; attendees stay in the waiting room until
                then. Opening the room also starts the stream if it is not running yet. Re-send
                the settings if the session was set up before streaming was on, or if the stream
                never arrives.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => void runStreamAction("start")}
                disabled={liveStream.isPending}
                className="bg-red-600 hover:bg-red-700"
              >
                {liveStream.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Radio className="h-4 w-4 mr-2" />}
                Start stream
              </Button>
              <Button size="sm" variant="outline" onClick={() => void runStreamAction("stop")} disabled={liveStream.isPending}>
                Stop stream
              </Button>
              <Button size="sm" variant="outline" onClick={() => void runStreamAction("sync")} disabled={liveStream.isPending}>
                Re-send stream settings to Zoom
              </Button>
            </div>
            {eventSlug && anchor && (
              <StreamPreview eventId={eventId} eventSlug={eventSlug} sessionId={anchor.id} />
            )}
          </div>
        )}

        {/* Holding video */}
        <div className="space-y-2">
          <Label htmlFor="lobby-video">Holding video (YouTube or Vimeo)</Label>
          <Input
            id="lobby-video"
            value={lobbyVideoUrl}
            onChange={(e) => setLobbyVideoUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=…"
            className={videoInvalid ? "border-red-400" : ""}
          />
          <p className="text-sm text-muted-foreground">
            Looped (muted) in the lobby until you open the room. Leave blank for a countdown only.
            {videoInvalid && (
              <span className="text-red-600 block">Must be a YouTube or Vimeo link.</span>
            )}
          </p>
        </div>

        {/* Waiting-room image, beside the holding video it stands in for */}
        <BrandingImageField
          eventId={eventId}
          label="Waiting room image (optional)"
          value={lobbyImageUrl}
          onChange={setLobbyImageUrl}
          hint="Shown behind the countdown while attendees wait, when no holding video is set. Wide images work best (e.g. 1280×720). Leave empty to show the page background."
          previewClassName="w-full h-40 object-cover"
        />

        {/* Lobby message */}
        <div className="space-y-2">
          <Label htmlFor="lobby-message">Lobby message (optional)</Label>
          <Input
            id="lobby-message"
            value={lobbyMessage}
            onChange={(e) => setLobbyMessage(e.target.value)}
            maxLength={280}
            placeholder="We'll begin shortly. Thanks for joining early!"
          />
        </div>

        <div className="flex justify-end pt-2 border-t">
          <Button onClick={handleSave} disabled={updateSettings.isPending}>
            {updateSettings.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : null}
            Save lobby settings
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Go live (owner, Oct 6, 2026): the room's open/close control as its own card
 * at the top of the Setup tab's right rail, so the action that matters at
 * go-live time never sits below the lobby settings.
 */
function GoLiveCard({
  eventId,
  webinar,
  anchor,
  eventStatus,
  partner,
}: {
  eventId: string;
  webinar: WebinarConsoleData["webinar"];
  anchor: WebinarConsoleData["anchorSession"];
  eventStatus?: string;
  partner: boolean;
}) {
  const toggleRoom = useToggleWebinarRoom(eventId);
  const roomOpen = anchor?.status === "LIVE";

  // "Room still closed" alert (waiting-room review #6): once the scheduled
  // start passes with the room never opened, warn loudly + show how many
  // attendees are stuck in the lobby. A 30s tick keeps the check moving even
  // when nothing else re-renders; hides once the producer opens or closes the
  // room, and 30 min past the scheduled end (never-run webinars don't nag
  // forever).
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const anchorStartMs = anchor?.startTime ? new Date(anchor.startTime).getTime() : 0;
  const anchorEndMs = anchor?.endTime ? new Date(anchor.endTime).getTime() : 0;
  const roomOverdue =
    !roomOpen &&
    anchor != null &&
    anchor.status !== "COMPLETED" &&
    anchorStartMs > 0 &&
    nowTick >= anchorStartMs &&
    nowTick <= anchorEndMs + ROOM_OVERDUE_GRACE_MS;
  // Same query key as LiveNowCard — React Query dedupes if both are active.
  const { data: overduePresence } = useWebinarPresence(eventId, roomOverdue);
  // Closing ends the webinar for attendees once it has started (Nov 5, 2026):
  // they see the thank-you screen and the survey. Before the start a close is a
  // rehearsal and changes nothing for them, so it needs no confirmation.
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [confirmReopenOpen, setConfirmReopenOpen] = useState(false);
  const closeEndsWebinar = roomOpen && anchorStartMs > 0 && nowTick >= anchorStartMs;
  // The same rule attendees get (lobby-status), so the console never says "ended" while they see the
  // waiting room, or the reverse (review of fb4459d0).
  const ended =
    !roomOpen &&
    anchor != null &&
    webinarRoomEnded({ status: anchor.status, startMs: anchorStartMs, endMs: anchorEndMs, now: nowTick });
  // Re-open (confirmed, quiet) only after a real close; a room never opened by its end is a late start.
  const reopen = roomReopens({
    roomOpen,
    ended,
    anchorStatus: anchor?.status,
    pastLateStart: anchorEndMs > 0 && nowTick > anchorEndMs + ROOM_OVERDUE_GRACE_MS,
  });

  const handleToggleRoom = async () => {
    setConfirmCloseOpen(false);
    setConfirmReopenOpen(false);
    try {
      const res = await toggleRoom.mutateAsync(!roomOpen);
      toast.success(
        res.open ? "Room opened: attendees are being let in" : "Room closed",
      );
      announceStreamResult(res.stream, res.open);
      const partnerWarning = res.partnerSignal ? PARTNER_SIGNAL_ON_OPEN[res.partnerSignal] : null;
      if (partnerWarning) toast.warning(partnerWarning);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update the room");
    }
  };

  if (!anchor) return null;

  return (
    <Card className={roomOpen ? "border-red-200" : undefined}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <ConsoleTitle icon={PlayCircle} tone="red" pulse={roomOpen}>
            Go live
          </ConsoleTitle>
          <Badge
            variant={roomOpen ? undefined : "outline"}
            className={roomOpen ? "bg-red-100 text-red-800 border-red-200" : ""}
          >
            {roomOpen ? "Room OPEN" : "Room closed"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Overdue alert — scheduled start passed, room never opened */}
        {roomOverdue && (
          <div className="flex items-start gap-3 rounded-lg border border-red-300 bg-red-50 p-4">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
            <div className="min-w-0">
              <p className="font-medium text-red-800">
                The scheduled start has passed and the room is still closed
              </p>
              <p className="text-sm text-red-700">
                {overduePresence && overduePresence.lobby > 0
                  ? `${overduePresence.lobby} attendee${overduePresence.lobby === 1 ? " is" : "s are"} waiting in the lobby. `
                  : ""}
                Attendees stay in the waiting room until you click “Open the room / Go live”.
              </p>
            </div>
          </div>
        )}
        {/* Running past the scheduled end (Nov 5, 2026): nothing ends on the clock. */}
        {roomOpen && anchorEndMs > 0 && nowTick > anchorEndMs && (
          <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
            {overrunNote(webinar.viewingMode === "hls", partner)}
          </p>
        )}
        {/* Open / close the room */}
        <div className="space-y-3">
          <div className="min-w-0">
            <p className="font-medium">
              {roomStateLine(roomOpen, ended)}
            </p>
            <p className="text-sm text-muted-foreground">
              Opening the room admits everyone into the live{" "}
              {webinar.viewingMode === "hls" ? "stream" : "webinar"}. It never opens
              automatically at the scheduled time.
            </p>
          </div>
          <Button
            onClick={roomButtonAction({
              closeEndsWebinar,
              reopen,
              toggle: handleToggleRoom,
              confirmClose: () => setConfirmCloseOpen(true),
              confirmReopen: () => setConfirmReopenOpen(true),
            })}
            size={reopen ? "sm" : "lg"}
            disabled={toggleRoom.isPending}
            variant={roomOpen || reopen ? "outline" : "default"}
            className={roomOpen || reopen ? "w-full" : "w-full bg-red-600 hover:bg-red-700"}
          >
            {toggleRoom.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <PlayCircle className="h-4 w-4 mr-2" />
            )}
            {roomButtonLabel(roomOpen, reopen)}
          </Button>
        </div>
        {/* Operator visibility (waiting-room review #10): DRAFT events auto-open
            the public room for end-to-end testing — "it worked in my test" must
            not surprise an operator at go-live on the published event. */}
        {eventStatus === "DRAFT" && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            This event is in <strong>DRAFT</strong>: the public session page{" "}
            <strong>auto-opens the room</strong> so you can test the flow. After
            publishing, attendees wait in the lobby until you click “Open the
            room / Go live”.
          </p>
        )}
        <AlertDialog open={confirmReopenOpen} onOpenChange={setConfirmReopenOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Re-open the room?</AlertDialogTitle>
              <AlertDialogDescription>
                The webinar has ended. Re-opening takes everyone who still has the page open back to the live view,
                and the room stays open until you close it again. Use it only if the webinar is not over.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep it closed</AlertDialogCancel>
              <Button onClick={handleToggleRoom} disabled={toggleRoom.isPending}>
                Re-open the room
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>End the webinar for attendees?</AlertDialogTitle>
              <AlertDialogDescription>
                Everyone watching sees the thank-you screen and the end-of-webinar survey. Reopening the room brings
                back only the people who still have the page open. The thank-you email goes 5 minutes after you
                close; reopen within that time and it waits.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep it open</AlertDialogCancel>
              <Button variant="destructive" onClick={handleToggleRoom} disabled={toggleRoom.isPending}>
                Close the room
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

/** What the producer is told on opening a partner's room, by what the stream server said. Nothing when it is arriving. */
const PARTNER_SIGNAL_ON_OPEN: Record<"receiving" | "not-receiving" | "switched-off" | "unknown", string | null> = {
  receiving: null,
  "not-receiving": "The partner's video is not arriving yet. Attendees see \"Waiting for stream to start\" until it does.",
  "switched-off": "The partner's key is switched off, so their video cannot arrive. Switch it on in the Partner stream card.",
  unknown: "The stream server did not answer, so whether the partner's video is arriving is not known. Check the preview.",
};

/**
 * The room button's one press: close (confirmed once the webinar has started), re-open after the end
 * (confirmed: the big red "Go live" was the most prominent thing on an ended webinar, one click from
 * pulling people back; UX review, Nov 16, 2026), or open.
 */
function roomButtonAction(a: {
  closeEndsWebinar: boolean;
  /** roomReopens: the room was opened and closed after the start. */
  reopen: boolean;
  toggle: () => void;
  confirmClose: () => void;
  confirmReopen: () => void;
}): () => void {
  if (a.closeEndsWebinar) return a.confirmClose;
  if (a.reopen) return a.confirmReopen;
  return a.toggle;
}

function roomButtonLabel(roomOpen: boolean, reopen: boolean): string {
  if (roomOpen) return "Close the room";
  return reopen ? "Re-open the room" : "Open the room / Go live";
}

function overrunNote(customStream: boolean, partner = false): string {
  // A partner's webinar has no Zoom end to go by: the room closes by the button, or by the safety net
  // once the partner's stream has stopped (room-autoclose.ts).
  if (partner) {
    return "Running past the scheduled end. Attendees stay in the live view, and the thank-you email and the end-of-webinar survey wait until the room closes: when you close it, or two hours after the scheduled end (or after the room was last re-opened) once the partner's stream has stopped.";
  }
  const base =
    "Running past the scheduled end. Attendees stay in the live view, and the thank-you email and the end-of-webinar survey wait until the room closes: when you close it, or a few minutes after the host ends the webinar in Zoom.";
  // Zoom embed mode has no stream to tell "still on air" from "left open", so the safety net still closes
  // the room two hours after the scheduled end (overrun.ts).
  return customStream ? base : `${base} At the latest it closes two hours after the scheduled end.`;
}

function roomStateLine(roomOpen: boolean, ended: boolean): string {
  if (roomOpen) return "Attendees are being admitted into the session";
  return ended ? "The webinar has ended: attendees see the thank-you screen" : "Attendees are waiting in the lobby";
}

/**
 * Webinar handouts (Oct 6, 2026; docs/WEBINAR_INTERACTION_PLAN.md §4): files
 * for attendees, listed beside the video. Private: only signed-in registrants
 * of this webinar can open them. PDF, PPTX or DOCX, 8 MB each, up to 10.
 * Producers (webinar.manage) add, reorder and remove; others see the list.
 */
function HandoutsCard({ eventId, handouts }: { eventId: string; handouts: WebinarHandout[] }) {
  const canManage = useCan("webinar.manage", eventId) === "allowed";
  const upload = useUploadWebinarHandout(eventId);
  const reorder = useReorderWebinarHandouts(eventId);
  const remove = useDeleteWebinarHandout(eventId);
  const fileInput = useRef<HTMLInputElement>(null);
  const [pendingDelete, setPendingDelete] = useState<WebinarHandout | null>(null);
  const busy = upload.isPending || reorder.isPending || remove.isPending;

  const onPick = async (files: FileList | null) => {
    const picked = Array.from(files ?? []);
    if (fileInput.current) fileInput.current.value = "";
    for (const file of picked) {
      if (file.size > MAX_HANDOUT_MB * 1024 * 1024) {
        toast.error(`"${file.name}" is over the ${MAX_HANDOUT_MB} MB limit.`);
        continue;
      }
      try {
        await upload.mutateAsync(file);
        toast.success(`Added "${file.name}"`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : `Could not add "${file.name}"`);
        return;
      }
    }
  };

  const move = async (index: number, delta: -1 | 1) => {
    const order = handouts.map((h) => h.id);
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    try {
      await reorder.mutateAsync(order);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reorder the handouts");
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await remove.mutateAsync(pendingDelete.id);
      toast.success(`Removed "${pendingDelete.name}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the handout");
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <ConsoleTitle icon={FileText} tone="sky">
          Handouts
        </ConsoleTitle>
        <CardDescription>
          Files for attendees beside the video. Only signed-in registrants can open them. PDF, PPTX or DOCX, up to{" "}
          {MAX_HANDOUT_MB} MB each.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {handouts.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">No handouts yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {handouts.map((h, i) => (
              <li key={h.id} className="flex items-center gap-3 px-3 py-2">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <a
                    href={`/api/events/${eventId}/webinar/handouts/${encodeURIComponent(h.id)}`}
                    target="_blank"
                    rel="noopener"
                    className="block truncate text-sm font-medium hover:underline"
                    title={`Open ${h.name}`}
                  >
                    {h.name}
                  </a>
                  <p className="text-xs text-muted-foreground">{formatHandoutSize(h.size)}</p>
                </div>
                {canManage && (
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button size="icon" variant="ghost" className="h-8 w-8" disabled={busy || i === 0} onClick={() => void move(i, -1)} aria-label={`Move ${h.name} up`}>
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-8 w-8" disabled={busy || i === handouts.length - 1} onClick={() => void move(i, 1)} aria-label={`Move ${h.name} down`}>
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-8 w-8 text-red-600 hover:text-red-700" disabled={busy} onClick={() => setPendingDelete(h)} aria-label={`Remove ${h.name}`}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {handouts.length}/{MAX_HANDOUTS}
            </span>
            <input
              ref={fileInput}
              type="file"
              accept={HANDOUT_ACCEPT}
              multiple
              className="hidden"
              onChange={(e) => void onPick(e.target.files)}
              aria-label="Choose handout files"
            />
            <Button size="sm" variant="outline" disabled={busy || handouts.length >= MAX_HANDOUTS} onClick={() => fileInput.current?.click()}>
              {upload.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
              Add handout
            </Button>
          </div>
        )}
      </CardContent>
      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this handout?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{pendingDelete?.name}&quot; disappears from the attendee page and the file is deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => void confirmDelete()}>
              {remove.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/**
 * End-of-webinar survey (step 4 of several surveys, Oct 6, 2026): the survey
 * that pops up on the attendee page when the webinar ends (host ends it in
 * Zoom, or the room is closed after the scheduled end). Closable, it comes
 * back until answered. The same survey's link goes into the thank-you email.
 * Any open extra survey can be chosen, never the CME survey (any registrant
 * could complete it from the popup and be issued a certificate).
 */
function EndSurveyCard({
  eventId,
  endSurveyId,
  emailLink,
}: {
  eventId: string;
  endSurveyId: string;
  /** The thank-you email carries the survey link (unset in settings = yes). */
  emailLink: boolean;
}) {
  const updateSettings = useUpdateWebinarSettings(eventId);
  const { data: surveys = [], isLoading } = useEventSurveys(eventId);
  const [choice, setChoice] = useState(endSurveyId || "none");
  const [sendInEmail, setSendInEmail] = useState(emailLink);
  // Never the CME survey (review of step 4): in the popup any registrant,
  // attended or not, could complete it and be issued a certificate. It stays
  // with its personal link.
  const usable = surveys.filter(
    (sv) => !sv.gatesCertificates && sv.isActive && Array.isArray(sv.config) && sv.config.length > 0,
  );
  const saved = endSurveyId ? surveys.find((sv) => sv.id === endSurveyId) : null;

  const handleSave = async () => {
    try {
      await updateSettings.mutateAsync({ endSurveyId: choice === "none" ? "" : choice, thankYouSurveyLink: sendInEmail });
      toast.success(choice === "none" ? "No survey after the webinar" : "End-of-webinar survey saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save the end-of-webinar survey");
    }
  };

  return (
    <Card>
      <CardHeader>
        <ConsoleTitle icon={ClipboardList} tone="emerald">
          End-of-webinar survey
        </ConsoleTitle>
        <CardDescription>
          Pops up for attendees on the webinar page when it ends. They can close it and it comes back until they
          answer. Answers are recorded with the survey and export from the Surveys page.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="end-survey">Survey</Label>
          <Select value={choice} onValueChange={setChoice} disabled={isLoading}>
            <SelectTrigger id="end-survey" className="w-full">
              <SelectValue placeholder={isLoading ? "Loading surveys…" : "Choose a survey"} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No survey</SelectItem>
              {usable.map((sv) => (
                <SelectItem key={sv.id} value={sv.id}>
                  {sv.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            The certificate (CME) survey is not offered here: it is sent with its personal link, so only people you
            choose can complete it.
          </p>
          {saved && !saved.isActive && (
            <p className="text-sm text-amber-700">
              The chosen survey is closed, so nothing pops up and no link is emailed until it is opened.
            </p>
          )}
          {usable.length === 0 && !isLoading && (
            <p className="text-sm text-muted-foreground">
              No open survey with questions yet. Build one under{" "}
              <Link href={`/events/${eventId}/survey`} className="font-medium text-primary hover:underline">
                Surveys
              </Link>
              .
            </p>
          )}
        </div>
        {choice !== "none" && (
          <label htmlFor="end-survey-email" className="flex items-start justify-between gap-4 rounded-lg border p-3">
            <span className="space-y-0.5">
              <span className="block text-sm font-medium">Also send the link in the thank-you email</span>
              <span className="block text-xs text-muted-foreground">
                Each person gets their own link, unless they already answered on the page.
              </span>
            </span>
            <Switch id="end-survey-email" checked={sendInEmail} onCheckedChange={setSendInEmail} />
          </label>
        )}
        <div className="flex justify-end border-t pt-3">
          <Button
            onClick={handleSave}
            disabled={updateSettings.isPending || (choice === (endSurveyId || "none") && sendInEmail === emailLink)}
          >
            {updateSettings.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const STREAM_EVENT_LABEL: Record<WebinarStreamTimelineEntry["kind"], { label: string; tone: string }> = {
  ROOM_OPENED: { label: "Room opened", tone: "bg-emerald-500" },
  ROOM_CLOSED: { label: "Room closed", tone: "bg-slate-400" },
  ROOM_AUTO_CLOSED: { label: "Room closed automatically", tone: "bg-slate-400" },
  STREAM_START_PRESSED: { label: "Start stream pressed", tone: "bg-sky-500" },
  STREAM_STOP_PRESSED: { label: "Stop stream pressed", tone: "bg-slate-400" },
  STREAM_LIVE: { label: "Stream live", tone: "bg-emerald-500" },
  STREAM_DROPPED: { label: "Stream dropped", tone: "bg-red-500" },
  AUTO_RESTART_REQUESTED: { label: "Restart requested automatically", tone: "bg-amber-500" },
  AUTO_RESTART_FAILED: { label: "Automatic restart refused", tone: "bg-red-500" },
};

/**
 * Stream timeline (Nov 5, 2026): what happened to the room and the stream, newest first, so a
 * producer can see "dropped, restarted, back" without CloudWatch. Rows come from the room switch,
 * the Start/Stop buttons, the auto-close and the stream watchdog (src/lib/webinar/stream-timeline.ts).
 */
function StreamTimelineCard({ eventId, live }: { eventId: string; live: boolean }) {
  const tz = useEventTz();
  const { data, isLoading, error } = useWebinarStreamTimeline(eventId, live);
  const entries = data?.entries ?? [];
  return (
    <Card>
      <CardHeader>
        <ConsoleTitle icon={Radio} tone="violet">
          Stream timeline
        </ConsoleTitle>
        <CardDescription>
          The room and the stream, newest first. While the room is open a dropped stream is restarted
          automatically, and it shows here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && <p className="text-sm text-red-600">The timeline could not be loaded.</p>}
        {!isLoading && !error && entries.length === 0 && (
          <p className="text-sm text-muted-foreground">Nothing yet. Opening the room starts the timeline.</p>
        )}
        {entries.length > 0 && (
          <ol className="max-h-80 space-y-2 overflow-y-auto pr-1">
            {entries.map((e) => {
              const meta = STREAM_EVENT_LABEL[e.kind];
              return (
                <li key={e.id} className="flex items-start gap-3 text-sm">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${meta.tone}`} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{meta.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {fmtTz(e.at, tz)}
                      {e.user ? ` · ${e.user.firstName} ${e.user.lastName}` : ""}
                    </p>
                    {e.detail && <p className="text-xs text-muted-foreground break-words">{e.detail}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

/** The page's address never changes while it is open. */
const subscribeToNothing = () => () => {};
const readSiteHost = () => window.location.host;

/** What the console says after a replay link is saved or removed. */
function replaySavedMessage(link: string, shown: boolean): string {
  if (!link) return "Replay link removed";
  if (shown) return "Replay saved. Registered attendees can watch it once the webinar is over.";
  return 'Replay saved. Switch on "Show the recording to attendees" to offer it.';
}

/**
 * The thank-you screen's exit button (Nov 5, 2026). Empty uses the
 * organisation's website from Settings; with neither, no button shows.
 */
function ExitButtonCard({
  eventId,
  exitUrl,
  orgWebsite,
}: {
  eventId: string;
  exitUrl: string;
  orgWebsite: string | null;
}) {
  const updateSettings = useUpdateWebinarSettings(eventId);
  const [value, setValue] = useState(exitUrl);
  const trimmed = value.trim();
  const invalid = trimmed.length > 0 && !isHttpsLink(trimmed);

  const handleSave = async () => {
    if (invalid) {
      toast.error("The exit link must be a full https:// address");
      return;
    }
    try {
      await updateSettings.mutateAsync({ exitUrl: trimmed });
      toast.success(trimmed ? "Exit button saved" : "Exit button uses the organisation website");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save the exit button");
    }
  };

  const fallbackHint = orgWebsite
    ? `Leave empty to use your organisation's website (${orgWebsite}).`
    : "Leave empty for no button: no organisation website is set under Settings.";

  return (
    <Card>
      <CardHeader>
        <ConsoleTitle icon={ExternalLink} tone="emerald">
          Exit button
        </ConsoleTitle>
        <CardDescription>
          A button on the thank-you screen attendees see when the webinar ends.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="exit-url">Link for this webinar (optional)</Label>
          <Input
            id="exit-url"
            type="url"
            inputMode="url"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={500}
            placeholder={orgWebsite ?? "https://www.example.com"}
            aria-invalid={invalid}
          />
          <p className={invalid ? "text-xs text-red-600" : "text-xs text-muted-foreground"}>
            {invalid ? "Must be a full https:// address." : fallbackHint}
          </p>
        </div>
        <div className="flex justify-end border-t pt-3">
          <Button onClick={handleSave} disabled={updateSettings.isPending || trimmed === exitUrl.trim()}>
            {updateSettings.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Branding tab (owner, Oct 6, 2026): every image the attendee sees, saved on
 * its own. The webinar page has no event banner; the logo sits left of the
 * session title over a full-page background, and the footer image sits under
 * the columns. The waiting-room image stays on the Setup tab beside the
 * holding video (owner, Oct 6, 2026).
 */
function BrandingCard({
  eventId,
  webinar,
}: {
  eventId: string;
  webinar: WebinarConsoleData["webinar"];
}) {
  const updateSettings = useUpdateWebinarSettings(eventId);
  const [pageLogoUrl, setPageLogoUrl] = useState(() => webinar.pageLogoUrl ?? "");
  const [pageBackgroundUrl, setPageBackgroundUrl] = useState(() => webinar.pageBackgroundUrl ?? "");
  const [pageFooterImageUrl, setPageFooterImageUrl] = useState(() => webinar.pageFooterImageUrl ?? "");

  const handleSave = async () => {
    try {
      await updateSettings.mutateAsync({ pageLogoUrl, pageBackgroundUrl, pageFooterImageUrl });
      toast.success("Branding saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save branding");
    }
  };

  return (
    <Card>
      <CardHeader>
        <ConsoleTitle icon={Palette} tone="violet">
          Attendee page branding
        </ConsoleTitle>
        <CardDescription>
          Applies to the attendee page and the waiting room. The event banner is not shown on webinar pages.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <BrandingImageField
          eventId={eventId}
          label="Logo (left of the session title)"
          value={pageLogoUrl}
          onChange={setPageLogoUrl}
          hint="Transparent PNG works best, about 600×160px. Leave empty to show no logo."
          previewClassName="h-20 w-auto object-contain"
        />
        <BrandingImageField
          eventId={eventId}
          label="Page background"
          value={pageBackgroundUrl}
          onChange={setPageBackgroundUrl}
          hint="Covers the whole page behind the content. About 1920×1080px, under 2 MB. Leave empty for a plain background."
          previewClassName="w-full h-40 object-cover"
        />
        <BrandingImageField
          eventId={eventId}
          label="Footer image"
          value={pageFooterImageUrl}
          onChange={setPageFooterImageUrl}
          hint="Shown under the video, panelists and Q&A at its own width (centred, shrunk only on smaller screens), e.g. a sponsor strip."
          previewClassName="w-full h-24 object-contain"
        />
        <div className="flex justify-end border-t pt-4">
          <Button onClick={handleSave} disabled={updateSettings.isPending}>
            {updateSettings.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Save branding
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function WebinarSettingsCard({
  eventId,
  initialSettings,
}: {
  eventId: string;
  initialSettings: {
    autoProvisionZoom?: boolean;
    waitingRoom?: boolean;
    autoRecording?: "none" | "local" | "cloud";
    defaultPasscode?: string;
    automationEnabled?: boolean;
  };
}) {
  const updateSettings = useUpdateWebinarSettings(eventId);
  // Lazy init from props — safe because this component only mounts once `data` exists.
  const [autoProvisionZoom, setAutoProvisionZoom] = useState(
    () => initialSettings.autoProvisionZoom ?? true,
  );
  const [waitingRoom, setWaitingRoom] = useState(
    () => initialSettings.waitingRoom ?? false,
  );
  const [autoRecording, setAutoRecording] = useState<AutoRecording>(
    () => (initialSettings.autoRecording as AutoRecording) ?? "cloud",
  );
  const [defaultPasscode, setDefaultPasscode] = useState(
    () => initialSettings.defaultPasscode ?? "",
  );
  const [automationEnabled, setAutomationEnabled] = useState(
    () => initialSettings.automationEnabled ?? true,
  );

  const handleSave = async () => {
    try {
      await updateSettings.mutateAsync({
        autoProvisionZoom,
        waitingRoom,
        autoRecording,
        defaultPasscode: defaultPasscode || undefined,
        automationEnabled,
      });
      toast.success("Webinar settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save settings");
    }
  };

  return (
    <Card>
      <CardHeader>
        <ConsoleTitle icon={SettingsIcon} tone="slate">
          Webinar Settings
        </ConsoleTitle>
        <CardDescription>
          Defaults used when auto-provisioning the Zoom webinar for this event.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <SettingsForm
          autoProvisionZoom={autoProvisionZoom}
          setAutoProvisionZoom={setAutoProvisionZoom}
          waitingRoom={waitingRoom}
          setWaitingRoom={setWaitingRoom}
          autoRecording={autoRecording}
          setAutoRecording={setAutoRecording}
          defaultPasscode={defaultPasscode}
          setDefaultPasscode={setDefaultPasscode}
          automationEnabled={automationEnabled}
          setAutomationEnabled={setAutomationEnabled}
        />
        <div className="flex justify-end pt-2 border-t">
          <Button onClick={handleSave} disabled={updateSettings.isPending}>
            {updateSettings.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : null}
            Save settings
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: "scheduled" | "live" | "ended" }) {
  if (status === "live") {
    return <Badge className="bg-red-100 text-red-800 border-red-200">LIVE</Badge>;
  }
  if (status === "ended") {
    return <Badge variant="secondary">Ended</Badge>;
  }
  return <Badge variant="outline">Scheduled</Badge>;
}

function EmptyAnchorState({
  onProvision,
  pending,
}: {
  onProvision: () => void;
  pending: boolean;
}) {
  return (
    <div className="rounded-lg border border-dashed p-6 text-center space-y-3">
      <p className="text-sm text-muted-foreground">
        No anchor session yet. Run the provisioner to create one for this
        webinar event.
      </p>
      <Button onClick={onProvision} disabled={pending}>
        {pending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
        Provision now
      </Button>
    </div>
  );
}

function SettingsForm(props: {
  autoProvisionZoom: boolean;
  setAutoProvisionZoom: (v: boolean) => void;
  waitingRoom: boolean;
  setWaitingRoom: (v: boolean) => void;
  autoRecording: AutoRecording;
  setAutoRecording: (v: AutoRecording) => void;
  defaultPasscode: string;
  setDefaultPasscode: (v: string) => void;
  automationEnabled: boolean;
  setAutomationEnabled: (v: boolean) => void;
}) {
  return (
    <div className="space-y-4">
      <ToggleRow
        label="Auto-provision Zoom webinar"
        description="Automatically create a Zoom webinar when a new WEBINAR event is created."
        value={props.autoProvisionZoom}
        onChange={props.setAutoProvisionZoom}
      />
      <ToggleRow
        label="Waiting room"
        description="Require attendees to wait until the host admits them. Usually off for webinars."
        value={props.waitingRoom}
        onChange={props.setWaitingRoom}
      />
      <ToggleRow
        label="Automation enabled"
        description="Email sequence, recording fetch, and attendance sync run on their schedule."
        value={props.automationEnabled}
        onChange={props.setAutomationEnabled}
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <Label>Auto-recording</Label>
          <Select
            value={props.autoRecording}
            onValueChange={(v) => props.setAutoRecording(v as AutoRecording)}
          >
            <SelectTrigger className="mt-1 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="local">Local</SelectItem>
              <SelectItem value="cloud">Cloud (recommended)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Default passcode (optional)</Label>
          <Input
            className="mt-1"
            value={props.defaultPasscode}
            onChange={(e) => props.setDefaultPasscode(e.target.value)}
            placeholder="Leave empty to auto-generate"
            maxLength={10}
          />
        </div>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <Label className="text-sm font-medium">{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={value} onCheckedChange={onChange} />
    </div>
  );
}
