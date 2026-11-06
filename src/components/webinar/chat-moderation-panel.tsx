"use client";

import { useEffect, useRef, useState } from "react";
import { Download, FileText, Loader2, MessagesSquare, Pin, PinOff, RotateCcw, Send, Trash2, UserX, Volume2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useCan } from "@/hooks/use-can";
import {
  useUpdateWebinarChatSettings,
  useWebinarChatAction,
  useWebinarChatConsole,
  type WebinarChatAction,
  type WebinarChatConsoleMessage,
} from "@/hooks/use-api";
import { CHAT_MESSAGE_MAX } from "@/lib/webinar/chat";

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function SettingRow({
  id,
  title,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  title: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border p-3">
      <label htmlFor={id} className="space-y-0.5">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </label>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

/**
 * The Webinar Console's Chat tab (Nov 6, 2026; docs/WEBINAR_INTERACTION_PLAN.md §6.4): the switches,
 * the moderator, the live feed with real names, delete, pin, mute a person, a host's own message or
 * a shared handout, and the CSV record.
 */
export function ChatModerationPanel({ eventId }: { eventId: string }) {
  const canManage = useCan("webinar.manage", eventId) === "allowed";
  const canExport = useCan("webinar.attendance.export", eventId) === "allowed";
  const { data, isLoading, isError } = useWebinarChatConsole(eventId, true);
  const update = useUpdateWebinarChatSettings(eventId);
  const act = useWebinarChatAction(eventId);
  const [text, setText] = useState("");
  const [handoutId, setHandoutId] = useState("");
  const feedRef = useRef<HTMLUListElement | null>(null);
  const stick = useRef(true);
  const messages = data?.messages ?? [];

  useEffect(() => {
    const el = feedRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const chat = data?.chat ?? {};
  const live = chat.enabled === true && Boolean(data?.moderator);

  const change = async (body: Parameters<typeof update.mutateAsync>[0], done: string) => {
    try {
      await update.mutateAsync(body);
      toast.success(done);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change chat");
    }
  };
  const run = async (body: WebinarChatAction, done: string) => {
    try {
      await act.mutateAsync(body);
      toast.success(done);
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update chat");
      return false;
    }
  };
  const send = async () => {
    const body = text.trim();
    if (!body) return;
    const ok = await run({ action: "post", body, ...(handoutId ? { handoutId } : {}) }, handoutId ? "Handout shared" : "Message sent");
    if (ok) {
      setText("");
      setHandoutId("");
      stick.current = true;
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading chat…
      </div>
    );
  }
  if (isError || !data) return <p className="py-10 text-sm text-destructive">Could not load the chat.</p>;

  return (
    <div className="grid items-start gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-100 text-sky-700">
                <MessagesSquare className="h-4 w-4" />
              </span>
              Chat
              {live ? <Badge className="bg-green-100 text-green-800">On</Badge> : <Badge variant="secondary">Off</Badge>}
            </CardTitle>
            <CardDescription>
              Live messages from the people watching. Moderate here: you see every author&apos;s real name, even when they
              posted anonymously.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul
              ref={feedRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              }}
              className="h-[480px] space-y-1 overflow-y-auto rounded-md border p-2"
            >
              {messages.length === 0 ? (
                <li className="py-10 text-center text-sm text-muted-foreground">No messages yet.</li>
              ) : (
                messages.map((m) => (
                  <FeedLine key={m.id} m={m} canManage={canManage} busy={act.isPending} onAct={run} />
                ))
              )}
            </ul>
            {canManage && (
              <div className="space-y-2 rounded-md border p-3">
                <Textarea
                  value={text}
                  onChange={(e) => setText(e.target.value.slice(0, CHAT_MESSAGE_MAX))}
                  placeholder="Message everyone as the host (links are clickable)"
                  rows={2}
                  aria-label="Host message"
                />
                <div className="flex flex-wrap items-center gap-2">
                  {data.handouts.length > 0 && (
                    <select
                      value={handoutId}
                      onChange={(e) => setHandoutId(e.target.value)}
                      aria-label="Share a handout"
                      className="h-9 rounded-md border bg-background px-2 text-sm"
                    >
                      <option value="">No handout</option>
                      {data.handouts.map((h) => (
                        <option key={h.id} value={h.id}>
                          Share: {h.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <Button size="sm" className="ml-auto gap-1.5" onClick={() => void send()} disabled={!text.trim() || act.isPending}>
                    <Send className="h-4 w-4" /> Send as host
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Settings</CardTitle>
            <CardDescription>
              Chat can be on only with a moderator named, so it is never live with nobody watching it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-md border p-3 text-sm">
              <p className="font-medium">Moderator</p>
              <p className="text-muted-foreground">
                {data.moderator ? `${data.moderator.name}${data.moderator.isMe ? " (you)" : ""}` : "Nobody named yet"}
              </p>
              {canManage && !data.moderator?.isMe && (
                <Button size="sm" variant="outline" className="mt-2" onClick={() => void change({ moderator: "me" }, "You are the moderator")}>
                  Make me the moderator
                </Button>
              )}
            </div>
            <SettingRow
              id="chat-enabled"
              title="Chat on"
              hint={data.moderator ? "Attendees can read and post while the room is open." : "Switching it on makes you the moderator."}
              checked={live}
              disabled={!canManage || update.isPending}
              onChange={(next) =>
                void change(next && !data.moderator ? { enabled: true, moderator: "me" } : { enabled: next }, next ? "Chat is on" : "Chat is off")
              }
            />
            <SettingRow
              id="chat-lobby"
              title="Open in the waiting room"
              hint="Attendees can chat before you open the room."
              checked={chat.openInLobby === true}
              disabled={!canManage || update.isPending}
              onChange={(next) => void change({ openInLobby: next }, next ? "Chat opens in the waiting room" : "Chat opens with the room")}
            />
            <SettingRow
              id="chat-muted-all"
              title="Mute everyone"
              hint="Attendees can read but not post. Hosts still can."
              checked={chat.mutedAll === true}
              disabled={!canManage || update.isPending}
              onChange={(next) => void change({ mutedAll: next }, next ? "Attendees are muted" : "Attendees can post again")}
            />
            <SettingRow
              id="chat-slow"
              title="Slow mode"
              hint="One message per person every 15 seconds."
              checked={chat.slowMode === true}
              disabled={!canManage || update.isPending}
              onChange={(next) => void change({ slowMode: next }, next ? "Slow mode on" : "Slow mode off")}
            />
            {canExport && (
              <Button asChild variant="outline" size="sm" className="w-full gap-1.5">
                <a href={`/api/events/${eventId}/webinar/chat?export=csv`}>
                  <Download className="h-4 w-4" /> Download the chat (CSV)
                </a>
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Muted people</CardTitle>
            <CardDescription>Muted for this webinar. They can still read.</CardDescription>
          </CardHeader>
          <CardContent>
            {data.muted.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nobody is muted.</p>
            ) : (
              <ul className="space-y-1">
                {data.muted.map((p) => (
                  <li key={p.registrationId} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate">{p.name}</span>
                    {canManage && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1"
                        onClick={() => void run({ action: "unmute", registrationId: p.registrationId }, `${p.name} can post again`)}
                      >
                        <Volume2 className="h-3.5 w-3.5" /> Unmute
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function FeedLine({
  m,
  canManage,
  busy,
  onAct,
}: {
  m: WebinarChatConsoleMessage;
  canManage: boolean;
  busy: boolean;
  onAct: (body: WebinarChatAction, done: string) => Promise<boolean>;
}) {
  const staff = m.authorKind === "staff";
  return (
    <li className={`group rounded-md px-2 py-1.5 text-sm ${m.pinned ? "bg-primary/5" : ""} ${m.deleted ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{m.authorName}</span>
        {staff && <Badge variant="secondary" className="h-4 px-1 text-[10px]">Host</Badge>}
        {m.anonymous && <Badge variant="outline" className="h-4 px-1 text-[10px]">Shown as Attendee</Badge>}
        {m.authorMuted && <Badge variant="outline" className="h-4 px-1 text-[10px] text-amber-700">Muted</Badge>}
        {m.pinned && <Badge className="h-4 px-1 text-[10px]">Pinned</Badge>}
        {m.deleted && <Badge variant="destructive" className="h-4 px-1 text-[10px]">Deleted</Badge>}
        <span className="ml-auto text-[11px] text-muted-foreground">{timeLabel(m.createdAt)}</span>
      </div>
      <p className={`whitespace-pre-wrap break-words ${m.deleted ? "line-through" : ""}`}>{m.body}</p>
      {m.kind === "handout" && (
        <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
          <FileText className="h-3.5 w-3.5" /> {m.handoutName ?? "Handout no longer attached"}
        </p>
      )}
      {canManage && (
        <div className="mt-1 flex flex-wrap gap-1">
          {m.deleted ? (
            <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" disabled={busy} onClick={() => void onAct({ action: "restore", messageId: m.id }, "Message restored")}>
              <RotateCcw className="h-3.5 w-3.5" /> Restore
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-xs"
                disabled={busy}
                onClick={() => void onAct(m.pinned ? { action: "unpin" } : { action: "pin", messageId: m.id }, m.pinned ? "Unpinned" : "Pinned for everyone")}
              >
                {m.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />} {m.pinned ? "Unpin" : "Pin"}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs text-destructive" disabled={busy} onClick={() => void onAct({ action: "delete", messageId: m.id }, "Message deleted")}>
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </Button>
            </>
          )}
          {m.registrationId && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-xs"
              disabled={busy}
              onClick={() =>
                void onAct(
                  { action: m.authorMuted ? "unmute" : "mute", registrationId: m.registrationId! },
                  m.authorMuted ? `${m.authorName} can post again` : `${m.authorName} is muted`,
                )
              }
            >
              {m.authorMuted ? <Volume2 className="h-3.5 w-3.5" /> : <UserX className="h-3.5 w-3.5" />} {m.authorMuted ? "Unmute" : "Mute"}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
