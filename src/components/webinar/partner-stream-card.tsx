"use client";

/**
 * The Partner stream card (Nov 16, 2026; external streams step 5,
 * docs/EXTERNAL_STREAM_AND_PRERECORDED_PLAN.md §4.4). On a webinar streamed by
 * a partner it takes the place of the Zoom controls: issue the partner's key,
 * show it (audited, "See Zoom host details" only), see whether their video is
 * arriving, replace the key, cut the feed.
 *
 * The key is never kept in the page's data: it is fetched by a press, held in
 * this card's state while shown, and dropped on Hide.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Copy, Eye, EyeOff, KeyRound, Loader2, Radio, RotateCw, Scissors, Power } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { useCan } from "@/hooks/use-can";
import {
  useRevealWebinarPartnerStreamKey,
  useUpdateWebinarPartnerStream,
  useWebinarPartnerStream,
  useWebinarPartnerStreamAction,
  type WebinarPartnerStreamChange,
  type WebinarPartnerStreamState,
  type WebinarPartnerStreamView,
} from "@/hooks/use-api";
import { formatDateTimeInTz, localDateTimeInTz, wallTimeInTzToIso } from "@/lib/event-time";

type Signal = WebinarPartnerStreamState["signal"];

/** What we ask the partner's encoder for: the server passes the picture through untouched (plan §4.4). */
export const PARTNER_ENCODER_SETTINGS: ReadonlyArray<{ setting: string; value: string; why: string }> = [
  { setting: "Video", value: "H.264", why: "The player and iPhones need it" },
  { setting: "Audio", value: "AAC", why: "The same" },
  { setting: "Keyframe", value: "Every 2 seconds", why: "A longer gap freezes iPhones" },
  { setting: "Size and rate", value: "720p, 30 frames, about 2.5 Mbps (up to 1080p at 4.5 Mbps)", why: "Every attendee downloads exactly this" },
];

export function partnerSignalLabel(signal: Signal, enabled: boolean): { text: string; tone: string } {
  if (!enabled) return { text: "Key switched off", tone: "bg-slate-200 text-slate-700" };
  if (signal === "receiving") return { text: "Receiving", tone: "bg-green-100 text-green-800" };
  if (signal === "not-receiving") return { text: "Not receiving", tone: "bg-amber-100 text-amber-800" };
  return { text: "Not known", tone: "bg-slate-100 text-slate-700" };
}

/** After a change that also tried to end the running stream: say so only when that failed. */
function reportDisconnect(change: WebinarPartnerStreamChange, done: string) {
  const d = change.disconnect;
  if (d && !d.ok) {
    toast.warning(`${done}, but the running stream could not be cut yet: ${d.error} It is tried again within a minute.`);
    return;
  }
  toast.success(done);
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

async function copy(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  } catch (err) {
    toast.error(errorText(err, `Could not copy the ${label.toLowerCase()}`));
  }
}

export function PartnerStreamCard({ eventId, timezone }: { eventId: string; timezone: string }) {
  const canManage = useCan("webinar.manage", eventId) === "allowed";
  const state = useWebinarPartnerStream(eventId, canManage);

  if (!canManage) {
    return (
      <PartnerCardShell>
        <p className="text-sm text-muted-foreground">
          This webinar is streamed by a partner from their own platform. Managing its stream key needs &quot;Run the webinar&quot;.
        </p>
      </PartnerCardShell>
    );
  }
  if (state.isLoading) {
    return (
      <PartnerCardShell>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the partner stream…
        </p>
      </PartnerCardShell>
    );
  }
  if (state.isError || !state.data) {
    return (
      <PartnerCardShell>
        <p className="text-sm text-red-600">{errorText(state.error, "Could not load the partner stream.")}</p>
      </PartnerCardShell>
    );
  }
  const { partnerStream, signal, serverReady, canSeeKey } = state.data;
  if (!partnerStream) return <IssueKey eventId={eventId} timezone={timezone} serverReady={serverReady} />;
  return (
    <IssuedKey eventId={eventId} timezone={timezone} stream={partnerStream} signal={signal} canSeeKey={canSeeKey} />
  );
}

function PartnerCardShell({ badge, children }: { badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card data-testid="partner-stream-card">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2.5">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-violet-100 text-violet-700">
                <Radio className="h-4 w-4" />
              </span>
              Partner stream
            </CardTitle>
            <CardDescription className="mt-1.5">
              The partner pushes their video to our stream server; attendees watch it here with our chat, Q&amp;A, polls and handouts.
            </CardDescription>
          </div>
          {badge}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">{children}</CardContent>
    </Card>
  );
}

function IssueKey({ eventId, timezone, serverReady }: { eventId: string; timezone: string; serverReady: boolean }) {
  const action = useWebinarPartnerStreamAction(eventId);
  const [issuedTo, setIssuedTo] = useState("");
  const [validUntil, setValidUntil] = useState("");

  const issue = async () => {
    const until = validUntil ? wallTimeInTzToIso(validUntil, timezone) : null;
    if (validUntil && !until) {
      toast.error("The end date is not a valid date");
      return;
    }
    try {
      await action.mutateAsync({ action: "issue", issuedTo: issuedTo.trim() || null, validUntil: until });
      toast.success("Key issued. Show it to copy the two values for the partner.");
    } catch (err) {
      toast.error(errorText(err, "Could not issue the key"));
    }
  };

  if (!serverReady) {
    return (
      <PartnerCardShell>
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          This server is not set up to issue a partner&apos;s stream key yet. The system administrator finishes the stream
          server setup first (the publish secret and the control address); until then no key can be issued.
        </p>
      </PartnerCardShell>
    );
  }

  return (
    <PartnerCardShell>
      <p className="text-sm text-muted-foreground">
        No key has been issued yet. Issue one, then hand the partner the server and stream key it shows.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="partner-issued-to">Given to (optional)</Label>
          <Input
            id="partner-issued-to"
            value={issuedTo}
            maxLength={200}
            onChange={(e) => setIssuedTo(e.target.value)}
            placeholder="Agency or technician"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="partner-valid-until">Works until (optional)</Label>
          <Input id="partner-valid-until" type="datetime-local" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          <p className="text-xs text-muted-foreground">Empty: until 24 hours after the webinar&apos;s scheduled end, and it moves with the webinar.</p>
        </div>
      </div>
      <Button onClick={() => void issue()} disabled={action.isPending}>
        {action.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
        Issue the key
      </Button>
      <EncoderSettings />
    </PartnerCardShell>
  );
}

function IssuedKey({
  eventId,
  timezone,
  stream,
  signal,
  canSeeKey,
}: {
  eventId: string;
  timezone: string;
  stream: WebinarPartnerStreamView;
  signal: Signal;
  canSeeKey: boolean;
}) {
  const label = partnerSignalLabel(signal, stream.enabled);
  const badge = <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${label.tone}`}>{label.text}</span>;
  const when = (iso: string) => formatDateTimeInTz(new Date(iso), timezone);

  return (
    <PartnerCardShell badge={badge}>
      <dl className="grid gap-x-6 gap-y-3 text-sm md:grid-cols-2">
        <Fact term="Given to" value={stream.issuedTo ?? "Not recorded"} />
        <Fact term="Last connection" value={stream.lastPublishAt ? when(stream.lastPublishAt) : "None yet"} />
        <Fact term="Works from" value={when(stream.validFrom)} />
        <Fact
          term="Works until"
          value={`${when(stream.validUntil)}${stream.validUntilIsOwn ? "" : " (24 hours after the scheduled end)"}`}
        />
      </dl>
      {!stream.enabled && (
        <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">
          The key is switched off: every connection is refused until it is switched on again.
        </p>
      )}
      <KeyReveal eventId={eventId} canSeeKey={canSeeKey} />
      <KeyDetails key={`${stream.issuedTo ?? ""}:${stream.validUntil}`} eventId={eventId} timezone={timezone} stream={stream} />
      <KeyActions eventId={eventId} enabled={stream.enabled} />
      <EncoderSettings />
    </PartnerCardShell>
  );
}

function Fact({ term, value }: { term: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{term}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function KeyReveal({ eventId, canSeeKey }: { eventId: string; canSeeKey: boolean }) {
  const reveal = useRevealWebinarPartnerStreamKey(eventId);
  const [shown, setShown] = useState<{ serverUrl: string; streamKey: string } | null>(null);

  if (!canSeeKey) {
    return (
      <p className="text-sm text-muted-foreground">
        Showing the server and stream key needs &quot;See Zoom host details&quot;. Ask someone who holds it to hand them over.
      </p>
    );
  }

  const show = async () => {
    try {
      const res = await reveal.mutateAsync();
      setShown(res.credentials);
    } catch (err) {
      toast.error(errorText(err, "Could not show the key"));
    }
  };

  if (!shown) {
    return (
      <div className="space-y-1.5 rounded-lg border p-4">
        <p className="font-medium">Server and stream key</p>
        <p className="text-sm text-muted-foreground">The two values the partner types into their platform. Each look is recorded.</p>
        <Button variant="outline" size="sm" onClick={() => void show()} disabled={reveal.isPending}>
          {reveal.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Eye className="mr-2 h-4 w-4" />}
          Show the key
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">Server and stream key</p>
        <Button variant="ghost" size="sm" onClick={() => setShown(null)}>
          <EyeOff className="mr-2 h-4 w-4" />
          Hide
        </Button>
      </div>
      <CopyRow label="Server" value={shown.serverUrl} />
      <CopyRow label="Stream key" value={shown.streamKey} />
      <p className="text-xs text-muted-foreground">
        The stream key includes its password after the question mark: the partner pastes the whole value.
      </p>
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs uppercase tracking-wide text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <Input value={value} readOnly className="font-mono text-xs" aria-label={label} />
        <Button type="button" size="icon" variant="outline" onClick={() => void copy(value, label)} title={`Copy ${label.toLowerCase()}`}>
          <Copy className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function KeyDetails({ eventId, timezone, stream }: { eventId: string; timezone: string; stream: WebinarPartnerStreamView }) {
  const update = useUpdateWebinarPartnerStream(eventId);
  const [issuedTo, setIssuedTo] = useState(stream.issuedTo ?? "");
  const [validUntil, setValidUntil] = useState(() =>
    stream.validUntilIsOwn ? localDateTimeInTz(new Date(stream.validUntil), timezone) : "",
  );

  const save = async (followSession: boolean) => {
    const until = followSession || !validUntil ? null : wallTimeInTzToIso(validUntil, timezone);
    if (!followSession && validUntil && !until) {
      toast.error("The end date is not a valid date");
      return;
    }
    try {
      await update.mutateAsync({ issuedTo: issuedTo.trim() || null, validUntil: until });
      toast.success("Saved");
    } catch (err) {
      toast.error(errorText(err, "Could not save"));
    }
  };

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <p className="font-medium">Details</p>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="partner-edit-issued-to">Given to</Label>
          <Input id="partner-edit-issued-to" value={issuedTo} maxLength={200} onChange={(e) => setIssuedTo(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="partner-edit-valid-until">Works until</Label>
          <Input
            id="partner-edit-valid-until"
            type="datetime-local"
            value={validUntil}
            onChange={(e) => setValidUntil(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">Empty: 24 hours after the scheduled end, moving with the webinar.</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void save(false)} disabled={update.isPending}>
          {update.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save details
        </Button>
        {stream.validUntilIsOwn && (
          <Button size="sm" variant="outline" onClick={() => void save(true)} disabled={update.isPending}>
            Follow the webinar&apos;s date again
          </Button>
        )}
      </div>
    </div>
  );
}

type Confirmable = "replace" | "cut";

const CONFIRM_WORDS: Record<Confirmable, { title: string; body: string; button: string; done: string }> = {
  replace: {
    title: "Replace the partner's key?",
    body: "The key the partner holds stops working at once and their running stream is cut. Hand them the new key. The address attendees watch on stays the same.",
    button: "Replace the key",
    done: "Key replaced. Show it to hand the new one to the partner",
  },
  cut: {
    title: "Cut the feed?",
    body: "The partner's stream stops now and cannot reconnect until the key is switched on again. Attendees see the stream end.",
    button: "Cut the feed",
    done: "Feed cut: the key is switched off",
  },
};

function KeyActions({ eventId, enabled }: { eventId: string; enabled: boolean }) {
  const action = useWebinarPartnerStreamAction(eventId);
  const [confirming, setConfirming] = useState<Confirmable | null>(null);

  const run = async (which: Confirmable | "switch-on") => {
    setConfirming(null);
    try {
      const res = await action.mutateAsync({ action: which });
      if (which === "switch-on") {
        toast.success("Key switched on: the partner can connect again");
        return;
      }
      reportDisconnect(res, CONFIRM_WORDS[which].done);
    } catch (err) {
      toast.error(errorText(err, "The change did not go through"));
    }
  };

  const words = confirming ? CONFIRM_WORDS[confirming] : null;
  return (
    <div className="flex flex-wrap gap-2 border-t pt-4">
      <Button variant="outline" size="sm" onClick={() => setConfirming("replace")} disabled={action.isPending}>
        <RotateCw className="mr-2 h-4 w-4" />
        Replace the key
      </Button>
      {enabled ? (
        <Button variant="destructive" size="sm" onClick={() => setConfirming("cut")} disabled={action.isPending}>
          <Scissors className="mr-2 h-4 w-4" />
          Cut the feed
        </Button>
      ) : (
        <Button size="sm" onClick={() => void run("switch-on")} disabled={action.isPending}>
          <Power className="mr-2 h-4 w-4" />
          Switch the key on
        </Button>
      )}
      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{words?.title}</AlertDialogTitle>
            <AlertDialogDescription>{words?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <Button
              variant={confirming === "cut" ? "destructive" : "default"}
              onClick={() => confirming && void run(confirming)}
              disabled={action.isPending}
            >
              {words?.button}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EncoderSettings() {
  return (
    <details className="rounded-lg border p-4 text-sm">
      <summary className="cursor-pointer font-medium">What to ask the partner&apos;s encoder for</summary>
      <table className="mt-3 w-full text-left">
        <tbody className="divide-y">
          {PARTNER_ENCODER_SETTINGS.map((row) => (
            <tr key={row.setting}>
              <th className="py-1.5 pr-3 font-medium">{row.setting}</th>
              <td className="py-1.5 pr-3">{row.value}</td>
              <td className="py-1.5 text-muted-foreground">{row.why}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

