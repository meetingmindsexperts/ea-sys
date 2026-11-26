"use client";

/**
 * Recording a partner's stream, in the console (Nov 25, 2026;
 * docs/PARTNER_STREAM_RECORDING_PLAN.md step 3, §4.5): the partner's agreement,
 * Start, Stop, Finish, and the red REC mark with the time and size recorded so
 * far. Shown in the Partner stream card and on the Recording tab; both read the
 * same polled query, so they never disagree.
 *
 * Shown only on a server set up for recording, unless a recording already
 * exists (it can always be finished). Download and Delete come with the MP4
 * (step 4).
 *
 * "Record with the room" (Nov 26, 2026): with it on, opening the room starts
 * or carries on the recording and closing it stops it, so staff need not
 * press Start at the right moment (stream-recording-service.ts).
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CircleDot, Download, Flag, Loader2, Pause, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
  useDeleteWebinarStreamRecording,
  useDownloadWebinarStreamRecording,
  useSetWebinarRecordWithRoom,
  useWebinarPartnerStream,
  useWebinarStreamRecording,
  useWebinarStreamRecordingAction,
  type WebinarStreamRecordingChange,
  type WebinarStreamRecordingView,
} from "@/hooks/use-api";
import { useServerClock } from "@/hooks/use-server-clock";
import {
  piecesLateMinutes,
  recordedLength,
  recordedSize,
  recordingState,
  type PartnerSignal,
} from "@/lib/webinar/recording-display";

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** After a change: say so, and add a line when the stream server did not take it yet. */
function report(change: WebinarStreamRecordingChange, done: string) {
  if (!change.server.ok) {
    toast.warning(`${done}, but the stream server did not take it yet: ${change.server.error} It is tried again within a minute.`);
    return;
  }
  toast.success(done);
}

/**
 * The server's time, ticking every 15 seconds, for the "no new pieces" line:
 * the times it compares are the server's, and a laptop clock a minute and a
 * half fast would raise it on a healthy recording (review of be8511218). Null
 * until the offset is measured, so nothing is said on a guess.
 */
function useServerNow(): number | null {
  const clock = useServerClock();
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  if (clock.offsetMs === null) return null;
  return tick + clock.offsetMs;
}

/** The partner's signal as the panel uses it: a switched-off key is not arriving; no answer yet is not known. */
function partnerSignal(data: ReturnType<typeof useWebinarPartnerStream>["data"]): PartnerSignal {
  if (!data) return "unknown";
  if (data.partnerStream && !data.partnerStream.enabled) return "not-receiving";
  if (data.signal === "receiving" || data.signal === "not-receiving") return data.signal;
  return "unknown";
}

/**
 * `placement` says where it sits: inside the Partner stream card (a section
 * with a rule above it, nothing at all when recording is not offered) or on
 * the Recording tab (says why when it is not offered).
 */
export function StreamRecordingPanel({ eventId, placement }: { eventId: string; placement: "card" | "tab" }) {
  // The caller has already checked webinar.manage: the card and the tab render this only for a holder.
  const state = useWebinarStreamRecording(eventId, true);
  const partner = useWebinarPartnerStream(eventId, true);

  if (state.isLoading) {
    if (placement === "card") return null;
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading the recording…
      </p>
    );
  }
  // A failed refetch keeps the last answer on screen, with Stop and Finish (review of be8511218); only a first
  // read that failed has nothing to show.
  if (!state.data) {
    return <p className="text-sm text-red-600">{errorText(state.error, "Could not load the recording.")}</p>;
  }
  const { available, recording } = state.data;
  const withRoom = state.data.recordWithRoom ?? null;
  if (!recording && !available) {
    if (placement === "card") return null;
    return <p className="text-sm text-muted-foreground">Recording a partner&apos;s stream is not set up on this server yet.</p>;
  }
  const stream = partner.data?.partnerStream ?? null;
  const signal = partnerSignal(partner.data);

  return (
    <section
      className={placement === "card" ? "space-y-3 border-t pt-4" : "space-y-3"}
      data-testid="stream-recording-panel"
      aria-label="Recording"
    >
      {placement === "card" && <h3 className="text-sm font-semibold">Recording</h3>}
      {recording ? (
        <RecordingNow
          eventId={eventId}
          recording={recording}
          available={available}
          withRoom={withRoom !== null}
          partner={{ signal, lastConnectionAt: stream?.lastPublishAt ?? null }}
        />
      ) : (
        <StartFirst eventId={eventId} keyIssued={stream !== null} receiving={signal === "receiving"} withRoom={withRoom} />
      )}
    </section>
  );
}

/** What "record with the room" does, in one line. */
const WITH_ROOM_TEXT =
  "Opening the room starts the recording, or carries it on; closing it stops it. A room opened more than 30 minutes before the start is a rehearsal and is not recorded.";

/** The "record with the room" switch. Turning it on confirms the partner's agreement, so it is offered only once that is given. */
function WithRoomSwitch({ eventId, on, agreed }: { eventId: string; on: boolean; agreed: boolean }) {
  const set = useSetWebinarRecordWithRoom(eventId);
  const change = async (next: boolean) => {
    try {
      await set.mutateAsync({ on: next, partnerAgreed: next ? agreed : undefined });
      toast.success(next ? "Recording will follow the room" : "Recording no longer follows the room");
    } catch (err) {
      toast.error(errorText(err, "The change did not go through"));
    }
  };
  return (
    <div className="flex items-start gap-3">
      <Switch
        id="stream-recording-with-room"
        checked={on}
        onCheckedChange={(v) => void change(v)}
        disabled={set.isPending || (!on && !agreed)}
        className="mt-0.5"
      />
      <div className="space-y-0.5">
        <Label htmlFor="stream-recording-with-room" className="font-normal leading-snug">
          Start and stop with the room
        </Label>
        <p className="text-xs text-muted-foreground">{WITH_ROOM_TEXT}</p>
      </div>
    </div>
  );
}

function StartFirst({
  eventId,
  keyIssued,
  receiving,
  withRoom,
}: {
  eventId: string;
  keyIssued: boolean;
  receiving: boolean;
  withRoom: { agreedAt: string } | null;
}) {
  const action = useWebinarStreamRecordingAction(eventId);
  const [ticked, setTicked] = useState(false);
  // Switching "record with the room" on confirmed the agreement already.
  const agreed = ticked || withRoom !== null;

  const start = async () => {
    try {
      const res = await action.mutateAsync({ action: "start", partnerAgreed: agreed });
      report(res, receiving ? "Recording started" : "Recording armed: it starts when the partner's stream arrives");
    } catch (err) {
      toast.error(errorText(err, "Recording did not start"));
    }
  };

  if (!keyIssued) {
    return <p className="text-sm text-muted-foreground">Issue the partner&apos;s key first. Recording is started here once the key exists.</p>;
  }
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        {withRoom
          ? "Not recorded yet. Recording starts when the room is opened."
          : "Not recorded. Start before the stream begins to record from the moment the partner connects, or let the room start it."}
      </p>
      {withRoom ? (
        <p className="text-xs text-muted-foreground">The partner&apos;s agreement was confirmed {agreedOn(withRoom.agreedAt)}.</p>
      ) : (
        <div className="flex items-start gap-2">
          <Checkbox id="stream-recording-agreed" checked={ticked} onCheckedChange={(v) => setTicked(v === true)} />
          <Label htmlFor="stream-recording-agreed" className="font-normal leading-snug">
            The partner has agreed to this recording
          </Label>
        </div>
      )}
      <WithRoomSwitch eventId={eventId} on={withRoom !== null} agreed={agreed} />
      <Button size="sm" variant={withRoom ? "outline" : "default"} onClick={() => void start()} disabled={!agreed || action.isPending}>
        {action.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CircleDot className="mr-2 h-4 w-4 text-red-500" />}
        {withRoom ? "Start recording now" : "Start recording"}
      </Button>
    </div>
  );
}

function RecordingNow({
  eventId,
  recording,
  available,
  withRoom,
  partner,
}: {
  eventId: string;
  recording: WebinarStreamRecordingView;
  /** Whether this server can record: with it off, a stopped recording can be finished but not started again. */
  available: boolean;
  /** Whether the room starts and stops this recording. */
  withRoom: boolean;
  partner: { signal: PartnerSignal; lastConnectionAt: string | null };
}) {
  const action = useWebinarStreamRecordingAction(eventId);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const now = useServerNow();
  const shown = recordingState(recording.status, partner.signal, recording.error, recording.hasArchive);
  const late = now === null ? null : piecesLateMinutes(recording, partner, now);
  const open = recording.status === "RECORDING" || recording.status === "PAUSED";

  const run = async (which: "start" | "stop" | "finish", done: string) => {
    setConfirmFinish(false);
    try {
      report(await action.mutateAsync({ action: which }), done);
    } catch (err) {
      toast.error(errorText(err, "The change did not go through"));
    }
  };

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {shown.live ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-800">
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-600" aria-hidden="true" />
            REC
          </span>
        ) : (
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">{shown.label}</span>
        )}
        <span className="font-medium tabular-nums">{recordedLength(recording.durationMs)}</span>
        <span className="text-muted-foreground tabular-nums">{recordedSize(recording.totalBytes)}</span>
      </div>
      {shown.hint && <p className={recording.status === "FAILED" ? "text-red-600" : "text-muted-foreground"}>{shown.hint}</p>}
      {late !== null && (
        <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900" role="status">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          Nothing new has reached storage for {late} minutes. If this lasts, tell a developer: the
          recording may have a gap.
        </p>
      )}
      {open && (
        <div className="flex flex-wrap gap-2">
          {recording.status === "RECORDING" && (
            <Button size="sm" variant="outline" onClick={() => void run("stop", "Recording stopped")} disabled={action.isPending}>
              <Pause className="mr-2 h-4 w-4" />
              Stop
            </Button>
          )}
          {recording.status === "PAUSED" && available && (
            <Button size="sm" onClick={() => void run("start", "Recording carried on")} disabled={action.isPending}>
              <Play className="mr-2 h-4 w-4" />
              Start again
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setConfirmFinish(true)} disabled={action.isPending}>
            <Flag className="mr-2 h-4 w-4" />
            Finish recording
          </Button>
        </div>
      )}
      {open && (
        <p className="text-xs text-muted-foreground">
          Closing the room after the start stops the recording, and finishes it 10 minutes later unless the room is opened again.
        </p>
      )}
      {/* The recording exists, so the partner's agreement is on record: the switch needs no tick here. */}
      {open && (available || withRoom) && <WithRoomSwitch eventId={eventId} on={withRoom} agreed />}
      {(recording.status === "READY" || recording.status === "FAILED") && <ClosedRecording eventId={eventId} recording={recording} />}
      <AlertDialog open={confirmFinish} onOpenChange={setConfirmFinish}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Finish the recording?</AlertDialogTitle>
            <AlertDialogDescription>
              Nothing more is recorded for this webinar, and the file to download is prepared. A finished recording cannot be started again;
              to record again, delete it once its file is ready. To pause and carry on later, press Stop instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep recording</AlertDialogCancel>
            <Button onClick={() => void run("finish", "Recording finished")} disabled={action.isPending}>
              Finish recording
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function agreedOn(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "earlier" : `on ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
}

function keptUntil(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** After the file is made (or could not be): its size, Download, how long it is kept, Delete. */
function ClosedRecording({ eventId, recording }: { eventId: string; recording: WebinarStreamRecordingView }) {
  const download = useDownloadWebinarStreamRecording(eventId);
  const remove = useDeleteWebinarStreamRecording(eventId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const until = keptUntil(recording.deleteAfter);

  const startDownload = async () => {
    try {
      const { url } = await download.mutateAsync();
      // The signed link names the file and asks the browser to save it, so the page stays where it is.
      window.location.assign(url);
    } catch (err) {
      toast.error(errorText(err, "The download could not be prepared"));
    }
  };

  const confirmRemove = async () => {
    setConfirmDelete(false);
    try {
      await remove.mutateAsync();
      toast.success("Recording deleted");
    } catch (err) {
      toast.error(errorText(err, "The recording was not deleted"));
    }
  };

  return (
    <div className="space-y-3">
      {recording.hasArchive && recording.archiveBytes !== null && (
        <p className="text-muted-foreground">
          MP4 file, {recordedSize(recording.archiveBytes)}
          {until ? `. Kept until ${until}, then deleted.` : "."}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {recording.hasArchive && (
          <Button size="sm" onClick={() => void startDownload()} disabled={download.isPending}>
            {download.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            Download
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => setConfirmDelete(true)} disabled={remove.isPending}>
          <Trash2 className="mr-2 h-4 w-4" />
          Delete recording
        </Button>
      </div>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the recording?</AlertDialogTitle>
            <AlertDialogDescription>
              The recording and its file are deleted for good, for everyone. Download a copy first if the client may need it. After this, the
              webinar can be recorded again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <Button variant="destructive" onClick={() => void confirmRemove()} disabled={remove.isPending}>
              Delete recording
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
