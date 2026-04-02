"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Bot, ChevronDown, ChevronRight, Wrench, Check, AlertCircle, Send, Square, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
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
  send_bulk_email: "Sending bulk email",
};

function getToolLabel(name: string) {
  return TOOL_LABELS[name] ?? name.replace(/_/g, " ");
}

function getToolResultSummary(name: string, result: unknown): string {
  if (result && typeof result === "object" && "error" in result) {
    return `Error: ${(result as { error: string }).error}`;
  }
  const r = result as Record<string, unknown>;
  if (name === "create_track" && r.track) {
    const t = r.track as { name: string };
    return `Created track "${t.name}"`;
  }
  if (name === "create_speaker" && r.speaker) {
    const s = r.speaker as { firstName: string; lastName: string };
    return `Created speaker ${s.firstName} ${s.lastName}`;
  }
  if (name === "create_session" && r.session) {
    const s = r.session as { name: string };
    return `Created session "${s.name}"`;
  }
  if (name === "list_tracks" && Array.isArray(r.tracks)) {
    return `Found ${r.tracks.length} track${r.tracks.length !== 1 ? "s" : ""}`;
  }
  if (name === "list_speakers" && Array.isArray(r.speakers)) {
    return `Found ${r.speakers.length} speaker${r.speakers.length !== 1 ? "s" : ""}`;
  }
  if (name === "list_registrations" && Array.isArray(r.registrations)) {
    return `Found ${r.registrations.length} registration${r.registrations.length !== 1 ? "s" : ""}`;
  }
  if (name === "list_sessions" && Array.isArray(r.sessions)) {
    return `Found ${r.sessions.length} session${r.sessions.length !== 1 ? "s" : ""}`;
  }
  if (name === "list_ticket_types" && Array.isArray(r.ticketTypes)) {
    return `Found ${r.ticketTypes.length} ticket type${r.ticketTypes.length !== 1 ? "s" : ""}`;
  }
  if (name === "send_bulk_email" && r.sent !== undefined) {
    return `Sent to ${r.sent} recipient${(r.sent as number) !== 1 ? "s" : ""}`;
  }
  if (name === "list_event_info" && r.name) {
    return `Fetched event "${r.name}"`;
  }
  return "Completed";
}

const SUGGESTED_COMMANDS = [
  "What's the current status and stats of this event?",
  "Create 3 conference tracks: Keynote, Technical, Workshop",
  "List all confirmed registrations",
  "List all speakers and their status",
  "List all ticket types",
  "List all sessions",
];

// ─── Sub-components ───────────────────────────────────────────────────────────

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
  const isError =
    isDone &&
    result &&
    typeof result === "object" &&
    "error" in result;

  return (
    <div className="my-1">
      <button
        onClick={() => setExpanded((p) => !p)}
        className={cn(
          "flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border transition-colors",
          isDone
            ? isError
              ? "bg-red-50 border-red-200 text-red-700"
              : "bg-green-50 border-green-200 text-green-700"
            : "bg-blue-50 border-blue-200 text-blue-700 animate-pulse"
        )}
      >
        {isDone ? (
          isError ? (
            <AlertCircle className="h-3 w-3" />
          ) : (
            <Check className="h-3 w-3" />
          )
        ) : (
          <Wrench className="h-3 w-3" />
        )}
        <span>{isDone ? (summary ?? label) : label + "…"}</span>
        {expanded ? (
          <ChevronDown className="h-3 w-3 ml-1" />
        ) : (
          <ChevronRight className="h-3 w-3 ml-1" />
        )}
      </button>
      {expanded && (
        <div className="mt-1 ml-2 p-2 bg-muted rounded text-xs font-mono overflow-auto max-h-48 max-w-full">
          <div className="text-muted-foreground mb-1">Input:</div>
          <pre>{JSON.stringify(input, null, 2)}</pre>
          {isDone && result !== undefined && (
            <>
              <div className="text-muted-foreground mt-2 mb-1">Result:</div>
              <pre>{JSON.stringify(result, null, 2)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MessageBubble({
  message,
  pendingTools,
}: {
  message: ChatMessage;
  pendingTools: Map<string, { name: string; input: unknown }>;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end mb-4">
        <div className="max-w-[80%] bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.role === "assistant") {
    return (
      <div className="flex justify-start mb-4">
        <div className="max-w-[85%] bg-card border rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm whitespace-pre-wrap shadow-sm">
          {message.content}
          {message.isStreaming && (
            <span className="inline-block w-0.5 h-3.5 bg-foreground ml-0.5 animate-pulse align-middle" />
          )}
          {!message.content && message.isStreaming && (
            <span className="text-muted-foreground italic">Thinking…</span>
          )}
        </div>
      </div>
    );
  }

  if (message.role === "tool_start") {
    // Shown as pending until tool_result arrives
    return (
      <div className="flex justify-start mb-1">
        <ToolChip
          name={message.name}
          input={message.input}
          isDone={false}
        />
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
      <div className="flex justify-start mb-4">
        <div className="flex items-start gap-2 max-w-[85%] bg-destructive/10 border border-destructive/20 text-destructive rounded-xl px-4 py-2.5 text-sm">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{message.message}</span>
        </div>
      </div>
    );
  }

  return null;
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function storageKey(eventId: string) {
  return `agent-session-${eventId}`;
}

function loadMessages(eventId: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(storageKey(eventId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatMessage[];
    // Strip streaming flags on load (page was closed mid-stream)
    return parsed.map((m) =>
      m.role === "assistant" ? { ...m, isStreaming: false } : m
    );
  } catch {
    return [];
  }
}

function saveMessages(eventId: string, messages: ChatMessage[]) {
  try {
    localStorage.setItem(storageKey(eventId), JSON.stringify(messages));
  } catch {
    // Ignore storage quota errors
  }
}

export default function AgentPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Track tool_start inputs so tool_result can show them
  const pendingToolsRef = useRef<Map<string, { name: string; input: unknown }>>(new Map());

  // Load persisted messages on mount
  useEffect(() => {
    setMessages(loadMessages(eventId));
  }, [eventId]);

  // Persist messages to localStorage whenever they change
  useEffect(() => {
    if (messages.length > 0) {
      saveMessages(eventId, messages);
    }
  }, [eventId, messages]);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [messages]);

  function buildHistory(): ApiMessage[] {
    return messages
      .filter(
        (m): m is Extract<ChatMessage, { role: "user" | "assistant" }> =>
          (m.role === "user" || m.role === "assistant") && !!m.content
      )
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
      .slice(-40); // last 20 pairs
  }

  function handleSSEEvent(data: SSEEvent, assistantId: string) {
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
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "tool_start",
            name: data.name,
            input: data.input,
            toolUseId: data.toolUseId,
          },
        ]);
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
          {
            id: crypto.randomUUID(),
            role: "error",
            message: data.message,
          },
        ]);
        break;

      case "done":
        break;
    }
  }

  async function sendMessage(userMessage: string) {
    if (!userMessage.trim() || isRunning) return;

    const ac = new AbortController();
    abortRef.current = ac;
    setIsRunning(true);
    pendingToolsRef.current = new Map();

    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();

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
        body: JSON.stringify({
          message: userMessage,
          history: buildHistory(),
        }),
        signal: ac.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Request failed" }));
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "error",
            message: err.error ?? "Request failed",
          },
        ]);
        return;
      }

      if (!res.body) {
        throw new Error("No response body");
      }

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
            const data = JSON.parse(line.slice(6)) as SSEEvent;
            handleSSEEvent(data, assistantId);
          } catch {
            // Skip malformed lines
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "error",
          message: "Connection error. Please try again.",
        },
      ]);
    } finally {
      setIsRunning(false);
      abortRef.current = null;
      // Mark assistant message done
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId && m.role === "assistant"
            ? { ...m, isStreaming: false }
            : m
        )
      );
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  function clearSession() {
    localStorage.removeItem(storageKey(eventId));
    setMessages([]);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  }

  // Snapshot pending tools for rendering (avoids ref in render)
  const pendingTools = pendingToolsRef.current;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
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
            className="text-muted-foreground"
          >
            <Trash2 className="h-4 w-4 mr-1.5" />
            Clear session
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-6 items-start">
        {/* Chat area */}
        <Card className="flex flex-col" style={{ height: "calc(100vh - 220px)" }}>
          <CardHeader className="pb-3 border-b shrink-0">
            <CardTitle className="text-base font-medium">
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

          {/* Message list */}
          <ScrollArea className="flex-1 px-4 py-4" ref={scrollRef}>
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full py-16 text-center text-muted-foreground">
                <Bot className="h-12 w-12 mb-3 opacity-20" />
                <p className="text-sm">
                  Ask me anything about this event, or use a suggested command.
                </p>
              </div>
            )}
            {messages.map((msg) => {
              // Hide tool_start messages that already have a matching tool_result
              if (msg.role === "tool_start") {
                const hasResult = messages.some(
                  (m) => m.role === "tool_result" && m.toolUseId === msg.toolUseId
                );
                if (hasResult) return null;
              }
              return (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  pendingTools={pendingTools}
                />
              );
            })}
          </ScrollArea>

          {/* Input area */}
          <div className="border-t p-4 shrink-0">
            <div className="flex gap-2 items-end">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a command… (Enter to send, Shift+Enter for newline)"
                rows={2}
                className="resize-none flex-1"
                disabled={isRunning}
                maxLength={2000}
              />
              {isRunning ? (
                <Button
                  variant="destructive"
                  size="icon"
                  onClick={handleStop}
                  title="Stop agent"
                >
                  <Square className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  size="icon"
                  onClick={() => sendMessage(input)}
                  disabled={!input.trim()}
                  title="Send"
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

        {/* Sidebar: suggestions */}
        <div className="space-y-4">
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
                  onClick={() => {
                    setInput(cmd);
                  }}
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
                <li>✓ List & create tracks</li>
                <li>✓ List & create speakers</li>
                <li>✓ List & create sessions</li>
                <li>✓ List registrations</li>
                <li>✓ List ticket types</li>
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
