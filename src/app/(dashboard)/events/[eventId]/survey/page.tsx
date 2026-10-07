"use client";

/**
 * An event's surveys (Oct 6, 2026; docs/MULTI_SURVEY_PLAN.md).
 *
 *   /events/[eventId]/survey
 *
 * The certificate (CME) survey sits first in its reserved slot, locked: it is
 * the only survey that marks a registration complete for certificates, and it
 * can never be deleted or swapped. Extra surveys (webinar feedback, a needs
 * survey, …) are listed below it; they record answers and never affect
 * certificates. Each opens in the builder at ./[surveyId].
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, BarChart3, ClipboardList, Copy, Loader2, Lock, Pencil, Plus } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useCan } from "@/hooks/use-can";
import { duplicateSurveyRequest } from "@/lib/survey/duplicate-client";

interface SurveyListRow {
  id: string;
  name: string;
  config: unknown;
  isActive: boolean;
  gatesCertificates: boolean;
  responseCount: number;
  updatedAt: string;
  /** Phase 4. */
  responseMode?: "ONCE" | "ONCE_PER_DAY";
}

function questionCount(config: unknown): number {
  return Array.isArray(config) ? config.length : 0;
}

export default function SurveysPage() {
  const params = useParams();
  const eventId = params.eventId as string;
  const canEdit = useCan("surveys.manage", eventId) === "allowed";
  const [loading, setLoading] = useState(true);
  const [eventName, setEventName] = useState("");
  const [surveys, setSurveys] = useState<SurveyListRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/events/${eventId}/surveys`);
        if (!res.ok) {
          console.warn("surveys:list-failed", res.status);
          toast.error("Could not load the surveys.");
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        setEventName(data.event?.name ?? "");
        setSurveys(data.surveys ?? []);
      } catch (err) {
        console.error("surveys:list-failed", err);
        toast.error("Could not load the surveys.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (loading) {
    return (
      <div className="container py-8">
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  const certificate = surveys.find((s) => s.gatesCertificates) ?? null;
  const extras = surveys.filter((s) => !s.gatesCertificates);

  return (
    <div className="w-full py-8">
      <div className="mb-6">
        <Link href={`/events/${eventId}`} className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 h-3 w-3" />
          Back to event
        </Link>
      </div>

      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Surveys</h1>
          <p className="mt-1 text-muted-foreground">
            Feedback and certificate surveys for <span className="font-medium">{eventName}</span>.
          </p>
        </div>
        {canEdit && (
          <Link href={`/events/${eventId}/survey/new`}>
            <Button size="sm">
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              New survey
            </Button>
          </Link>
        )}
      </div>

      {/* The reserved, locked CME slot */}
      <Card className="mb-6 border-primary/30">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            Certificate (CME) survey
            <Badge variant="secondary" className="gap-1 text-xs">
              <Lock className="h-3 w-3" />
              Reserved
            </Badge>
          </CardTitle>
          <CardDescription className="text-xs">
            Completing this survey is what issues CME certificates. It is locked: it cannot be deleted or swapped for
            another survey.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {certificate ? (
            <SurveyRow eventId={eventId} survey={certificate} canEdit={canEdit} />
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed p-4">
              <p className="text-sm text-muted-foreground">No certificate survey yet.</p>
              {canEdit && (
                <Link href={`/events/${eventId}/survey/certificate`}>
                  <Button variant="outline" size="sm">
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    Set up the certificate survey
                  </Button>
                </Link>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Extra surveys */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Other surveys</CardTitle>
          <CardDescription className="text-xs">
            Webinar feedback, a needs survey, speaker feedback. Answers are recorded and exported, and never affect
            certificates.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {extras.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-md border border-dashed p-6 text-center">
              <ClipboardList className="h-6 w-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No other surveys yet.</p>
            </div>
          ) : (
            extras.map((s) => <SurveyRow key={s.id} eventId={eventId} survey={s} canEdit={canEdit} />)
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SurveyRow({ eventId, survey, canEdit }: { eventId: string; survey: SurveyListRow; canEdit: boolean }) {
  const router = useRouter();
  const [duplicating, setDuplicating] = useState(false);
  const canDuplicate = canEdit && questionCount(survey.config) > 0;
  const editHref = survey.gatesCertificates ? `/events/${eventId}/survey/certificate` : `/events/${eventId}/survey/${survey.id}`;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-4">
      <div className="min-w-0">
        <p className="flex items-center gap-2 font-medium">
          {survey.name}
          <Badge variant={survey.isActive ? "outline" : "secondary"} className="text-xs">
            {survey.isActive ? "Open" : "Closed"}
          </Badge>
          {survey.responseMode === "ONCE_PER_DAY" && (
            <Badge variant="secondary" className="text-xs">
              Once a day
            </Badge>
          )}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {questionCount(survey.config)} question{questionCount(survey.config) === 1 ? "" : "s"} ·{" "}
          {survey.responseCount} answer{survey.responseCount === 1 ? "" : "s"}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Link href={`/events/${eventId}/survey/responses?surveyId=${encodeURIComponent(survey.id)}`}>
          <Button variant="outline" size="sm">
            <BarChart3 className="mr-1.5 h-3.5 w-3.5" />
            Responses
          </Button>
        </Link>
        {canDuplicate && (
          <Button
            variant="outline"
            size="sm"
            disabled={duplicating}
            title="Copy into a new, closed survey (never the certificate survey)"
            onClick={async () => {
              setDuplicating(true);
              const id = await duplicateSurveyRequest(eventId, survey.id);
              setDuplicating(false);
              if (id) router.push(`/events/${eventId}/survey/${id}`);
            }}
          >
            {duplicating ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
            Duplicate
          </Button>
        )}
        <Link href={editHref}>
          <Button variant="outline" size="sm">
            <Pencil className="mr-1.5 h-3.5 w-3.5" />
            {canEdit ? "Edit" : "View"}
          </Button>
        </Link>
      </div>
    </div>
  );
}
