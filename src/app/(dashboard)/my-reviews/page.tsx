"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ClipboardCheck, ArrowRight, Loader2 } from "lucide-react";
import { formatDate } from "@/lib/utils";

interface Row {
  abstractId: string;
  title: string;
  status: string;
  submittedAt: string;
  event: { id: string; name: string; slug: string; startDate: string; endDate: string };
  role: "PRIMARY" | "SECONDARY" | "CONSULTING" | null;
  conflictFlag: boolean;
  source: "assigned" | "event-pool";
  submission: {
    overallScore: number | null;
    submittedAt: string;
    updatedAt: string;
    stale: boolean;
  } | null;
  submissionStatus: "PENDING" | "NEEDS_UPDATE" | "SUBMITTED";
}

const submissionColors: Record<Row["submissionStatus"], string> = {
  PENDING: "bg-amber-100 text-amber-800 border-amber-200",
  NEEDS_UPDATE: "bg-orange-100 text-orange-800 border-orange-200",
  SUBMITTED: "bg-emerald-100 text-emerald-800 border-emerald-200",
};

const submissionLabels: Record<Row["submissionStatus"], string> = {
  PENDING: "Review pending",
  NEEDS_UPDATE: "Needs update",
  SUBMITTED: "Submitted",
};

export default function MyReviewsPage() {
  const { data, isLoading, error } = useQuery<{ rows: Row[]; total: number }>({
    queryKey: ["my-reviews"],
    queryFn: async () => {
      const res = await fetch("/api/my-reviews");
      if (!res.ok) throw new Error("Failed to load reviews");
      return res.json();
    },
  });

  const rows = data?.rows ?? [];

  // Group by event
  const grouped = rows.reduce<Record<string, { event: Row["event"]; rows: Row[] }>>((acc, row) => {
    const key = row.event.id;
    if (!acc[key]) acc[key] = { event: row.event, rows: [] };
    acc[key].rows.push(row);
    return acc;
  }, {});
  const groups = Object.values(grouped);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
          <ClipboardCheck className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">My Reviews</h1>
          <p className="text-sm text-muted-foreground">Abstracts assigned to you across all events.</p>
        </div>
      </div>

      {isLoading && (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      )}

      {error && (
        <Card>
          <CardContent className="pt-6 text-sm text-red-600">
            {(error as Error).message}
          </CardContent>
        </Card>
      )}

      {!isLoading && !error && rows.length === 0 && (
        <Card>
          <CardContent className="pt-10 pb-10 text-center text-sm text-muted-foreground">
            No abstracts are assigned to you yet. When an organizer adds you as a reviewer, abstracts will
            appear here.
          </CardContent>
        </Card>
      )}

      {groups.map(({ event, rows }) => (
        <section key={event.id} className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">{event.name}</h2>
            <span className="text-xs text-muted-foreground">
              {formatDate(event.startDate)} → {formatDate(event.endDate)}
            </span>
          </div>

          <div className="space-y-2">
            {rows.map((row) => (
              <Card key={row.abstractId} className="hover:shadow-md transition-shadow">
                <CardContent className="pt-5 pb-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge
                          variant="outline"
                          className={submissionColors[row.submissionStatus]}
                        >
                          {submissionLabels[row.submissionStatus]}
                        </Badge>
                        {row.role && (
                          <Badge variant="secondary" className="text-xs">
                            {row.role}
                          </Badge>
                        )}
                        {row.conflictFlag && (
                          <Badge variant="destructive" className="text-xs">
                            Conflict of interest
                          </Badge>
                        )}
                        <Badge variant="outline" className="text-xs">
                          {row.status.replace(/_/g, " ")}
                        </Badge>
                      </div>

                      <h3 className="text-base font-medium truncate">{row.title}</h3>

                      <div className="text-xs text-muted-foreground flex items-center gap-3 flex-wrap">
                        <span>Abstract submitted {formatDate(row.submittedAt)}</span>
                        {row.submission?.overallScore != null && (
                          <span>Your score: {row.submission.overallScore}/100</span>
                        )}
                        {row.submission?.stale && (
                          <span className="text-orange-600">
                            Abstract updated after your review — please re-check.
                          </span>
                        )}
                      </div>
                    </div>

                    <Button variant="outline" size="sm" asChild>
                      <Link
                        href={`/events/${row.event.id}/abstracts/${row.abstractId}/edit`}
                      >
                        {row.submissionStatus === "SUBMITTED" ? "View" : "Review"}
                        <ArrowRight className="ml-1 h-4 w-4" />
                      </Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
