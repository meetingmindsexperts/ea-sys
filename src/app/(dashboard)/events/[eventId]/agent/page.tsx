"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Wrench,
  Check,
  AlertCircle,
  Send,
  Square,
  Trash2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

type ChatMessage =
  | { id: string; role: "user"; content: string }
  | { id: string; role: "assistant"; content: string; isStreaming?: boolean }
  | { id: string; role: "tool_start"; name: string; input: unknown; toolUseId: string }
  | { id: string; role: "tool_result"; name: string; result: unknown; toolUseId: string }
  | { id: string; role: "error"; message: string };

type ApiMessage = { role: "user" | "assistant"; content: string };

type SSEEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; name: string; input: unknown; toolUseId: string }
  | { type: "tool_result"; name: string; result: unknown; toolUseId: string }
  | { type: "done" }
  | { type: "error"; message: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  list_event_info: "Getting event info",
  list_tracks: "Listing tracks",
  create_track: "Creating track",
  list_speakers: "Listing speakers",
  create_speaker: "Creating speaker",
  list_registrations: "Listing registrations",
  list_sessions: "Listing sessions",
  create_session: "Creating session",
  list_ticket_types: "Listing ticket types",
  create_ticket_type: "Creating ticket type",
  create_registration: "Creating registration",
  send_bulk_email: "Sending bulk email",
};

function getToolLabel(name: string) {
  return TOOL_LABELS[name] ?? name.replace(/_/g, " ");
}

function getToolResultSummary(name: string, result: unknown): string {
  if (!result || typeof result !== "object") return "Completed";
  const r = result as Record<string, unknown>;

  if ("error" in r) return `Error: ${r.error}`;

  if (name === "create_track" && r.track)
    return `Created track "${(r.track as { name: string }).name}"`;
  if (name === "create_speaker" && r.speaker) {
    const s = r.speaker as { firstName: string; lastName: string };
    return `Created speaker ${s.firstName} ${s.lastName}`;
  }
  if (name === "create_session" && r.session)
    return `Created session "${(r.session as { name: string }).name}"`;
  if (name === "list_tracks" && Array.isArray(r.tracks))
    return `Found ${r.tracks.length} track${r.tracks.length !== 1 ? "s" : ""}`;
  if (name === "list_speakers" && Array.isArray(r.speakers))
    return `Found ${r.speakers.length} speaker${r.speakers.length !== 1 ? "s" : ""}`;
  if (name === "list_registrations" && Array.isArray(r.registrations))
    return `Found ${r.registrations.length} registration${r.registrations.length !== 1 ? "s" : ""}`;
  if (name === "list_sessions" && Array.isArray(r.sessions))
    return `Found ${r.sessions.length} session${r.sessions.length !== 1 ? "s" : ""}`;
  if (name === "list_ticket_types" && Array.isArray(r.ticketTypes))
    return `Found ${r.ticketTypes.length} ticket type${r.ticketTypes.length !== 1 ? "s" : ""}`;
  if (name === "create_ticket_type" && r.ticketType) {
    if (r.alreadyExists)
      return `Ticket type "${(r.ticketType as { name: string }).name}" already exists`;
    return `Created ticket type "${(r.ticketType as { name: string }).name}" with Early Bird, Standard, Onsite tiers`;
  }
  if (name === "create_registration") {
    if (r.alreadyExists) return String(r.message ?? "Registration already exists");
    if (r.attendee) {
      const a = r.attendee as { firstName: string; lastName: string };
      return `Created registration for ${a.firstName} ${a.lastName}`;
    }
  }
  if (name === "send_bulk_email" && r.sent !== undefined)
    return `Sent to ${r.sent} recipient${(r.sent as number) !== 1 ? "s" : ""}`;
  if (name === "list_event_info" && r.name) return `Fetched event "${r.name}"`;

  return "Completed";
}

const SUGGESTED_COMMANDS = [
  "What's the current status and stats of this event?",
  "Create 3 conference tracks: Keynote, Technical, Workshop",
  "Create a ticket type called 'Standard Delegate'",
  "List all confirmed registrations",
  "List all speakers and their status",
  "List all sessions",
];

// ─── localStorage helpers ─────────────────────────────────────────────────────

function storageKey(eventId: string) {
  return `agent-session-${eventId}`;
}

function loadMessages(eventId: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(storageKey(eventId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatMessage[];
    return parsed.map((m) =>
      m.role === "assistant" ? { ...m, isStreaming: false } : m
    );
  } catch {
    return [];
  }
}

// ─── ToolChip ─────────────────────────────────────────────────────────────────

function ToolChip({
  name,
  input,
  result,
  isDone,
}: {
  name: string;
  input: unknown;
  result?: unknown;
  isDone: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const label = getToolLabel(name);
  const summary = isDone && result !== undefined ? getToolResultSummary(name, result) : null;
  const isError = isDone && result && typeof result === "object" && "error" in result;

  return (
    <div className="my-1 max-w-full">
      <button
        onClick={() => setExpanded((p) => !p)}
        className={cn(
          "flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border transition-colors max-w-full",
          isDone
            ? isError
              ? "bg-red-50 border-red-200 text-red-700"
              : "bg-green-50 border-green-200 text-green-700"
            : "bg-blue-50 border-blue-200 text-blue-700 animate-pulse"
        )}
      >
        {isDone ? (
          isError ? <AlertCircle className="h-3 w-3 shrink-0" /> : <Check className="h-3 w-3 shrink-0" />
        ) : (
          <Wrench className="h-3 w-3 shrink-0" />
        )}
        <span className="truncate">{isDone ? (summary ?? label) : label + "…"}</span>
        {expanded ? (
          <ChevronDown className="h-3 w-3 ml-1 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 ml-1 shrink-0" />
        )}
      </button>
      {expanded && (
        <div className="mt-1 ml-2 p-2 bg-muted rounded text-xs font-mono overflow-auto max-h-48 w-full">
          <div className="text-muted-foreground mb-1">Input:</div>
          <pre className="whitespace-pre-wrap break-all">{JSON.stringify(input, null, 2)}</pre>
          {isDone && result !== undefined && (
            <>
              <div className="text-muted-foreground mt-2 mb-1">Result:</div>
              <pre className="whitespace-pre-wrap break-all">{JSON.stringify(result, null, 2)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── MessageBubble ────────────────────────────────────────────────────────────

function MessageBubble({
  message,
  pendingTools,
}: {
  message: ChatMessage;
  pendingTools: Map<string, { name: string; input: unknown }>;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end mb-3">
        <div className="max-w-[80%] bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm whitespace-pre-wrap break-words">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.role === "assistant") {
    return (
      <div className="flex justify-start mb-3">
        <div className="max-w-[85%] bg-card border rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm shadow-sm">
          {!message.content && message.isStreaming ? (
            <span className="text-muted-foreground italic">Thinking…</span>
          ) : (
            <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-headings:mt-3 prose-headings:mb-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-code:bg-muted prose-code:px-1 prose-code:rounded prose-code:text-xs prose-pre:bg-muted prose-pre:p-2 prose-pre:rounded prose-pre:text-xs prose-blockquote:border-l-2 prose-blockquote:pl-3 prose-blockquote:text-muted-foreground prose-hr:my-2 prose-table:text-xs">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {message.content}
              </ReactMarkdown>
              {message.isStreaming && (
                <span className="inline-block w-0.5 h-3.5 bg-foreground ml-0.5 animate-pulse align-middle" />
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (message.role === "tool_result") {
    const pending = pendingTools.get(message.toolUseId);
    return (
      <div className="flex justify-start mb-1">
        <ToolChip
          name={message.name}
          input={pending?.input ?? {}}
          result={message.result}
          isDone={true}
        />
      </div>
    );
  }

  if (message.role === "error") {
    return (
      <div className="flex justify-start mb-3">
        <div className="flex items-start gap-2 max-w-[85%] bg-destructive/10 border border-destructive/20 text-destructive rounded-xl px-4 py-2.5 text-sm break-words">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{message.message}</span>
        </div>
      </div>
    );
  }

  return null;
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AgentPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Plain div ref — ScrollArea's viewport isn't reachable via ref on the wrapper
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingToolsRef = useRef<Map<string, { name: string; input: unknown }>>(new Map());
  // Debounce localStorage writes — avoid writing on every streaming token
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load persisted messages on mount
  useEffect(() => {
    setMessages(loadMessages(eventId));
  }, [eventId]);

  // Debounced save to localStorage (500ms after last change)
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      try {
        if (messages.length > 0) {
          localStorage.setItem(storageKey(eventId), JSON.stringify(messages));
        }
      } catch {
        // Quota exceeded — silently ignore
      }
    }, 500);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [eventId, messages]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function buildHistory(): ApiMessage[] {
    return messages
      .filter(
        (m): m is Extract<ChatMessage, { role: "user" | "assistant" }> =>
          (m.role === "user" || m.role === "assistant") && !!m.content
      )
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
      .slice(-40);
  }

  const handleSSEEvent = useCallback((data: SSEEvent, assistantId: string) => {
    switch (data.type) {
      case "text_delta":
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId && m.role === "assistant"
              ? { ...m, content: m.content + data.text }
              : m
          )
        );
        break;

      case "tool_start":
        pendingToolsRef.current.set(data.toolUseId, {
          name: data.name,
          input: data.input,
        });
        // tool_start messages are not shown directly — only tool_result chips render
        break;

      case "tool_result":
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "tool_result",
            name: data.name,
            result: data.result,
            toolUseId: data.toolUseId,
          },
        ]);
        break;

      case "error":
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: "error", message: data.message },
        ]);
        break;

      case "done":
        break;
    }
  }, []);

  async function sendMessage(userMessage: string) {
    if (!userMessage.trim() || isRunning) return;

    const ac = new AbortController();
    abortRef.current = ac;
    setIsRunning(true);
    pendingToolsRef.current = new Map();

    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();

    // Snapshot history before adding new messages
    const history = buildHistory();

    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", content: userMessage },
      { id: assistantId, role: "assistant", content: "", isStreaming: true },
    ]);
    setInput("");

    try {
      const res = await fetch(`/api/events/${eventId}/agent/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage, history }),
        signal: ac.signal,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: "Request failed" }));
        // Remove the empty assistant placeholder and show error instead
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== assistantId),
          { id: crypto.randomUUID(), role: "error", message: errBody.error ?? "Request failed" },
        ]);
        return;
      }

      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            handleSSEEvent(JSON.parse(line.slice(6)) as SSEEvent, assistantId);
          } catch {
            // Skip malformed SSE line
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== assistantId),
        { id: crypto.randomUUID(), role: "error", message: "Connection error. Please try again." },
      ]);
    } finally {
      setIsRunning(false);
      abortRef.current = null;
      // Mark streaming done; remove bubble entirely if it ended up empty
      setMessages((prev) =>
        prev
          .map((m) =>
            m.id === assistantId && m.role === "assistant"
              ? { ...m, isStreaming: false }
              : m
          )
          .filter((m) => !(m.id === assistantId && m.role === "assistant" && !m.content))
      );
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  function clearSession() {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    localStorage.removeItem(storageKey(eventId));
    setMessages([]);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  }

  // Precompute set of completed tool IDs — avoids O(n²) inside render
  const completedToolIds = new Set(
    messages.filter((m) => m.role === "tool_result").map((m) => (m as Extract<ChatMessage, { role: "tool_result" }>).toolUseId)
  );
  const pendingTools = pendingToolsRef.current;

  return (
    // h-full fills the dashboard <main> (flex-1 overflow-auto)
    <div className="flex flex-col h-full gap-6">
      {/* Header */}
      <div className="flex items-start justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Bot className="h-8 w-8" />
            AI Agent
          </h1>
          <p className="text-muted-foreground mt-1">
            Describe what you need — the agent will handle it.
          </p>
        </div>
        {messages.length > 0 && !isRunning && (
          <Button
            variant="outline"
            size="sm"
            onClick={clearSession}
            className="text-muted-foreground shrink-0"
          >
            <Trash2 className="h-4 w-4 mr-1.5" />
            Clear session
          </Button>
        )}
      </div>

      {/* Body — fills remaining height */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-6 flex-1 min-h-0">

        {/* Chat card */}
        <Card className="flex flex-col min-h-0 overflow-hidden">
          {/* Status bar */}
          <CardHeader className="py-3 px-4 border-b shrink-0">
            <CardTitle className="text-sm font-medium">
              {isRunning ? (
                <span className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                  Agent running…
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
                  Ready
                </span>
              )}
            </CardTitle>
          </CardHeader>

          {/* Message list — plain div, not ScrollArea, so ref works */}
          <div
            ref={scrollRef}
            className="flex-1 min-h-0 overflow-y-auto px-4 py-4"
          >
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full py-16 text-center text-muted-foreground">
                <Bot className="h-12 w-12 mb-3 opacity-20" />
                <p className="text-sm">
                  Ask me anything about this event, or use a suggested command.
                </p>
              </div>
            )}
            {messages.map((msg) => {
              // Skip tool_start if the result already arrived (show only the result chip)
              if (msg.role === "tool_start" && completedToolIds.has(msg.toolUseId)) {
                return null;
              }
              // Render pending tool_start as a chip
              if (msg.role === "tool_start") {
                return (
                  <div key={msg.id} className="flex justify-start mb-1">
                    <ToolChip name={msg.name} input={msg.input} isDone={false} />
                  </div>
                );
              }
              return (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  pendingTools={pendingTools}
                />
              );
            })}
          </div>

          {/* Input area */}
          <div className="border-t p-4 shrink-0">
            <div className="flex gap-2 items-end">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a command… (Enter to send, Shift+Enter for newline)"
                rows={2}
                className="resize-none flex-1 min-w-0"
                disabled={isRunning}
                maxLength={2000}
              />
              {isRunning ? (
                <Button
                  variant="destructive"
                  size="icon"
                  onClick={handleStop}
                  title="Stop agent"
                  className="shrink-0"
                >
                  <Square className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  size="icon"
                  onClick={() => sendMessage(input)}
                  disabled={!input.trim()}
                  title="Send"
                  className="shrink-0"
                >
                  <Send className="h-4 w-4" />
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1.5">
              Shift+Enter for newline · Enter to send
            </p>
          </div>
        </Card>

        {/* Sidebar */}
        <div className="space-y-4 overflow-y-auto">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                Suggested Commands
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 pt-0">
              {SUGGESTED_COMMANDS.map((cmd) => (
                <button
                  key={cmd}
                  onClick={() => setInput(cmd)}
                  disabled={isRunning}
                  className={cn(
                    "w-full text-left text-sm px-3 py-2 rounded-lg border transition-colors",
                    "hover:bg-muted hover:border-muted-foreground/20",
                    "disabled:opacity-40 disabled:cursor-not-allowed",
                    "text-foreground/80"
                  )}
                >
                  {cmd}
                </button>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                Capabilities
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <ul className="text-xs text-muted-foreground space-y-1">
                <li>✓ List &amp; create tracks</li>
                <li>✓ List &amp; create speakers</li>
                <li>✓ List &amp; create sessions</li>
                <li>✓ List &amp; create registrations</li>
                <li>✓ List &amp; create ticket types</li>
                <li>✓ Send bulk emails</li>
                <li>✗ Cannot delete records</li>
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
