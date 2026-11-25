/**
 * What the console says about a partner stream's recording (Nov 25, 2026;
 * docs/PARTNER_STREAM_RECORDING_PLAN.md step 3, §4.5). Pure, so the words and
 * the "pieces are not arriving" rule are tested without a page.
 */

export type RecordingDisplayStatus = "RECORDING" | "PAUSED" | "FINISHING" | "READY" | "FAILED";

/**
 * A piece is 6 seconds, settles for 20 before it is moved, and the job moving
 * pieces runs every minute: about a minute and a half from being recorded to
 * being in storage. Past three minutes with the partner's video arriving,
 * something is wrong.
 */
export const PIECES_LATE_MS = 3 * 60 * 1000;

/** "0:42", "12:05", "1:02:09". */
export function recordedLength(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h === 0) return `${m}:${ss}`;
  return `${h}:${String(m).padStart(2, "0")}:${ss}`;
}

/** "0 MB", "450 MB", "1.2 GB". Video is never small enough for KB to matter. */
export function recordedSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export interface RecordingState {
  label: string;
  /** Recording now: the red REC mark. */
  live: boolean;
  /** One plain line under the label. */
  hint: string | null;
}

/**
 * The recording's state in words. `receiving` is the partner stream card's
 * signal: an open recording with no video arriving is armed, not recording.
 */
export function recordingState(status: RecordingDisplayStatus, receiving: boolean, error: string | null): RecordingState {
  if (status === "RECORDING" && receiving) return { label: "Recording", live: true, hint: null };
  if (status === "RECORDING") {
    return { label: "Ready to record", live: false, hint: "Recording starts the moment the partner's stream arrives." };
  }
  if (status === "PAUSED") return { label: "Stopped", live: false, hint: "Start again carries on the same recording, with a break marked." };
  if (status === "FINISHING") return { label: "Finished", live: false, hint: "The file to download is being prepared." };
  if (status === "READY") return { label: "Ready", live: false, hint: null };
  return { label: "Failed", live: false, hint: error ?? "The recording could not be completed. Tell a developer." };
}

/**
 * Minutes since the last piece reached storage, when that is late: recording,
 * the partner's video arriving, and nothing new for PIECES_LATE_MS. Counted
 * from the latest of the newest piece, the last Start, and the partner's last
 * connection: a recording armed hours early is not late the moment the
 * partner connects. Null when nothing is wrong.
 */
export function piecesLateMinutes(
  recording: { status: RecordingDisplayStatus; lastStartedAt: string; lastPieceAt: string | null },
  partner: { receiving: boolean; lastConnectionAt: string | null },
  now: number,
): number | null {
  if (recording.status !== "RECORDING" || !partner.receiving) return null;
  const since = now - Math.max(time(recording.lastStartedAt), time(recording.lastPieceAt), time(partner.lastConnectionAt));
  if (since <= PIECES_LATE_MS) return null;
  return Math.floor(since / 60_000);
}

function time(iso: string | null): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}
