"use client";

/**
 * Webinar handouts on the attendee page (Oct 6, 2026;
 * docs/WEBINAR_INTERACTION_PLAN.md §4), under the panelists. The list and each
 * download go through routes that admit only a signed-in registrant of the
 * webinar (or org staff testing the page). Refreshed every minute, so a file
 * the producer adds mid-webinar appears without a reload.
 */

import { useEffect, useState } from "react";
import { Download, FileText } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatHandoutSize, type PublicHandout } from "@/lib/webinar/handouts";

export function useWebinarHandouts(slug: string, sessionId: string, enabled: boolean): PublicHandout[] {
  const [handouts, setHandouts] = useState<PublicHandout[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/public/events/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/handouts`);
        if (!res.ok) {
          console.warn("handouts:load-failed", res.status);
          return;
        }
        const data = (await res.json()) as { handouts?: PublicHandout[] };
        if (!cancelled) setHandouts(data.handouts ?? []);
      } catch (err) {
        console.warn("handouts:load-failed", err);
      }
    };
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [slug, sessionId, enabled]);
  return handouts;
}

const TYPE_LABEL: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPTX",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
};

export function HandoutsCard({ slug, sessionId, handouts }: { slug: string; sessionId: string; handouts: PublicHandout[] }) {
  if (handouts.length === 0) return null;
  const base = `/api/public/events/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/handouts`;
  return (
    <Card className="py-3">
      <CardContent className="space-y-2 px-3 py-1">
        <p className="text-sm font-semibold">Handouts</p>
        <ul className="space-y-1">
          {handouts.map((h) => (
            <li key={h.id}>
              <a
                href={`${base}/${encodeURIComponent(h.id)}`}
                target="_blank"
                rel="noopener"
                className="group flex items-center gap-2 rounded-md p-1.5 text-sm hover:bg-muted"
              >
                <FileText className="h-4 w-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium group-hover:underline" title={h.name}>
                    {h.name}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {TYPE_LABEL[h.contentType] ?? "File"} · {formatHandoutSize(h.size)}
                  </span>
                </span>
                <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
              </a>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
