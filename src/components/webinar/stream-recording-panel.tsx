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
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CircleDot, Flag, Loader2, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
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
  useWebinarPartnerStream,
  useWebinarStreamRecording,
  useWebinarStreamRecordingAction,
  type WebinarStreamRecordingChange,
  type WebinarStreamRecordingView,
} from "@/hooks/use-api";
import { piecesLateMinutes, recordedLength, recordedSize, recordingState } from "@/lib/webinar/recording-display";

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

/** A clock that ticks every 15 seconds, for the "no new pieces" line. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  return now;
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
  if (state.isError || !state.data) {
    return <p className="text-sm text-red-600">{errorText(state.error, "Could not load the recording.")}</p>;
  }
  const { available, recording } = state.data;
  if (!recording && !available) {
    if (placement === "card") return null;
    return <p className="text-sm text-muted-foreground">Recording a partner&apos;s stream is not set up on this server yet.</p>;
  }
  const stream = partner.data?.partnerStream ?? null;
  const facts = {
    receiving: partner.data?.signal === "receiving",
    lastConnectionAt: stream?.lastPublishAt ?? null,
    keyIssued: stream !== null,
  };

  return (
    <section
      className={placement === "card" ? "space-y-3 border-t pt-4" : "space-y-3"}
      data-testid="stream-recording-panel"
      aria-label="Recording"
    >
      {placement === "card" && <h3 className="text-sm font-semibold">Recording</h3>}
      {recording ? (
        <RecordingNow eventId={eventId} recording={recording} partner={facts} />
      ) : (
        <StartFirst eventId={eventId} keyIssued={facts.keyIssued} receiving={facts.receiving} />
      )}
    </section>
  );
}

function StartFirst({ eventId, keyIssued, receiving }: { eventId: string; keyIssued: boolean; receiving: boolean }) {
  const action = useWebinarStreamRecordingAction(eventId);
  const [agreed, setAgreed] = useState(false);

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
        Not recorded. Start before the stream begins to record from the moment the partner connects.
      </p>
      <div className="flex items-start gap-2">
        <Checkbox id="stream-recording-agreed" checked={agreed} onCheckedChange={(v) => setAgreed(v === true)} />
        <Label htmlFor="stream-recording-agreed" className="font-normal leading-snug">
          The partner has agreed to this recording
        </Label>
      </div>
      <Button size="sm" onClick={() => void start()} disabled={!agreed || action.isPending}>
        {action.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CircleDot className="mr-2 h-4 w-4 text-red-500" />}
        Start recording
      </Button>
    </div>
  );
}

function RecordingNow({
  eventId,
  recording,
  partner,
}: {
  eventId: string;
  recording: WebinarStreamRecordingView;
  partner: { receiving: boolean; lastConnectionAt: string | null };
}) {
  const action = useWebinarStreamRecordingAction(eventId);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const now = useNow();
  const shown = recordingState(recording.status, partner.receiving, recording.error);
  const late = piecesLateMinutes(recording, partner, now);
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
          Nothing new has reached storage for {late} minutes while the partner&apos;s video is arriving. If this lasts, tell a developer: the
          recording may have a gap.
        </p>
      )}
      {open && (
        <div className="flex flex-wrap gap-2">
          {recording.status === "RECORDING" ? (
            <Button size="sm" variant="outline" onClick={() => void run("stop", "Recording stopped")} disabled={action.isPending}>
              <Pause className="mr-2 h-4 w-4" />
              Stop
            </Button>
          ) : (
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
        <p className="text-xs text-muted-foreground">Closing the room after the webinar finishes the recording on its own.</p>
      )}
      <AlertDialog open={confirmFinish} onOpenChange={setConfirmFinish}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Finish the recording?</AlertDialogTitle>
            <AlertDialogDescription>
              Nothing more is recorded for this webinar, and the file to download is prepared. A finished recording cannot be started again.
              To pause and carry on later, press Stop instead.
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
