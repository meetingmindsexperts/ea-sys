/**
 * Help chat drawer — opens from the dashboard sidebar (commit #5 wires
 * the trigger). Distinct from the AI Agent: this one only answers
 * questions; it can't mutate anything.
 *
 * Architecture:
 *   - The drawer is controlled by `open` / `onOpenChange` props so the
 *     parent (dashboard layout) can manage open state and trigger from
 *     the sidebar.
 *   - The `useHelpChat()` hook owns conversation state + SSE + per-user
 *     localStorage persistence. The sheet is presentation only.
 *   - Empty state shows a heading + role-aware starter questions as
 *     clickable chips. Clicking sends the question.
 *   - Typing indicator shows three bouncing dots while the assistant
 *     message is streaming and still empty (first token hasn't
 *     arrived); replaced by streamed text as soon as content appears.
 *   - Cmd/Ctrl+Enter sends (Enter alone inserts newline — multiline
 *     questions allowed).
 *
 * Markdown rendering is intentionally NOT done for v1 — the bot's
 * output uses `**bold**` and bullet `-` lists, which render as literals
 * here. Plain `whitespace-pre-wrap` keeps streaming visually stable
 * (no half-parsed markdown flashing). Real markdown is a v1.1
 * follow-up if anyone asks.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { BookOpen, ExternalLink, HelpCircle, Send, Trash2 } from "lucide-react";
import { useSession } from "next-auth/react";
import { cn } from "@/lib/utils";
import { useHelpChat, type ChatMessage } from "./use-help-chat";

interface HelpChatSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Hard-coded — the guide is bundled into the Docker image at
// public/user-guide.html and the path is stable for the lifetime of
// the chatbot. Env-overriding a cosmetic UI URL is over-engineering
// (different shape from the model id, which CAN move between
// Anthropic releases). If the guide ever moves, change here.
const USER_GUIDE_URL = "/user-guide.html";

// Per the plan — role-tailored. Falls back to ADMIN/ORGANIZER's set
// when the role is anything unrecognized so we always show something.
const STARTERS_BY_ROLE: Record<string, string[]> = {
  SUPER_ADMIN: [
    "How do I add a registration?",
    "What's the difference between INCLUSIVE and COMPLIMENTARY?",
    "How do I attach a payer to an event?",
    "When would I use an INTERNAL API key?",
  ],
  ADMIN: [
    "How do I add a registration?",
    "What's the difference between INCLUSIVE and COMPLIMENTARY?",
    "How do I attach a payer to an event?",
    "How do I send a quote to a registrant?",
  ],
  ORGANIZER: [
    "How do I add a registration?",
    "What's the difference between INCLUSIVE and COMPLIMENTARY?",
    "How do I attach a payer to an event?",
    "How do I send a quote to a registrant?",
  ],
  MEMBER: [
    "What can I view in this dashboard?",
    "Why don't I see financial data?",
    "What does my role allow me to do?",
  ],
  REVIEWER: [
    "Where do I review abstracts?",
    "How is the abstract score calculated?",
    "What does NEEDS_UPDATE mean?",
  ],
  SUBMITTER: [
    "How do I edit my abstract?",
    "What does REVISION_REQUESTED mean?",
    "When can I no longer change my submission?",
  ],
  REGISTRANT: [
    "How do I pay for my registration?",
    "How do I download my invoice?",
    "How do I update my contact details?",
  ],
};

function startersFor(role: string | null | undefined): string[] {
  if (role && STARTERS_BY_ROLE[role]) return STARTERS_BY_ROLE[role];
  return STARTERS_BY_ROLE.ADMIN;
}

export function HelpChatSheet({ open, onOpenChange }: HelpChatSheetProps) {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  const role = session?.user?.role ?? null;

  const { messages, isStreaming, error, send, clear } = useHelpChat(userId);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom on every message change (new turn or
  // streaming delta). Smooth-scroll would feel laggy with deltas
  // arriving 20+ times per second; instant scroll matches the chat
  // pace.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Focus the input when the drawer opens — saves a click for users
  // who clicked Help meaning to ask something immediately.
  useEffect(() => {
    if (open) {
      // Small delay lets the sheet animation settle before focus,
      // which prevents the keyboard from grabbing layout space on
      // mobile mid-animation.
      const t = setTimeout(() => textareaRef.current?.focus(), 150);
      return () => clearTimeout(t);
    }
  }, [open]);

  const handleSend = async () => {
    const content = input.trim();
    if (!content || isStreaming) return;
    setInput("");
    await send(content);
  };

  const handleStarterClick = (q: string) => {
    if (isStreaming) return;
    void send(q);
  };

  const showEmptyState = messages.length === 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-[580px] p-0 flex flex-col gap-0 sm:rounded-l-lg overflow-hidden">
        {/* pr-12 leaves room for the Sheet primitive's built-in close X,
            which is absolutely positioned at top-4 right-4. Without
            this, "Clear chat" overlaps the close button. */}
        <SheetHeader className="px-4 pr-12 py-3 border-b shrink-0 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <SheetTitle className="flex items-center gap-2 text-base">
              <HelpCircle className="h-5 w-5 text-primary" />
              Help Assistant
            </SheetTitle>
            <div className="flex items-center gap-1">
              {/* Always-visible link to the full user guide.
                  target="_blank" so the chat session + scroll position
                  survive — opening in-place would unmount the drawer
                  and clear localStorage-cached messages from the
                  user's perspective. */}
              <Button
                asChild
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground"
              >
                <a
                  href={USER_GUIDE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <BookOpen className="h-3.5 w-3.5 mr-1" />
                  Open guide
                </a>
              </Button>
              {messages.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={clear}
                  className="h-7 text-xs text-muted-foreground"
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1" />
                  Clear chat
                </Button>
              )}
            </div>
          </div>
          <SheetDescription asChild>
            <span className="text-xs text-muted-foreground block">
              Ask anything about EA-SYS. Answers come from the user guide.
              For doing things on an event, use the AI Agent in Tools.
            </span>
          </SheetDescription>
        </SheetHeader>

        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-4 py-4 space-y-3"
        >
          {showEmptyState ? (
            <div className="flex flex-col items-center text-center pt-6 pb-2">
              <div className="w-14 h-14 rounded-full bg-primary/10 text-primary flex items-center justify-center mb-3">
                <HelpCircle className="h-7 w-7" />
              </div>
              <h3 className="font-semibold text-sm">How can I help?</h3>
              <p className="text-xs text-muted-foreground mt-1 mb-5">
                Try one of these, or type your own question below.
              </p>
              <div className="w-full space-y-2">
                {startersFor(role).map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => handleStarterClick(q)}
                    disabled={isStreaming}
                    className={cn(
                      "w-full text-left px-3 py-2 text-sm rounded-md border",
                      "hover:bg-accent hover:border-accent-foreground/20",
                      "disabled:opacity-50 disabled:cursor-not-allowed",
                      "transition-colors",
                    )}
                  >
                    {q}
                  </button>
                ))}
              </div>
              {/* Discoverability CTA — first-time openers see "oh
                  there's a real guide" before they even type. Only
                  visible in the empty state; once a conversation
                  starts, the header link in the top-right is the way
                  in (same destination). */}
              <div className="pt-4 mt-4 border-t border-border w-full">
                <a
                  href={USER_GUIDE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <BookOpen className="h-3.5 w-3.5" />
                  Or browse the full guide
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          ) : (
            messages.map((m, i) => (
              <MessageBubble
                key={i}
                message={m}
                isStreamingPlaceholder={
                  isStreaming &&
                  i === messages.length - 1 &&
                  m.role === "assistant" &&
                  m.content === ""
                }
              />
            ))
          )}
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 text-red-800 text-xs px-3 py-2">
              {error}
            </div>
          )}
        </div>

        <div className="border-t shrink-0 p-3 space-y-1.5 bg-background">
          <div className="flex gap-2 items-end">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              placeholder={
                isStreaming ? "Waiting for response…" : "Ask a question…"
              }
              className="resize-none text-sm min-h-[60px]"
              rows={2}
              disabled={isStreaming}
              maxLength={4000}
            />
            <Button
              type="button"
              onClick={handleSend}
              disabled={!input.trim() || isStreaming}
              size="icon"
              className="shrink-0"
              aria-label="Send"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Cmd/Ctrl+Enter to send · Max 4000 characters
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function MessageBubble({
  message,
  isStreamingPlaceholder,
}: {
  message: ChatMessage;
  isStreamingPlaceholder: boolean;
}) {
  const isUser = message.role === "user";
  return (
    <div
      className={cn(
        "flex",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "rounded-lg px-3 py-2 max-w-[85%] text-sm break-words",
          isUser
            ? "bg-primary text-primary-foreground whitespace-pre-wrap"
            : "bg-muted text-foreground",
        )}
      >
        {isStreamingPlaceholder ? (
          <TypingDots />
        ) : isUser ? (
          // User turns are plain text — they typed it; render verbatim
          // so paste-formatting (line breaks etc.) survives.
          message.content
        ) : (
          // Assistant turns: render markdown. The bot's prompt format
          // uses **bold**, numbered lists, and bullet lists — readers
          // shouldn't see those characters literally.
          // Same `prose` styling as the AI Agent for visual consistency.
          // remark-gfm enables GitHub-style task lists, tables, etc.
          // (used rarely by the bot but free to support).
          // Partial markdown during streaming (e.g. an unclosed `**`)
          // renders as the literal characters until the closing token
          // arrives — graceful degradation, no flicker.
          <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-headings:mt-3 prose-headings:mb-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-code:bg-background prose-code:px-1 prose-code:rounded prose-code:text-xs prose-pre:bg-background prose-pre:p-2 prose-pre:rounded prose-pre:text-xs prose-blockquote:border-l-2 prose-blockquote:pl-3 prose-blockquote:text-muted-foreground prose-hr:my-2 prose-table:text-xs">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {message.content}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

/** Three-dot bouncing indicator while the assistant message is empty
 *  and streaming. Replaced by the streamed text as soon as the first
 *  delta arrives. */
function TypingDots() {
  return (
    <span className="inline-flex gap-1 items-center py-1" aria-label="Thinking">
      <span className="w-1.5 h-1.5 rounded-full bg-foreground/40 animate-bounce [animation-delay:-0.3s]" />
      <span className="w-1.5 h-1.5 rounded-full bg-foreground/40 animate-bounce [animation-delay:-0.15s]" />
      <span className="w-1.5 h-1.5 rounded-full bg-foreground/40 animate-bounce" />
    </span>
  );
}
