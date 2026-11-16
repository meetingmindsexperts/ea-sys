"use client";

/**
 * The Partner stream card (Nov 16, 2026; external streams step 5,
 * docs/EXTERNAL_STREAM_AND_PRERECORDED_PLAN.md §4.4). On a webinar streamed by
 * a partner it takes the place of the Zoom controls: issue the partner's key,
 * show it (audited, "See Zoom host details" only), see whether their video is
 * arriving, replace the key, cut the feed.
 *
 * The key is never kept in the page's data: it is fetched by a press, held in
 * this card's state while shown, and dropped on Hide, on leaving the page, and
 * when the key is replaced (the old value is dead then, and must not stay on
 * screen to be copied: review of d86921d4, HIGH).
 */
import { useEffect, useState } from "react";
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
import { PARTNER_ENCODER_SETTINGS, partnerHandoverText } from "@/lib/webinar/partner-handover";

type Signal = WebinarPartnerStreamState["signal"];

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

/** What the card needs to know about the webinar for the partner's handover message. */
export interface PartnerWebinarFacts {
  eventName: string;
  eventSlug: string | null;
  eventStatus: string | undefined;
  sessionId: string | null;
  scheduledStart: string | null;
}

export function PartnerStreamCard({
  eventId,
  timezone,
  webinar,
}: {
  eventId: string;
  timezone: string;
  webinar: PartnerWebinarFacts;
}) {
  const access = useCan("webinar.manage", eventId);
  const canManage = access === "allowed";
  const state = useWebinarPartnerStream(eventId, canManage);

  if (access === "loading" || (canManage && state.isLoading)) {
    return (
      <PartnerCardShell>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the partner stream…
        </p>
      </PartnerCardShell>
    );
  }
  if (!canManage) {
    return (
      <PartnerCardShell>
        <p className="text-sm text-muted-foreground">
          This webinar is streamed by a partner from their own platform. Managing its stream key needs the &quot;Webinar console&quot; permission.
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
  const { partnerStream, signal, serverReady, canSeeKey, controlApi } = state.data;
  const controlNotice = serverReady ? <ControlApiNotice check={controlApi} /> : null;
  if (!partnerStream) {
    return <IssueKey eventId={eventId} timezone={timezone} serverReady={serverReady} notice={controlNotice} />;
  }
  return (
    <IssuedKey
      eventId={eventId}
      timezone={timezone}
      webinar={webinar}
      stream={partnerStream}
      signal={signal}
      canSeeKey={canSeeKey}
      notice={controlNotice}
    />
  );
}

const CONTROL_API_PROBLEM: Record<"UNREACHABLE" | "REFUSED" | "BAD_ANSWER", string> = {
  UNREACHABLE: "The stream server's control connection is not answering.",
  REFUSED: "The stream server refused our control connection.",
  BAD_ANSWER: "The stream server's control connection gave an answer we could not read.",
};

/**
 * Said when the control API does not work (review of c1b4ae83, HIGH): the environment said "ready",
 * so keys were issued, and Cut the feed failed only when it was needed during a webinar.
 */
function ControlApiNotice({ check }: { check: WebinarPartnerStreamState["controlApi"] | undefined }) {
  if (!check || check === "ok" || check === "NOT_CONFIGURED") return null;
  return (
    <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900" role="status">
      {CONTROL_API_PROBLEM[check]} Cut the feed still switches the key off and Replace still stops the old key
      working, but neither can end a stream that is already running until the system administrator fixes it.
      The stream server is asked again every minute.
    </p>
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

function IssueKey({
  eventId,
  timezone,
  serverReady,
  notice,
}: {
  eventId: string;
  timezone: string;
  serverReady: boolean;
  notice: React.ReactNode;
}) {
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
      {notice}
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
  webinar,
  stream,
  signal,
  canSeeKey,
  notice,
}: {
  eventId: string;
  timezone: string;
  webinar: PartnerWebinarFacts;
  stream: WebinarPartnerStreamView;
  signal: Signal;
  canSeeKey: boolean;
  notice: React.ReactNode;
}) {
  const label = partnerSignalLabel(signal, stream.enabled);
  const badge = <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${label.tone}`}>{label.text}</span>;
  const when = (iso: string) => formatDateTimeInTz(new Date(iso), timezone);

  return (
    <PartnerCardShell badge={badge}>
      {notice}
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
      {/* Keyed by the version: a replaced key remounts this, so the dead value is gone from the screen. */}
      <KeyReveal
        key={stream.secretVersion}
        eventId={eventId}
        canSeeKey={canSeeKey}
        handover={{ webinar, timezone, stream }}
      />
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

function KeyReveal({
  eventId,
  canSeeKey,
  handover,
}: {
  eventId: string;
  canSeeKey: boolean;
  /** What the handover message says besides the key: the webinar and the key's period. */
  handover: { webinar: PartnerWebinarFacts; timezone: string; stream: WebinarPartnerStreamView };
}) {
  const reveal = useRevealWebinarPartnerStreamKey(eventId);
  const [shown, setShown] = useState<{ serverUrl: string; streamKey: string } | null>(null);
  // Who the partner calls on the day. Only in the message: never saved.
  const [contact, setContact] = useState("");
  const handoverBlocked = handoverRefusal(handover.stream);
  // The mutation keeps its answer in React Query's cache after the card lets go of it: clear it too.
  const { reset } = reveal;
  useEffect(() => reset, [reset]);
  const hide = () => {
    setShown(null);
    reset();
  };

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
        <Button variant="ghost" size="sm" onClick={hide}>
          <EyeOff className="mr-2 h-4 w-4" />
          Hide
        </Button>
      </div>
      <CopyRow label="Server" value={shown.serverUrl} />
      <CopyRow label="Stream key" value={shown.streamKey} />
      <p className="text-xs text-muted-foreground">
        The stream key includes its password after the question mark: the partner pastes the whole value.
      </p>
      <div className="space-y-2 border-t pt-3">
        <p className="text-sm font-medium">Handover message for the partner</p>
        <p className="text-xs text-muted-foreground">
          The two values, when the key works, the encoder settings and who to call, ready to paste into an email.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[220px] flex-1 space-y-1">
            <Label htmlFor="partner-handover-contact" className="text-xs">Contact on the day (optional, not saved)</Label>
            <Input
              id="partner-handover-contact"
              value={contact}
              maxLength={200}
              onChange={(e) => setContact(e.target.value)}
              placeholder="Name, phone"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={handoverBlocked !== null}
            onClick={() => void copy(buildHandover(shown, handover, contact), "Handover message")}
          >
            <Copy className="mr-2 h-4 w-4" />
            Copy handover message
          </Button>
        </div>
        {handoverBlocked && <p className="text-xs text-amber-700">{handoverBlocked}</p>}
      </div>
    </div>
  );
}

/**
 * Why the handover message cannot be copied now, or null: it would hand the partner a key that does
 * not work, with a period that is wrong or over (review of 1f98a508).
 */
function handoverRefusal(stream: WebinarPartnerStreamView): string | null {
  if (!stream.enabled) return "The key is switched off: switch it on before you send it.";
  if (new Date(stream.validUntil).getTime() <= Date.now()) return "The key's end date has passed: set a later \"Works until\" first.";
  return null;
}

/** The message, from the key this card was just shown: never a second read of it. */
function buildHandover(
  shown: { serverUrl: string; streamKey: string },
  handover: { webinar: PartnerWebinarFacts; timezone: string; stream: WebinarPartnerStreamView },
  contact: string,
): string {
  const { webinar, stream } = handover;
  const pageUrl =
    webinar.eventSlug && webinar.sessionId ? `${window.location.origin}/e/${webinar.eventSlug}/session/${webinar.sessionId}` : null;
  return partnerHandoverText({
    eventName: webinar.eventName,
    serverUrl: shown.serverUrl,
    streamKey: shown.streamKey,
    validFrom: new Date(stream.validFrom),
    validUntil: new Date(stream.validUntil),
    validUntilIsOwn: stream.validUntilIsOwn,
    scheduledStart: webinar.scheduledStart ? new Date(webinar.scheduledStart) : null,
    pageUrl,
    draft: webinar.eventStatus === "DRAFT",
    timezone: handover.timezone,
    contact,
  });
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

  const savedUntil = stream.validUntilIsOwn ? localDateTimeInTz(new Date(stream.validUntil), timezone) : "";
  const save = async (followSession: boolean) => {
    const until = followSession || !validUntil ? null : wallTimeInTzToIso(validUntil, timezone);
    if (!followSession && validUntil && !until) {
      toast.error("The end date is not a valid date");
      return;
    }
    // Only what changed: resending an end date that has already passed would refuse a change of "Given to"
    // on an expired key (review of d86921d4).
    const body: { issuedTo?: string | null; validUntil?: string | null } = {};
    const nextIssuedTo = issuedTo.trim() || null;
    if (nextIssuedTo !== stream.issuedTo) body.issuedTo = nextIssuedTo;
    if (followSession || validUntil !== savedUntil) body.validUntil = until;
    if (Object.keys(body).length === 0) {
      toast.info("Nothing to save");
      return;
    }
    try {
      await update.mutateAsync(body);
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
    body: "The partner's stream stops now and cannot reconnect until the key is switched on again. Attendees see \"The stream was interrupted\" and wait for it to come back: to end the webinar for them, close the room.",
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

