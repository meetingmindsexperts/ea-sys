"use client";

import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Video, ExternalLink, Calendar } from "lucide-react";
import { format } from "date-fns";

interface Occurrence {
  occurrence_id: string;
  start_time: string;
  duration: number;
  status: "available" | "deleted";
}

interface ZoomSeriesScheduleProps {
  occurrences: Occurrence[];
  slug?: string;
  sessionId?: string;
  joinUrl?: string;
}

export function ZoomSeriesSchedule({ occurrences, slug, sessionId, joinUrl }: ZoomSeriesScheduleProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  if (!occurrences || occurrences.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No occurrences available.</p>
    );
  }

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium flex items-center gap-1.5">
        <Calendar className="h-4 w-4 text-blue-600" />
        Webinar Series ({occurrences.filter((o) => o.status === "available").length} occurrences)
      </h4>
      <div className="space-y-1.5">
        {occurrences
          .filter((o) => o.status === "available")
          .map((occurrence) => {
            const startMs = new Date(occurrence.start_time).getTime();
            const endMs = startMs + occurrence.duration * 60 * 1000;
            const isLive = now >= startMs && now <= endMs;
            const isPast = now > endMs;
            const isUpcoming = startMs - now <= 15 * 60 * 1000 && startMs > now;

            return (
              <div
                key={occurrence.occurrence_id}
                className="flex items-center justify-between rounded-md border px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm">
                    {format(new Date(occurrence.start_time), "MMM d, yyyy 'at' h:mm a")}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    ({occurrence.duration} min)
                  </span>
                  {isLive && (
                    <Badge className="bg-green-50 text-green-700 border-green-200" variant="outline">
                      <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
                      Live
                    </Badge>
                  )}
                  {isPast && (
                    <Badge variant="secondary" className="text-xs">Ended</Badge>
                  )}
                </div>

                {(isLive || isUpcoming) && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1 h-7 text-xs"
                    onClick={() => {
                      if (slug && sessionId) {
                        window.open(`/e/${slug}/session/${sessionId}`, "_blank");
                      } else if (joinUrl) {
                        window.open(joinUrl, "_blank");
                      }
                    }}
                  >
                    <Video className="h-3 w-3" />
                    Join
                    <ExternalLink className="h-2.5 w-2.5" />
                  </Button>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
