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
import { Video, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useCreateZoomMeeting, useDeleteZoomMeeting } from "@/hooks/use-api";

interface ZoomMeetingFormProps {
  eventId: string;
  sessionId: string;
  sessionName: string;
  hasZoomMeeting?: boolean;
  zoomMeetingType?: string;
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

  if (hasZoomMeeting) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          <Video className="h-3 w-3 text-blue-600" />
          {zoomMeetingType === "WEBINAR" || zoomMeetingType === "WEBINAR_SERIES"
            ? "Zoom Webinar"
            : "Zoom Meeting"}{" "}
          linked
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-red-600 hover:text-red-700 hover:bg-red-50"
          onClick={handleDelete}
          disabled={deleteMeeting.isPending}
        >
          {deleteMeeting.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Trash2 className="h-3 w-3" />
          )}
        </Button>
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
