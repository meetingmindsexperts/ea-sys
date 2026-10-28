"use client";

/**
 * The webinar's exit screen (owner, Oct 28, 2026): once the webinar is over for this viewer (see
 * isWebinarOver) the attendee page drops the video and tabs for a thank-you. Same URL, so a refresh or a
 * later visit shows it too. The end-of-webinar survey keeps its own banner and popup above it, and the
 * replay appears here once the organiser has switched the recording on.
 */
import { CheckCircle2, ExternalLink, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export function WebinarExitScreen({
  sessionName,
  hasRecording,
  recordingPassword,
  recordingLoading,
  recordingError,
  replayExpected,
  onWatchRecording,
  onRejoin,
}: {
  sessionName: string;
  /** The recording is fetched and the organiser has switched it on. */
  hasRecording: boolean;
  recordingPassword: string | null;
  recordingLoading: boolean;
  /** Why the replay did not open (not registered, network), shown under the button. */
  recordingError: string | null;
  /** The organiser has switched the recording on but Zoom has not delivered it yet. */
  replayExpected: boolean;
  onWatchRecording: () => void;
  /** Back into the room, for a host who ended in Zoom and restarted while the room is still open. */
  onRejoin?: () => void;
}) {
  return (
    <Card className="overflow-hidden shadow-sm">
      <CardContent className="flex flex-col items-center gap-5 px-6 py-14 text-center sm:py-20">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100">
          <CheckCircle2 className="h-9 w-9 text-emerald-600" />
        </div>
        <div className="space-y-2">
          <h2 className="text-2xl font-bold sm:text-3xl">Thank you for attending</h2>
          <p className="mx-auto max-w-xl text-muted-foreground">
            {sessionName} has ended. We hope you enjoyed it.
          </p>
        </div>

        {hasRecording && (
          <div className="flex flex-col items-center gap-2">
            <Button className="gap-2" onClick={onWatchRecording} disabled={recordingLoading}>
              <PlayCircle className="h-4 w-4" />
              {recordingLoading ? "Loading…" : "Watch the replay"}
              <ExternalLink className="h-4 w-4" />
            </Button>
            {recordingError && <p className="text-xs text-red-600">{recordingError}</p>}
            {recordingPassword && (
              <p className="text-xs text-muted-foreground">
                Passcode: <span className="font-mono">{recordingPassword}</span>
              </p>
            )}
          </div>
        )}

        <p className="text-sm text-muted-foreground">
          {replayExpected ? "The replay will be available here soon. Check back later." : "You can close this page."}
        </p>

        {onRejoin && (
          <Button variant="link" size="sm" className="text-muted-foreground" onClick={onRejoin}>
            The host restarted the webinar? Rejoin
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
