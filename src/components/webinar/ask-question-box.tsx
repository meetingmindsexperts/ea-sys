"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, MessageSquare, Send, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { QUESTION_MAX_LENGTH, type ViewerQuestionStatus } from "@/lib/webinar/questions";
import { LivePollCard, type ViewerPollData } from "./live-poll-card";

interface MyQuestion {
  id: string;
  question: string;
  status: ViewerQuestionStatus;
  isPublic: boolean;
  createdAt: string;
}

interface PublishedQuestion {
  id: string;
  question: string;
  status: ViewerQuestionStatus;
  createdAt: string;
  voteCount: number;
  votedByMe: boolean;
}

const MY_STATUS_LABEL: Record<ViewerQuestionStatus, string> = {
  NEW: "Sent",
  ANSWERED: "Answered",
  DISMISSED: "Seen",
};

/**
 * The Q&A panel for custom-stream viewers (Oct 1, 2026; beside the video since Oct 2). They watch a one-way
 * stream, so Zoom's Q&A cannot reach them. Three parts: the box to ask, the
 * viewer's own questions with a status, and the questions the organizer has
 * chosen to show everyone (anonymous: never who asked), which
 * attendees can upvote (Oct 6, 2026; most votes first). Refreshed every 15
 * seconds.
 */
export function AskQuestionBox({ slug, sessionId }: { slug: string; sessionId: string }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mine, setMine] = useState<MyQuestion[]>([]);
  const [published, setPublished] = useState<PublishedQuestion[]>([]);
  const [canVote, setCanVote] = useState(false);
  const [upvote, setUpvote] = useState(false);
  const [voting, setVoting] = useState<string | null>(null);
  // The live poll rides this refresh (Oct 6, 2026); null when none is showing.
  const [poll, setPoll] = useState<ViewerPollData | null>(null);
  const [canAnswerPoll, setCanAnswerPoll] = useState(false);
  // Bumped on every vote: a refresh that started before the latest vote is
  // dropped, so a slow poll cannot put an old count back on screen.
  const voteVersion = useRef(0);
  const base = `/api/public/events/${slug}/sessions/${sessionId}/questions`;

  const load = useCallback(async () => {
    const startedAt = voteVersion.current;
    try {
      const res = await fetch(base);
      if (!res.ok) return;
      const data = (await res.json()) as {
        questions: MyQuestion[];
        published?: PublishedQuestion[];
        upvote?: boolean;
        canVote?: boolean;
        poll?: ViewerPollData | null;
        canAnswerPoll?: boolean;
      };
      if (startedAt !== voteVersion.current) return;
      setMine(data.questions);
      setPublished(data.published ?? []);
      setUpvote(Boolean(data.upvote));
      setCanVote(Boolean(data.canVote));
      setPoll(data.poll ?? null);
      setCanAnswerPoll(Boolean(data.canAnswerPoll));
    } catch (err) {
      console.warn("ask-question:load-failed", err);
    }
  }, [base]);

  useEffect(() => {
    void load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  const submit = async () => {
    const question = text.trim();
    if (question.length < 3) {
      setError("Please type a question.");
      return;
    }
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error || "Your question could not be sent. Please try again.");
        return;
      }
      setText("");
      setNotice("Thanks, your question was sent to the moderators.");
      void load();
    } catch (err) {
      console.warn("ask-question:send-failed", err);
      setError("Your question could not be sent. Please check your connection.");
    } finally {
      setSending(false);
    }
  };

  const vote = async (id: string) => {
    voteVersion.current += 1;
    setVoting(id);
    setError(null);
    try {
      const res = await fetch(`${base}/${encodeURIComponent(id)}/vote`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { voted?: boolean; voteCount?: number; error?: string };
      if (!res.ok) {
        console.warn("ask-question:vote-failed", res.status, data);
        setError(data.error || "Your vote could not be recorded. Please try again.");
        return;
      }
      voteVersion.current += 1;
      setPublished((prev) =>
        prev.map((q) => (q.id === id ? { ...q, votedByMe: Boolean(data.voted), voteCount: data.voteCount ?? q.voteCount } : q)),
      );
    } catch (err) {
      console.warn("ask-question:vote-failed", err);
      setError("Your vote could not be recorded. Please check your connection.");
    } finally {
      setVoting(null);
    }
  };

  const mineIds = new Set(mine.map((q) => q.id));

  return (
    <div className="space-y-4">
      {poll && (
        <LivePollCard
          // A new poll starts with a clean selection.
          key={poll.id}
          slug={slug}
          sessionId={sessionId}
          poll={poll}
          canAnswer={canAnswerPoll}
          onAnswered={(pollId, choices) => {
            // A refresh already in flight must not put the unanswered poll back.
            voteVersion.current += 1;
            setPoll((prev) => (prev && prev.id === pollId ? { ...prev, myChoices: choices } : prev));
          }}
        />
      )}
      <Card className="py-4">
        <CardContent className="space-y-3 px-4 py-2">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-primary" />
            <p className="font-medium">Ask a question</p>
          </div>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, QUESTION_MAX_LENGTH))}
            placeholder="Type your question for the speakers"
            rows={3}
            aria-label="Your question"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {text.length}/{QUESTION_MAX_LENGTH} · The moderators decide which questions everyone sees.
            </span>
            <Button size="sm" onClick={() => void submit()} disabled={sending || text.trim().length === 0}>
              {sending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
              Send
            </Button>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          {notice && <p className="text-sm text-green-700">{notice}</p>}
          {mine.length > 0 && (
            <div className="space-y-2 border-t pt-3">
              <p className="text-xs font-medium text-muted-foreground">Your questions</p>
              <ul className="space-y-2">
                {mine.map((q) => (
                  <li key={q.id} className="flex items-start justify-between gap-3 text-sm">
                    <span className="whitespace-pre-wrap break-words">{q.question}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {MY_STATUS_LABEL[q.status]}
                      {q.isPublic && q.status !== "DISMISSED" ? " · Shown to everyone" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="py-4">
        <CardContent className="space-y-3 px-4 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <p className="font-medium">Questions from the audience</p>
            {upvote && published.length > 0 && <span className="text-xs text-muted-foreground">Most votes first</span>}
          </div>
          {published.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No questions shared yet. Questions the moderators select appear here.
            </p>
          ) : (
            <ul className="space-y-3">
              {published.map((q) => (
                <li key={q.id} className="rounded-md border p-3">
                  <p className="text-sm whitespace-pre-wrap break-words">{q.question}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {upvote &&
                      (canVote ? (
                        <Button
                          type="button"
                          size="sm"
                          variant={q.votedByMe ? "default" : "outline"}
                          className="h-7 gap-1 px-2 text-xs"
                          disabled={voting === q.id}
                          aria-pressed={q.votedByMe}
                          aria-label={q.votedByMe ? "Remove your vote" : "Upvote this question"}
                          onClick={() => void vote(q.id)}
                        >
                          <ThumbsUp className="h-3.5 w-3.5" />
                          {q.voteCount}
                        </Button>
                      ) : (
                        <span className="inline-flex items-center gap-1" title="Votes">
                          <ThumbsUp className="h-3.5 w-3.5" />
                          {q.voteCount}
                        </span>
                      ))}
                    {/* Anonymous to attendees (owner): only the viewer's own question says so. */}
                    {mineIds.has(q.id) && <span>Your question</span>}
                    {q.status === "ANSWERED" && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">
                        <CheckCircle2 className="h-3 w-3" />
                        Answered
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
