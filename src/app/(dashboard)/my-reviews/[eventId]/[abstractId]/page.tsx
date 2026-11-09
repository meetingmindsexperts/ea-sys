"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CriteriaScoreEditor, type CriteriaScoreItem } from "@/components/abstracts/criteria-score-editor";
import { useMyReview, useSubmitMyReview, type MyReview, type RecommendedFormat } from "@/hooks/use-api";
import { ApiError } from "@/lib/api-fetch";
import { formatAbstractSerial } from "@/lib/abstract-serial";
import { formatDate } from "@/lib/utils";

type OpenReview = Extract<MyReview, { conflict: false }>;

const FORMAT_LABELS: Record<RecommendedFormat, string> = {
  ORAL: "Oral presentation",
  POSTER: "Poster",
  NEITHER: "Neither",
};

const joinParts = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(", ");

function BackLink() {
  return (
    <Button variant="ghost" size="sm" asChild className="-ml-2">
      <Link href="/my-reviews">
        <ArrowLeft className="mr-1 h-4 w-4" />
        My Reviews
      </Link>
    </Button>
  );
}

function Message({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{children}</p>
      <Button asChild className="mt-6">
        <Link href="/my-reviews">Back to My Reviews</Link>
      </Button>
    </div>
  );
}

function loadFailure(error: unknown) {
  if (error instanceof ApiError && error.code === "EMAIL_NOT_CONFIRMED") {
    return <Message title="Confirm your email first">Open My Reviews to send yourself a confirmation link. You can review once your address is confirmed.</Message>;
  }
  if (error instanceof ApiError && error.status === 403) {
    return <Message title="You can't review this abstract">This is your own abstract. Reviews of it come from other reviewers.</Message>;
  }
  if (error instanceof ApiError && error.status === 404) {
    return <Message title="We can't show this abstract">It may have been deleted, or you may no longer be a reviewer for it.</Message>;
  }
  return <Message title="Couldn't load this abstract">Something went wrong fetching it. Please try again.</Message>;
}

function initialCriteriaScores(review: OpenReview): CriteriaScoreItem[] {
  const stored = review.submission?.criteriaScores ?? {};
  return review.criteria
    .filter((c) => typeof stored[c.id] === "number")
    .map((c) => ({ criterionId: c.id, name: c.name, weight: c.weight, score: stored[c.id] }));
}

function ReviewForm({ review, eventId, abstractId }: { review: OpenReview; eventId: string; abstractId: string }) {
  const router = useRouter();
  const submit = useSubmitMyReview(eventId, abstractId);
  const { criteria, submission } = review;
  const [criteriaScores, setCriteriaScores] = useState<CriteriaScoreItem[]>(() => initialCriteriaScores(review));
  const [overallScore, setOverallScore] = useState<number | null>(submission?.overallScore ?? null);
  const [reviewNotes, setReviewNotes] = useState(submission?.reviewNotes ?? "");
  const [format, setFormat] = useState<RecommendedFormat | undefined>(submission?.recommendedFormat ?? undefined);

  const usesCriteria = criteria.length > 0;
  const scoreValid = overallScore !== null && Number.isInteger(overallScore) && overallScore >= 0 && overallScore <= 100;
  // Against the current criteria: an organiser can change them while this is open.
  const scored = criteria.map((c) => criteriaScores.find((s) => s.criterionId === c.id)).filter((s) => s !== undefined);
  const complete = usesCriteria ? scored.length === criteria.length : scoreValid;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!complete) return;
    submit.mutate(
      {
        ...(usesCriteria
          ? { criteriaScores: scored.map(({ criterionId, score }) => ({ criterionId, score })) }
          : { overallScore: overallScore as number }),
        reviewNotes,
        recommendedFormat: format,
      },
      {
        onSuccess: () => {
          toast.success(submission ? "Your review was updated" : "Your review was submitted");
          router.push("/my-reviews");
        },
        onError: (err) => toast.error(err.message),
      },
    );
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-2">
        <h2 className="text-sm font-semibold">Your score</h2>
        {usesCriteria && (
          <p className="text-xs text-muted-foreground">Score each criterion from 0 to 10.</p>
        )}
        <CriteriaScoreEditor
          criteria={criteria}
          value={criteriaScores}
          onChange={setCriteriaScores}
          plainScore={overallScore}
          onPlainScoreChange={setOverallScore}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="recommendedFormat">Recommended format</Label>
        <Select value={format ?? ""} onValueChange={(v) => setFormat(v as RecommendedFormat)}>
          <SelectTrigger id="recommendedFormat">
            <SelectValue placeholder="Optional" />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(FORMAT_LABELS) as RecommendedFormat[]).map((f) => (
              <SelectItem key={f} value={f}>{FORMAT_LABELS[f]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="reviewNotes">Notes</Label>
        <Textarea
          id="reviewNotes"
          rows={5}
          maxLength={5000}
          value={reviewNotes}
          onChange={(e) => setReviewNotes(e.target.value)}
          placeholder="Optional"
        />
        <p className="text-xs text-muted-foreground">
          The author may read these notes, without your name.
        </p>
      </div>

      <Button type="submit" className="w-full" disabled={!complete || submit.isPending}>
        {submit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {submission ? "Update review" : "Submit review"}
      </Button>
    </form>
  );
}

function AbstractBody({ review }: { review: OpenReview }) {
  const { abstract } = review;
  const details: [string, string | null | undefined][] = [
    ["Theme", joinParts(abstract.theme?.name, abstract.subTheme?.name)],
    ["Track", abstract.track?.name],
    ["Specialty", abstract.specialty],
    ["Presentation type", abstract.presentationType?.replace(/_/g, " ").toLowerCase()],
    ["Submitted", formatDate(abstract.submittedAt)],
  ];
  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        <div>
          <h2 className="text-sm font-semibold">Author</h2>
          <p className="text-sm">
            {abstract.author.firstName} {abstract.author.lastName}
          </p>
          <p className="text-sm text-muted-foreground">
            {joinParts(abstract.author.jobTitle, abstract.author.organization, abstract.author.country)}
          </p>
        </div>

        {abstract.coAuthors.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold">Co-authors ({abstract.coAuthors.length})</h2>
            <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
              {abstract.coAuthors.map((ca, i) => (
                <li key={i}>
                  <span className="text-foreground">{ca.firstName} {ca.lastName}</span>
                  {joinParts(ca.jobTitle, ca.organization, ca.country) && ` · ${joinParts(ca.jobTitle, ca.organization, ca.country)}`}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <h2 className="text-sm font-semibold">Abstract</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{abstract.content}</p>
        </div>

        <dl className="grid gap-x-6 gap-y-2 border-t pt-4 text-sm sm:grid-cols-2">
          {details.filter(([, v]) => v).map(([label, v]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="first-letter:uppercase">{v}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function ClosedNotice({ review }: { review: OpenReview }) {
  const { submission, abstract } = review;
  return (
    <div className="space-y-3 text-sm">
      <h2 className="font-semibold">Review closed</h2>
      <p className="text-muted-foreground">
        This abstract is {abstract.status.replace(/_/g, " ").toLowerCase()}, so reviews can no longer be changed.
      </p>
      {submission?.overallScore != null && <p>Your score: {submission.overallScore}/100</p>}
      {submission?.reviewNotes && <p className="whitespace-pre-wrap">{submission.reviewNotes}</p>}
    </div>
  );
}

export default function MyReviewPage() {
  const params = useParams();
  const eventId = params.eventId as string;
  const abstractId = params.abstractId as string;
  const { data: review, isLoading, error } = useMyReview(eventId, abstractId);

  if (isLoading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }
  if (error || !review) return loadFailure(error);

  const heading = (
    <div className="space-y-1">
      <p className="text-sm text-muted-foreground">{review.event.name}</p>
      <h1 className="text-2xl font-semibold tracking-tight">
        {review.abstract.serialId != null && (
          <span className="mr-2 font-mono text-base text-muted-foreground">
            {formatAbstractSerial(review.abstract.serialId)}
          </span>
        )}
        {review.abstract.title}
      </h1>
    </div>
  );

  if (review.conflict) {
    return (
      <div className="space-y-4">
        <BackLink />
        {heading}
        <Card>
          <CardContent className="pt-6 text-sm">
            <Badge variant="destructive" className="mb-2">Conflict of interest</Badge>
            <p className="text-muted-foreground">
              A conflict of interest is recorded for you on this abstract, so you cannot read or review it.
              If this is wrong, contact the event organizer.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <BackLink />
      {heading}
      <div className="flex flex-wrap items-center gap-2">
        {review.assignmentRole && <Badge variant="secondary">{review.assignmentRole}</Badge>}
        <Badge variant="outline">{review.abstract.status.replace(/_/g, " ")}</Badge>
        {review.submission?.stale && (
          <span className="text-sm text-orange-600">The abstract changed after your review. Please re-check it.</span>
        )}
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <AbstractBody review={review} />
        <Card className="lg:sticky lg:top-4">
          <CardContent className="pt-6">
            {review.canSubmit ? (
              <ReviewForm key={review.submission?.updatedAt ?? "new"} review={review} eventId={eventId} abstractId={abstractId} />
            ) : (
              <ClosedNotice review={review} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
