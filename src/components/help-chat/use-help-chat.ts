/**
 * Hook managing help-chat conversation state + SSE streaming + per-user
 * localStorage persistence.
 *
 * Responsibilities:
 *   - Hold the `messages` array (user + assistant turns).
 *   - `send(content)` — POSTs full history to `/api/help-chat`, parses
 *     the SSE stream from the response body, appends text deltas onto
 *     the streaming assistant message.
 *   - `clear()` — wipe messages + localStorage.
 *   - Persist per user to `ea-sys:help-chat:v1:<userId>` so closing +
 *     reopening the drawer restores the conversation.
 *
 * Stateless server: each `send()` sends the FULL message history. The
 * server doesn't track sessions; the client is the source of truth.
 *
 * Persistence schema is versioned (`v: 1`) — bumping the version in
 * the future is a clean way to migrate / invalidate stored chats.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** ms epoch for ordering / future analytics. */
  ts?: number;
}

export interface UseHelpChatReturn {
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  send: (content: string) => Promise<void>;
  clear: () => void;
}

const STORAGE_KEY_PREFIX = "ea-sys:help-chat:v1:";

/** Server hard-caps at 40; client soft-caps lower to encourage fresh
 *  conversations (the bot's coherence drops past ~20 turns anyway). */
const PERSIST_CAP = 40;

interface StoredPayload {
  v: number;
  messages: ChatMessage[];
}

function readStoredMessages(userId: string): ChatMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_PREFIX + userId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredPayload;
    if (parsed?.v === 1 && Array.isArray(parsed.messages)) {
      return parsed.messages.slice(-PERSIST_CAP);
    }
  } catch {
    // Corrupt JSON or unavailable storage — fall through to empty.
  }
  return [];
}

function writeStoredMessages(userId: string, messages: ChatMessage[]): void {
  if (typeof window === "undefined") return;
  try {
    const payload: StoredPayload = {
      v: 1,
      messages: messages.slice(-PERSIST_CAP),
    };
    window.localStorage.setItem(
      STORAGE_KEY_PREFIX + userId,
      JSON.stringify(payload),
    );
  } catch {
    // Quota exceeded / private-mode / etc. — silently drop persistence.
    // The in-memory state still works for the current session.
  }
}

export function useHelpChat(userId: string | undefined): UseHelpChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guard so the load-from-localStorage effect only fires once per
  // userId change, and never re-runs in a way that would clobber
  // messages added during streaming.
  const loadedForUserId = useRef<string | undefined>(undefined);

  useEffect(() => {
    // Initial load + reload when the user changes (e.g. login as a
    // different user → different stored chat). Deliberately uses an
    // effect rather than useState's lazy initializer to avoid SSR /
    // hydration mismatch — the server can't read localStorage.
    if (!userId) {
      setMessages([]);
      loadedForUserId.current = undefined;
      return;
    }
    if (loadedForUserId.current === userId) return;
    loadedForUserId.current = userId;
    setMessages(readStoredMessages(userId));
  }, [userId]);

  useEffect(() => {
    // Persist on every change. Cheap — localStorage writes are sync
    // and small for our payload size. No debouncing needed at the
    // conversation pace.
    if (!userId) return;
    writeStoredMessages(userId, messages);
  }, [messages, userId]);

  const clear = useCallback(() => {
    setMessages([]);
    setError(null);
    if (userId && typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(STORAGE_KEY_PREFIX + userId);
      } catch {
        // Best-effort cleanup.
      }
    }
  }, [userId]);

  const send = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed || isStreaming) return;

      const userTurn: ChatMessage = {
        role: "user",
        content: trimmed,
        ts: Date.now(),
      };

      // Optimistically append both the user turn AND an empty assistant
      // placeholder. The placeholder gets filled by streamed deltas.
      // Doing both in one setState keeps the UI from flickering.
      const historyForRequest = [...messages, userTurn];
      setMessages([
        ...historyForRequest,
        { role: "assistant", content: "", ts: Date.now() },
      ]);
      setIsStreaming(true);
      setError(null);

      try {
        const res = await fetch("/api/help-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: historyForRequest.map(({ role, content }) => ({
              role,
              content,
            })),
          }),
        });

        if (!res.ok) {
          // Non-2xx response — typically 401 (session expired) /
          // 400 (validation) / 429 (rate limit) / 500. Surface the
          // server's error message; the route follows the codebase's
          // standard { error, code?, retryAfterSeconds? } shape.
          const body = await res.json().catch(() => ({}));
          const msg: string =
            body?.error || `Help chat failed (${res.status})`;
          // Special case: rate limit. Include the wait time.
          if (res.status === 429 && body?.retryAfterSeconds) {
            throw new Error(
              `${msg} Try again in ${body.retryAfterSeconds}s.`,
            );
          }
          throw new Error(msg);
        }

        // SSE parsing: read the body as a stream of UTF-8 text, split
        // on `\n\n` event boundaries, parse each `data: {...}` line.
        // Buffer the trailing fragment in case a chunk arrives
        // mid-event.
        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response stream");
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";

          for (const evt of events) {
            const dataLine = evt
              .split("\n")
              .find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            let parsed: { type: string; delta?: string; message?: string };
            try {
              parsed = JSON.parse(dataLine.slice("data: ".length));
            } catch {
              // Malformed event — skip; don't break the whole stream.
              continue;
            }

            if (parsed.type === "text" && typeof parsed.delta === "string") {
              const delta = parsed.delta;
              setMessages((prev) => {
                if (prev.length === 0) return prev;
                const last = prev[prev.length - 1];
                if (last.role !== "assistant") return prev;
                const next = prev.slice(0, -1);
                next.push({ ...last, content: last.content + delta });
                return next;
              });
            } else if (parsed.type === "error") {
              setError(parsed.message || "Help chat error");
            }
            // type === "done" — nothing to do; the stream end will
            // close the reader naturally.
          }
        }
      } catch (e) {
        const message =
          e instanceof Error ? e.message : "Help chat failed";
        setError(message);
        // Drop the empty assistant placeholder so the user can retry
        // without a phantom bubble in the conversation.
        setMessages((prev) => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          if (last.role === "assistant" && last.content === "") {
            return prev.slice(0, -1);
          }
          return prev;
        });
      } finally {
        setIsStreaming(false);
      }
    },
    [messages, isStreaming],
  );

  return { messages, isStreaming, error, send, clear };
}
