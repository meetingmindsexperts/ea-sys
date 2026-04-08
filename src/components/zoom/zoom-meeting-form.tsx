"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Video, Loader2, Trash2, ExternalLink, Copy, Check, Radio } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useCreateZoomMeeting, useDeleteZoomMeeting } from "@/hooks/use-api";

interface ZoomMeetingFormProps {
  eventId: string;
  sessionId: string;
  sessionName: string;
  hasZoomMeeting?: boolean;
  zoomMeetingType?: string;
  zoomJoinUrl?: string;
  zoomStartUrl?: string;
  zoomMeetingId?: string;
  zoomPasscode?: string;
  zoomLiveStreamEnabled?: boolean;
  zoomStreamKey?: string;
  zoomStreamStatus?: string;
  eventSlug?: string;
  defaultMeetingType?: string;
  onCreated?: () => void;
  onDeleted?: () => void;
}

export function ZoomMeetingForm({
  eventId,
  sessionId,
  sessionName,
  hasZoomMeeting,
  zoomMeetingType,
  zoomJoinUrl,
  zoomStartUrl,
  zoomMeetingId,
  zoomPasscode,
  zoomLiveStreamEnabled,
  zoomStreamKey,
  zoomStreamStatus,
  eventSlug,
  defaultMeetingType = "MEETING",
  onCreated,
  onDeleted,
}: ZoomMeetingFormProps) {
  const [open, setOpen] = useState(false);
  const [meetingType, setMeetingType] = useState(defaultMeetingType);
  const [passcode, setPasscode] = useState("");
  const [waitingRoom, setWaitingRoom] = useState(true);
  const [autoRecording, setAutoRecording] = useState("none");
  const [syncPanelists, setSyncPanelists] = useState(true);
  const [liveStream, setLiveStream] = useState(false);

  // Series fields
  const [recurrenceType, setRecurrenceType] = useState<number>(2); // weekly
  const [repeatInterval, setRepeatInterval] = useState(1);
  const [endTimes, setEndTimes] = useState(4);

  const createMeeting = useCreateZoomMeeting(eventId, sessionId);
  const deleteMeeting = useDeleteZoomMeeting(eventId, sessionId);

  const handleCreate = async () => {
    try {
      const data: Record<string, unknown> = {
        meetingType,
        passcode: passcode || undefined,
        waitingRoom,
        autoRecording,
        syncPanelists,
        liveStreamEnabled: liveStream,
      };

      if (meetingType === "WEBINAR_SERIES") {
        data.recurrence = {
          type: recurrenceType,
          repeat_interval: repeatInterval,
          end_times: endTimes,
        };
      }

      await createMeeting.mutateAsync(data as Parameters<typeof createMeeting.mutateAsync>[0]);
      toast.success("Zoom meeting created");
      setOpen(false);
      onCreated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create Zoom meeting");
    }
  };

  const handleDelete = async () => {
    try {
      await deleteMeeting.mutateAsync();
      toast.success("Zoom meeting removed");
      onDeleted?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove Zoom meeting");
    }
  };

  const [copied, setCopied] = useState(false);

  const handleCopyLink = () => {
    if (zoomJoinUrl) {
      navigator.clipboard.writeText(zoomJoinUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (hasZoomMeeting) {
    return (
      <div className="space-y-2 rounded-lg border bg-blue-50/50 p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium flex items-center gap-1.5">
            <Video className="h-4 w-4 text-blue-600" />
            {zoomMeetingType === "WEBINAR" || zoomMeetingType === "WEBINAR_SERIES"
              ? "Zoom Webinar"
              : "Zoom Meeting"}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-red-500 hover:text-red-600 hover:bg-red-50"
            onClick={handleDelete}
            disabled={deleteMeeting.isPending}
          >
            {deleteMeeting.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>

        {zoomMeetingId && (
          <p className="text-xs text-muted-foreground">
            Meeting ID: {zoomMeetingId}
            {zoomPasscode && <> &middot; Passcode: {zoomPasscode}</>}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {zoomStartUrl && (
            <Button
              size="sm"
              className="gap-1.5 h-7 text-xs bg-blue-600 hover:bg-blue-700 text-white"
              onClick={() => window.open(zoomStartUrl, "_blank")}
            >
              <Video className="h-3 w-3" />
              Start as Host
            </Button>
          )}
          {zoomJoinUrl && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 h-7 text-xs"
              onClick={() => window.open(zoomJoinUrl, "_blank")}
            >
              <ExternalLink className="h-3 w-3" />
              Attendee Join Link
            </Button>
          )}
          {zoomJoinUrl && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 h-7 text-xs"
              onClick={handleCopyLink}
            >
              {copied ? (
                <Check className="h-3 w-3 text-green-600" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
              {copied ? "Copied" : "Copy Link"}
            </Button>
          )}
          {eventSlug && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 h-7 text-xs"
              onClick={() => window.open(`/e/${eventSlug}/session/${sessionId}`, "_blank")}
            >
              <Video className="h-3 w-3" />
              Open Embed Page
            </Button>
          )}
        </div>

        {/* Live streaming info */}
        {zoomLiveStreamEnabled && zoomStreamKey && (
          <StreamingInfoCard
            streamKey={zoomStreamKey}
            streamStatus={zoomStreamStatus}
            eventSlug={eventSlug}
            sessionId={sessionId}
          />
        )}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Video className="h-3.5 w-3.5" />
          Create Zoom Meeting
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Zoom Meeting</DialogTitle>
          <DialogDescription>
            Link a Zoom meeting or webinar to &ldquo;{sessionName}&rdquo;.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Meeting Type</Label>
            <Select value={meetingType} onValueChange={setMeetingType}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MEETING">Meeting</SelectItem>
                <SelectItem value="WEBINAR">Webinar</SelectItem>
                <SelectItem value="WEBINAR_SERIES">Webinar Series (Recurring)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {meetingType === "WEBINAR_SERIES" && (
            <div className="space-y-3 rounded-lg border p-3">
              <p className="text-sm font-medium">Recurrence Settings</p>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Frequency</Label>
                  <Select
                    value={String(recurrenceType)}
                    onValueChange={(v) => setRecurrenceType(Number(v))}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">Daily</SelectItem>
                      <SelectItem value="2">Weekly</SelectItem>
                      <SelectItem value="3">Monthly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Every</Label>
                  <Input
                    type="number"
                    min={1}
                    max={90}
                    value={repeatInterval}
                    onChange={(e) => setRepeatInterval(Number(e.target.value))}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Occurrences</Label>
                  <Input
                    type="number"
                    min={1}
                    max={60}
                    value={endTimes}
                    onChange={(e) => setEndTimes(Number(e.target.value))}
                  />
                </div>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="zoom-passcode">Passcode (optional)</Label>
            <Input
              id="zoom-passcode"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              placeholder="Up to 10 characters"
              maxLength={10}
            />
          </div>

          <div className="flex items-center justify-between">
            <Label htmlFor="zoom-waiting-room">Waiting Room</Label>
            <Switch
              id="zoom-waiting-room"
              checked={waitingRoom}
              onCheckedChange={setWaitingRoom}
            />
          </div>

          <div className="space-y-2">
            <Label>Auto-Recording</Label>
            <Select value={autoRecording} onValueChange={setAutoRecording}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="local">Local</SelectItem>
                <SelectItem value="cloud">Cloud</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {(meetingType === "WEBINAR" || meetingType === "WEBINAR_SERIES") && (
            <div className="flex items-center justify-between">
              <Label htmlFor="zoom-sync-panelists">
                Add session speakers as panelists
              </Label>
              <Switch
                id="zoom-sync-panelists"
                checked={syncPanelists}
                onCheckedChange={setSyncPanelists}
              />
            </div>
          )}

          <div className="border-t pt-3 mt-1">
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="zoom-live-stream" className="flex items-center gap-1.5">
                  <Radio className="h-3.5 w-3.5 text-red-500" />
                  Enable Live Streaming
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Attendees watch via an embedded video player — no Zoom account needed.
                </p>
              </div>
              <Switch
                id="zoom-live-stream"
                checked={liveStream}
                onCheckedChange={setLiveStream}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={createMeeting.isPending}>
            {createMeeting.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Streaming Info Card (shown when live streaming is enabled) ──────

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0 flex-1">
        <span className="text-[10px] text-muted-foreground block">{label}</span>
        <code className="text-[10px] bg-muted px-1.5 py-0.5 rounded block truncate">{value}</code>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0 shrink-0"
        onClick={handleCopy}
      >
        {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
      </Button>
    </div>
  );
}

function StreamingInfoCard({
  streamKey,
  streamStatus,
  eventSlug,
  sessionId,
}: {
  streamKey: string;
  streamStatus?: string;
  eventSlug?: string;
  sessionId: string;
}) {
  const hostname = typeof window !== "undefined" ? window.location.hostname : "localhost";
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";

  const rtmpUrl = `rtmp://${hostname}:1935/live/`;
  const hlsUrl = `${origin}/stream/${streamKey}/index.m3u8`;
  const sessionPageUrl = eventSlug ? `${origin}/e/${eventSlug}/session/${sessionId}` : "";

  return (
    <div className="border-t pt-2 mt-1 space-y-2">
      <div className="flex items-center gap-2">
        <Radio className="h-3.5 w-3.5 text-red-500" />
        <span className="text-xs font-medium">Live Streaming</span>
        <Badge
          variant="outline"
          className={`text-xs ${
            streamStatus === "ACTIVE"
              ? "bg-green-50 text-green-700 border-green-200"
              : streamStatus === "ENDED"
                ? "bg-gray-50 text-gray-600 border-gray-200"
                : "bg-amber-50 text-amber-700 border-amber-200"
          }`}
        >
          {streamStatus === "ACTIVE" && (
            <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
          )}
          {streamStatus || "IDLE"}
        </Badge>
      </div>

      <div className="space-y-1.5 rounded-md border bg-muted/30 p-2">
        <CopyField label="RTMP URL" value={rtmpUrl} />
        <CopyField label="Stream Key" value={streamKey} />
        <CopyField label="HLS Playback URL" value={hlsUrl} />
        {sessionPageUrl && <CopyField label="Attendee Page" value={sessionPageUrl} />}
      </div>

      <p className="text-[10px] text-muted-foreground">
        Zoom auto-streams when the host starts the meeting. Attendees watch via the embedded player at the attendee page URL.
      </p>
    </div>
  );
}
