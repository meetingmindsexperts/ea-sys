"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, MessageSquare, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { QUESTION_MAX_LENGTH, type ViewerQuestionStatus } from "@/lib/webinar/questions";

interface MyQuestion {
  id: string;
  question: string;
  status: ViewerQuestionStatus;
  createdAt: string;
}

const STATUS_LABEL: Record<ViewerQuestionStatus, string> = {
  NEW: "Sent",
  ANSWERED: "Answered",
  DISMISSED: "Seen",
};

/**
 * "Ask a question" for custom-stream viewers (Oct 1, 2026). They watch a
 * one-way stream, so Zoom's Q&A cannot reach them; questions go to the
 * producers' list in the Webinar Console. Shows the viewer's own questions
 * with a simple status; refreshed every 20 seconds.
 */
export function AskQuestionBox({ slug, sessionId }: { slug: string; sessionId: string }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mine, setMine] = useState<MyQuestion[]>([]);
  const base = `/api/public/events/${slug}/sessions/${sessionId}/questions`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(base);
      if (!res.ok) return;
      const data = (await res.json()) as { questions: MyQuestion[] };
      setMine(data.questions);
    } catch (err) {
      console.warn("ask-question:load-failed", err);
    }
  }, [base]);

  useEffect(() => {
    void load();
    const id = setInterval(load, 20_000);
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

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-blue-600" />
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
            {text.length}/{QUESTION_MAX_LENGTH} · Only the moderators see your question.
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
                  <span className="shrink-0 text-xs text-muted-foreground">{STATUS_LABEL[q.status]}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
