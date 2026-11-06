"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Loader2, MessagesSquare, Pin, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  CHAT_MESSAGE_MAX,
  CHAT_POLL_MS,
  CHAT_WINDOW,
  splitLinks,
  type ChatMessageView,
  type ChatPhase,
} from "@/lib/webinar/chat";

/** While chat is off, look again now and then: a producer may switch it on mid-webinar. */
const OFF_POLL_MS = 30_000;

interface ChatState {
  enabled: boolean;
  phase: ChatPhase;
  canPost: boolean;
  postBlockedBy: string | null;
  intervalSeconds: number;
  postAs: string;
  canPostAnonymously: boolean;
}

interface ChatResponse extends Partial<ChatState> {
  messages?: ChatMessageView[];
  removed?: string[];
  reset?: boolean;
  pinned?: ChatMessageView | null;
}

const BLOCKED_LINE: Record<string, string> = {
  muted: "The moderator has muted you in this chat.",
  "muted-all": "The moderator has paused chat. You can still read it.",
  readonly: "The webinar has ended. Chat is read-only.",
  closed: "Chat opens when the session starts.",
};

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Staff links are clickable; an attendee's text is always plain (owner, Nov 6, 2026). */
function MessageBody({ m }: { m: ChatMessageView }) {
  if (m.authorKind !== "staff") return <>{m.body}</>;
  return (
    <>
      {splitLinks(m.body).map((part, i) =>
        part.href ? (
          <a key={i} href={part.href} target="_blank" rel="noopener noreferrer" className="break-all text-primary underline">
            {part.text}
          </a>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

function HandoutLink({ slug, sessionId, handout }: { slug: string; sessionId: string; handout: { id: string; name: string } }) {
  const href = `/api/public/events/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/handouts/${encodeURIComponent(handout.id)}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      className="mt-1 flex items-center gap-2 rounded-md border bg-background p-2 text-sm hover:bg-muted"
    >
      <FileText className="h-4 w-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate font-medium" title={handout.name}>
        {handout.name}
      </span>
      <span className="text-xs text-primary">Download</span>
    </a>
  );
}

function ChatLine({ m, slug, sessionId }: { m: ChatMessageView; slug: string; sessionId: string }) {
  const staff = m.authorKind === "staff";
  return (
    <li className={`rounded-md px-2 py-1.5 text-sm ${staff ? "bg-primary/5" : ""}`}>
      <div className="flex items-baseline gap-2">
        <span className="truncate font-medium">{m.mine ? "You" : m.author}</span>
        {staff && <span className="rounded bg-primary/10 px-1 text-[10px] font-semibold uppercase text-primary">Host</span>}
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{timeLabel(m.createdAt)}</span>
      </div>
      <p className="whitespace-pre-wrap break-words text-foreground/90">
        <MessageBody m={m} />
      </p>
      {m.kind === "handout" && m.handout && <HandoutLink slug={slug} sessionId={sessionId} handout={m.handout} />}
    </li>
  );
}

/**
 * Attendee chat beside the stream (Nov 6, 2026; docs/WEBINAR_INTERACTION_PLAN.md §6). Asks for new
 * messages every 3 s (not while the tab is hidden), sending the newest id it holds so the route
 * returns only what is new. Renders nothing while chat is off; tells the parent when that changes.
 */
export function ChatPanel({
  slug,
  sessionId,
  onEnabledChange,
  onNewMessage,
}: {
  slug: string;
  sessionId: string;
  onEnabledChange?: (enabled: boolean) => void;
  /** Called when messages from someone else arrive, for an unread dot. */
  onNewMessage?: () => void;
}) {
  const base = `/api/public/events/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/chat`;
  const [state, setState] = useState<ChatState | null>(null);
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [pinned, setPinned] = useState<ChatMessageView | null>(null);
  const [text, setText] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [, setTick] = useState(0);
  const lastIdRef = useRef<string | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const stickToBottom = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enabledRef = useRef<boolean | null>(null);
  const callbacks = useRef({ onEnabledChange, onNewMessage });
  callbacks.current = { onEnabledChange, onNewMessage };

  const load = useCallback(async (): Promise<number> => {
    try {
      const url = lastIdRef.current ? `${base}?after=${encodeURIComponent(lastIdRef.current)}` : base;
      const res = await fetch(url, { cache: "no-store" });
      if (res.status === 429) return (Number(res.headers.get("Retry-After")) || 30) * 1000;
      if (!res.ok) {
        console.warn("webinar-chat:load-failed", res.status);
        return OFF_POLL_MS;
      }
      const data = (await res.json()) as ChatResponse;
      const enabled = data.enabled === true;
      if (enabledRef.current !== enabled) {
        enabledRef.current = enabled;
        callbacks.current.onEnabledChange?.(enabled);
      }
      if (!enabled) {
        setState(null);
        return OFF_POLL_MS;
      }
      setState({
        enabled,
        phase: data.phase ?? "closed",
        canPost: data.canPost === true,
        postBlockedBy: data.postBlockedBy ?? null,
        intervalSeconds: data.intervalSeconds ?? 3,
        postAs: data.postAs ?? "",
        canPostAnonymously: data.canPostAnonymously === true,
      });
      setPinned(data.pinned ?? null);
      const incoming = data.messages ?? [];
      const removed = new Set(data.removed ?? []);
      setMessages((prev) => {
        const base = data.reset ? [] : prev.filter((m) => !removed.has(m.id));
        const seen = new Set(base.map((m) => m.id));
        return [...base, ...incoming.filter((m) => !seen.has(m.id))].slice(-CHAT_WINDOW);
      });
      if (incoming.length > 0) {
        lastIdRef.current = incoming[incoming.length - 1].id;
        if (incoming.some((m) => !m.mine)) callbacks.current.onNewMessage?.();
      } else if (data.reset) {
        lastIdRef.current = null;
      }
      return CHAT_POLL_MS;
    } catch (err) {
      console.warn("webinar-chat:load-failed", err);
      return CHAT_POLL_MS * 2;
    }
  }, [base]);

  // The poll loop: one request at a time, paused while the tab is hidden.
  useEffect(() => {
    let stopped = false;
    const run = async () => {
      if (stopped) return;
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      const next = hidden ? CHAT_POLL_MS : await load();
      if (!stopped) timerRef.current = setTimeout(run, next);
    };
    void run();
    return () => {
      stopped = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [load]);

  // Keep the newest message in view unless the reader scrolled up.
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Repaint once a second while the send cooldown runs.
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  const send = async () => {
    const body = text.trim();
    if (!body || !state) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, anonymous: state.canPostAnonymously && anonymous }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; retryAfterSeconds?: number };
      if (res.status === 429) {
        setCooldownUntil(Date.now() + (data.retryAfterSeconds ?? state.intervalSeconds) * 1000);
        setError("You are sending messages too quickly.");
        return;
      }
      if (!res.ok) {
        setError(data.error || "Your message could not be sent. Please try again.");
        void load();
        return;
      }
      setText("");
      stickToBottom.current = true;
      setCooldownUntil(Date.now() + state.intervalSeconds * 1000);
      void load();
    } catch (err) {
      console.warn("webinar-chat:send-failed", err);
      setError("Your message could not be sent. Please check your connection.");
    } finally {
      setSending(false);
    }
  };

  if (!state) return null;

  const waitS = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
  const blockedLine = state.canPost ? null : BLOCKED_LINE[state.postBlockedBy ?? ""] ?? null;

  return (
    <Card className="flex h-[450px] flex-col gap-0 py-3">
      <CardContent className="flex min-h-0 flex-1 flex-col gap-2 px-3 py-1">
        <div className="flex items-center gap-2">
          <MessagesSquare className="h-4 w-4 text-primary" />
          <p className="font-medium">Chat</p>
        </div>
        {pinned && (
          <div className="rounded-md border border-primary/30 bg-primary/5 p-2 text-sm">
            <div className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold uppercase text-primary">
              <Pin className="h-3 w-3" /> Pinned
            </div>
            <p className="whitespace-pre-wrap break-words">
              <MessageBody m={pinned} />
            </p>
            {pinned.kind === "handout" && pinned.handout && <HandoutLink slug={slug} sessionId={sessionId} handout={pinned.handout} />}
          </div>
        )}
        <ul
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
          className="min-h-0 flex-1 space-y-1 overflow-y-auto"
          aria-live="polite"
        >
          {messages.length === 0 ? (
            <li className="py-6 text-center text-sm text-muted-foreground">No messages yet. Say hello.</li>
          ) : (
            messages.map((m) => <ChatLine key={m.id} m={m} slug={slug} sessionId={sessionId} />)
          )}
        </ul>
        {blockedLine ? (
          <p className="rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">{blockedLine}</p>
        ) : (
          <div className="space-y-2">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, CHAT_MESSAGE_MAX))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (!sending && waitS === 0) void send();
                }
              }}
              placeholder="Write a message"
              rows={2}
              aria-label="Chat message"
              className="resize-none"
            />
            <div className="flex items-center gap-2">
              {state.canPostAnonymously ? (
                <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
                  <Switch checked={anonymous} onCheckedChange={setAnonymous} aria-label="Post anonymously" />
                  <span className="truncate">{anonymous ? "Posting anonymously" : `Posting as ${state.postAs}`}</span>
                </label>
              ) : (
                <span className="flex-1 truncate text-xs text-muted-foreground">Posting as {state.postAs} (host)</span>
              )}
              <Button size="sm" onClick={() => void send()} disabled={sending || !text.trim() || waitS > 0} className="gap-1.5">
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {waitS > 0 ? `${waitS}s` : "Send"}
              </Button>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
