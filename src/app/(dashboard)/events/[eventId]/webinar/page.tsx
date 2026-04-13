"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
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
import {
  Video,
  Copy,
  PlayCircle,
  ExternalLink,
  RotateCw,
  AlertCircle,
  Loader2,
  Calendar,
  Lock,
  Mail,
  CheckCircle2,
  Clock,
  XCircle,
} from "lucide-react";
import {
  useWebinar,
  useUpdateWebinarSettings,
  useProvisionWebinar,
  useWebinarSequence,
  useReenqueueWebinarSequence,
  useFetchWebinarRecording,
  type WebinarSequenceRow,
} from "@/hooks/use-api";
import { toast } from "sonner";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

type AutoRecording = "none" | "local" | "cloud";

function formatDateTime(iso: string | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

function statusFromTimes(
  startTime: string | undefined,
  endTime: string | undefined,
): "scheduled" | "live" | "ended" {
  if (!startTime || !endTime) return "scheduled";
  const now = Date.now();
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  if (now < start) return "scheduled";
  if (now >= start && now <= end) return "live";
  return "ended";
}

export default function WebinarConsolePage() {
  const params = useParams();
  const eventId = params.eventId as string;

  const { data, isLoading, isFetching, error } = useWebinar(eventId);
  const showLoader = useDelayedLoading(isLoading, 500);
  const provision = useProvisionWebinar(eventId);

  const status = useMemo(
    () =>
      statusFromTimes(
        data?.anchorSession?.startTime,
        data?.anchorSession?.endTime,
      ),
    [data?.anchorSession?.startTime, data?.anchorSession?.endTime],
  );

  const hasZoom = Boolean(data?.zoomMeeting);
  const eventIsWebinar = data?.event?.eventType === "WEBINAR";

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
        toast.success("Webinar provisioned — Zoom meeting ready");
      } else if (result.zoomStatus === "already-attached") {
        toast.success("Webinar already provisioned");
      } else if (result.zoomStatus === "not-configured") {
        toast.warning("Anchor session created — Zoom not configured for this org");
      } else if (result.zoomStatus === "failed") {
        toast.error("Anchor session created, but Zoom webinar creation failed");
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Video className="h-8 w-8" />
            Webinar Console
          </h1>
          <p className="text-muted-foreground mt-1">
            {data?.event?.name}
            {isFetching && !isLoading && (
              <ReloadingSpinner className="ml-2 inline-block" />
            )}
          </p>
        </div>
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

      {/* Status + Anchor Session */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Calendar className="h-5 w-5" />
              Anchor Session
            </CardTitle>
            <StatusBadge status={status} />
          </div>
          <CardDescription>
            The single EventSession that represents this webinar.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {anchor ? (
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <Label className="text-muted-foreground">Name</Label>
                <p className="font-medium">{anchor.name}</p>
              </div>
              <div>
                <Label className="text-muted-foreground">Status</Label>
                <p className="font-medium capitalize">{status}</p>
              </div>
              <div>
                <Label className="text-muted-foreground">Starts</Label>
                <p className="font-medium">{formatDateTime(anchor.startTime)}</p>
              </div>
              <div>
                <Label className="text-muted-foreground">Ends</Label>
                <p className="font-medium">{formatDateTime(anchor.endTime)}</p>
              </div>
            </div>
          ) : (
            <EmptyAnchorState onProvision={handleProvision} pending={provision.isPending} />
          )}
        </CardContent>
      </Card>

      {/* Zoom Join Details */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Video className="h-5 w-5" />
            Zoom Webinar
          </CardTitle>
          <CardDescription>
            Join link and passcode. Share the public session page URL with attendees (not the Zoom URL directly).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!hasZoom ? (
            <div className="rounded-lg border border-dashed p-6 text-center space-y-3">
              <p className="text-sm text-muted-foreground">
                No Zoom webinar attached. Either Zoom isn&apos;t configured for
                this organization, or the provisioner hasn&apos;t run yet.
              </p>
              <div className="flex justify-center gap-2">
                <Button asChild variant="outline" size="sm">
                  <Link href="/settings">Configure Zoom</Link>
                </Button>
                <Button
                  size="sm"
                  onClick={handleProvision}
                  disabled={provision.isPending}
                >
                  {provision.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : null}
                  Run provisioner
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label className="text-muted-foreground text-xs uppercase tracking-wide">
                    Meeting Type
                  </Label>
                  <p className="font-medium">{zoom?.meetingType}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground text-xs uppercase tracking-wide">
                    Duration
                  </Label>
                  <p className="font-medium">{zoom?.duration ?? "—"} min</p>
                </div>
                <div className="md:col-span-2">
                  <Label className="text-muted-foreground text-xs uppercase tracking-wide">
                    Attendee Join URL
                  </Label>
                  <div className="flex items-center gap-2 mt-1">
                    <Input value={zoom?.joinUrl ?? ""} readOnly className="font-mono text-xs" />
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      onClick={() => handleCopy(zoom?.joinUrl, "Join URL")}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                {zoom?.passcode ? (
                  <div>
                    <Label className="text-muted-foreground text-xs uppercase tracking-wide">
                      Passcode
                    </Label>
                    <div className="flex items-center gap-2 mt-1">
                      <Input value={zoom.passcode} readOnly className="font-mono" />
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        onClick={() => handleCopy(zoom.passcode, "Passcode")}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-2 pt-2 border-t">
                {zoom?.startUrl ? (
                  <Button asChild>
                    <a href={zoom.startUrl} target="_blank" rel="noopener noreferrer">
                      <PlayCircle className="h-4 w-4 mr-2" />
                      Start as Host
                    </a>
                  </Button>
                ) : null}
                {data?.event?.slug && anchor ? (
                  <Button asChild variant="outline">
                    <Link
                      href={`/e/${data.event.slug}/session/${anchor.id}`}
                      target="_blank"
                    >
                      <ExternalLink className="h-4 w-4 mr-2" />
                      Open Public Page
                    </Link>
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Recording */}
      <RecordingCard
        eventId={eventId}
        zoom={data?.zoomMeeting ?? null}
        sessionEnded={status === "ended"}
      />

      {/* Email Sequence */}
      <EmailSequenceCard eventId={eventId} hasZoom={hasZoom} />

      {/* Webinar Settings — child owns its own state, initialized once from loaded data */}
      {data ? (
        <WebinarSettingsCard
          eventId={eventId}
          initialSettings={data.webinar || {}}
        />
      ) : null}
    </div>
  );
}

function EmailSequenceCard({
  eventId,
  hasZoom,
}: {
  eventId: string;
  hasZoom: boolean;
}) {
  const { data, isLoading } = useWebinarSequence(eventId);
  const reenqueue = useReenqueueWebinarSequence(eventId);

  const handleReenqueue = async () => {
    try {
      const result = await reenqueue.mutateAsync();
      if (result.skipped === "no-anchor-session") {
        toast.error("No anchor session — run the provisioner first");
      } else if (result.skipped === "no-future-phases") {
        toast.warning("All phase times are in the past — nothing to schedule");
      } else if (result.skipped === "no-actor") {
        toast.error("No admin user found to create sequence rows");
      } else {
        toast.success(
          `Queue refreshed — ${result.deleted} cleared, ${result.created} scheduled`,
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to re-enqueue sequence");
    }
  };

  const rows = data?.rows ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5" />
              Email Sequence
            </CardTitle>
            <CardDescription>
              Auto-scheduled reminders + live alert + thank-you with recording link.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleReenqueue}
            disabled={reenqueue.isPending || !hasZoom}
            title={!hasZoom ? "Attach a Zoom webinar first" : undefined}
          >
            {reenqueue.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RotateCw className="h-4 w-4 mr-2" />
            )}
            Re-enqueue
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No sequence rows queued yet. {hasZoom
              ? "Click Re-enqueue to schedule the 24h/1h/live-now/thank-you emails."
              : "Attach a Zoom webinar first — the sequence needs a join link to render."}
          </div>
        ) : (
          <div className="divide-y">
            {rows.map((row) => (
              <SequenceRowView key={row.id} row={row} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SequenceRowView({ row }: { row: WebinarSequenceRow }) {
  const label = (
    {
      "webinar-confirmation": "Confirmation",
      "webinar-reminder-24h": "Reminder — 24 hours",
      "webinar-reminder-1h": "Reminder — 1 hour",
      "webinar-live-now": "Live now",
      "webinar-thank-you": "Thank you + recording",
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
              ? `Sent ${new Date(row.sentAt).toLocaleString()}`
              : `Scheduled for ${new Date(row.scheduledFor).toLocaleString()}`}
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
        ) : row.status === "FAILED" && row.lastError ? (
          <div className="text-red-600 truncate max-w-[240px]" title={row.lastError}>
            {row.lastError}
          </div>
        ) : (
          <StatusPill status={row.status} />
        )}
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
}) {
  const fetchRecording = useFetchWebinarRecording(eventId);

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
            <CardTitle className="flex items-center gap-2">
              <PlayCircle className="h-5 w-5" />
              Recording
            </CardTitle>
            <CardDescription>
              Zoom cloud recording — polled automatically after the session ends.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleFetch}
            disabled={fetchRecording.isPending || !canFetch}
            title={
              !zoom
                ? "Attach a Zoom webinar first"
                : !sessionEnded
                  ? "Available after the session ends"
                  : undefined
            }
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
        {!zoom ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No Zoom webinar attached yet.
          </div>
        ) : zoom.recordingStatus === "AVAILABLE" && zoom.recordingUrl ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label className="text-muted-foreground text-xs uppercase tracking-wide">
                  Status
                </Label>
                <p>
                  <StatusPill status="SENT" />
                  <span className="ml-2 text-xs text-muted-foreground">
                    {zoom.recordingFetchedAt
                      ? `Fetched ${new Date(zoom.recordingFetchedAt).toLocaleString()}`
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
        ) : zoom.recordingStatus === "PENDING" ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-6 text-center">
            <Loader2 className="h-6 w-6 text-amber-600 animate-spin mx-auto mb-2" />
            <p className="text-sm font-medium">Recording processing</p>
            <p className="text-xs text-muted-foreground mt-1">
              Zoom is still finalizing the recording. The cron worker will keep polling every 5 min for up to 7 days.
            </p>
          </div>
        ) : zoom.recordingStatus === "FAILED" ? (
          <div className="rounded-lg border border-red-200 bg-red-50/50 p-6 text-center">
            <XCircle className="h-6 w-6 text-red-600 mx-auto mb-2" />
            <p className="text-sm font-medium">Fetch failed</p>
            <p className="text-xs text-muted-foreground mt-1">
              Click Refetch to try again. Clicking Refetch resets the status so the cron can retry too.
            </p>
          </div>
        ) : zoom.recordingStatus === "EXPIRED" ? (
          <div className="rounded-lg border border-gray-200 bg-gray-50/50 p-6 text-center">
            <XCircle className="h-6 w-6 text-gray-500 mx-auto mb-2" />
            <p className="text-sm font-medium">Fetch window expired</p>
            <p className="text-xs text-muted-foreground mt-1">
              More than 7 days have passed since the session. Click Refetch to try one more time if the recording is still on Zoom.
            </p>
          </div>
        ) : (
          // NOT_REQUESTED — session not ended yet, or cloud recording is off
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {sessionEnded
              ? "Cloud recording not yet polled. Click Refetch to start."
              : "Recording will be fetched automatically after the session ends (if cloud recording is enabled)."}
          </div>
        )}
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
        <CardTitle className="flex items-center gap-2">
          <Lock className="h-5 w-5" />
          Webinar Settings
        </CardTitle>
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
