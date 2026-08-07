"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FileText,
  ArrowLeft,
  Save,
  Loader2,
  Send,
  Trash2,
} from "lucide-react";
import { useSession } from "next-auth/react";
import { useSubmitterProfileGate } from "@/hooks/use-submitter-profile-gate";
import { useTracks, useEvent, useAbstractThemes, queryKeys } from "@/hooks/use-api";
import { ApiError } from "@/lib/api-fetch";
import { isThemeMissing, THEME_REQUIRED_MESSAGE, isSubThemeMissing, SUB_THEME_REQUIRED_MESSAGE } from "@/lib/abstract-theme-requirement";
import { AbstractSubThemeSelect, subThemesOf } from "@/components/abstracts/abstract-sub-theme-select";
import { AbstractThemeSelect } from "@/components/abstracts/abstract-theme-select";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import { formatDate } from "@/lib/utils";
import { formatAbstractSerial } from "@/lib/abstract-serial";
import Link from "next/link";
import {
  enabledPresentationTypeOptions,
  PRESENTATION_TYPE_LABELS,
  abstractStatusColor,
  abstractStatusLabel,
} from "../../abstract-enums";
import { AbstractReviewersCard } from "@/components/abstracts/abstract-reviewers-card";
import { PresenterAgreementCard } from "@/components/abstracts/presenter-agreement-card";
import { CoAuthorFields } from "@/components/abstracts/co-author-fields";
import { normalizeCoAuthors } from "@/lib/abstract-coauthors";
import { MAX_ABSTRACT_WORDS, countWords } from "@/lib/abstract-content";

interface Track {
  id: string;
  name: string;
  color: string;
}


const editableStatuses = ["DRAFT", "SUBMITTED", "REVISION_REQUESTED"];

/** Strip HTML tags for legacy content */
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

// Inner form component — only mounts after abstract data is loaded
function EditForm({ abstract, eventId, abstractId, tracks }: {
  abstract: Record<string, unknown>;
  eventId: string;
  abstractId: string;
  tracks: Track[];
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  // Cache read (same key as the theme picker below). Theme is required to
  // submit when the event offers themes — see `abstract-theme-requirement`.
  const { data: themes = [] } = useAbstractThemes(eventId) as { data: Array<{ id: string }> };

  const [editData, setEditData] = useState({
    title: (abstract.title as string) || "",
    content: stripHtml((abstract.content as string) || ""),
    specialty: (abstract.specialty as string) || "",
    presentationType: (abstract.presentationType as string) || "",
    trackId: (abstract.track as { id: string } | null)?.id || "",
    themeId: (abstract.theme as { id: string } | null)?.id || "",
    subThemeId: (abstract.subTheme as { id: string } | null)?.id || "",
    coAuthors: normalizeCoAuthors(abstract.coAuthors),
  });

  const { data: session } = useSession();
  const isSubmitter = session?.user?.role === "SUBMITTER";
  const { data: eventData } = useEvent(eventId);
  const contactEmail = (eventData as { emailFromAddress?: string | null } | undefined)?.emailFromAddress;

  const status = abstract.status as string;
  const abstractUpdatedAt = abstract.updatedAt as string;
  // Authors (submitters) can only edit a DRAFT — once submitted it's locked and
  // they must contact the organizer. Organizers/reviewers keep the broader set.
  const canEdit = isSubmitter ? status === "DRAFT" : editableStatuses.includes(status);
  const submitterLocked = isSubmitter && status !== "DRAFT";
  const contentWords = countWords(editData.content);
  const overWords = contentWords > MAX_ABSTRACT_WORDS;
  const speaker = abstract.speaker as {
    firstName: string;
    lastName: string;
    email: string;
    presenterAgreementAcceptedAt?: string | null;
  } | null;

  // Fetch aggregated reviewer feedback from the new submissions API so
  // submitters see a consolidated view of all reviewer notes + mean score.
  const { data: reviewData } = useQuery<{
    submissions: Array<{ reviewNotes: string | null; overallScore: number | null }>;
    aggregates: { count: number; meanOverall: number | null };
  }>({
    queryKey: ["abstract-submissions", abstractId],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/abstracts/${abstractId}/submissions`);
      if (!res.ok) return { submissions: [], aggregates: { count: 0, meanOverall: null } };
      return res.json();
    },
  });

  const reviewNotesJoined = (reviewData?.submissions ?? [])
    .map((s) => s.reviewNotes?.trim())
    .filter((n): n is string => !!n)
    .join("\n\n— — —\n\n");
  const reviewScore = reviewData?.aggregates.meanOverall ?? null;

  const updateMutation = useMutation({
    mutationFn: async (data: typeof editData & { status?: string; expectedUpdatedAt?: string }) => {
      const res = await fetch(`/api/events/${eventId}/abstracts/${abstractId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // W2-F8 — server returns 409 STALE_WRITE if a co-reviewer or
          // chair wrote since this edit page was opened.
          expectedUpdatedAt: data.expectedUpdatedAt,
          title: data.title,
          content: data.content,
          specialty: data.specialty || undefined,
          presentationType: data.presentationType || undefined,
          trackId: data.trackId || undefined,
          themeId: data.themeId || undefined,
          coAuthors: data.coAuthors,
          ...(data.status && { status: data.status }),
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        const e = new Error(err.error || "Failed to update abstract") as Error & { code?: string; status?: number };
        e.code = err.code;
        e.status = res.status;
        throw e;
      }
      return res.json();
    },
    onError: (error: Error & { code?: string; status?: number }) => {
      if (error.status === 409 && error.code === "STALE_WRITE") {
        toast.error(
          "This abstract was modified by someone else after you opened it. Reloading the latest version.",
        );
        queryClient.invalidateQueries({ queryKey: ["abstract", abstractId] });
        return;
      }
      toast.error(error.message);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.abstracts(eventId) });
      queryClient.invalidateQueries({ queryKey: ["abstract", abstractId] });
      toast.success("Abstract updated");
      router.push(`/events/${eventId}/abstracts`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/events/${eventId}/abstracts/${abstractId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete abstract");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.abstracts(eventId) });
      toast.success("Abstract deleted");
      router.push(`/events/${eventId}/abstracts`);
    },
    onError: () => toast.error("Failed to delete abstract"),
  });

  const isPending = updateMutation.isPending || deleteMutation.isPending;

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href={`/events/${eventId}/abstracts`}>
          <Button variant="ghost" size="icon" className="shrink-0">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <FileText className="h-6 w-6 text-primary" />
            {canEdit ? "Edit Abstract" : "View Abstract"}
          </h1>
          <div className="flex items-center gap-2 mt-1">
            {abstract.serialId != null && (
              <span className="font-mono text-sm text-muted-foreground">
                {formatAbstractSerial(abstract.serialId as number)}
              </span>
            )}
            <Badge className={abstractStatusColor(status)} variant="outline">
              {abstractStatusLabel(status)}
            </Badge>
            {(abstract.presentationType as string) && (
              <Badge variant="secondary" className="text-xs">
                {PRESENTATION_TYPE_LABELS[abstract.presentationType as keyof typeof PRESENTATION_TYPE_LABELS] ?? (abstract.presentationType as string)}
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">
              Submitted {formatDate(abstract.submittedAt as string)}
            </span>
          </div>
        </div>
      </div>

      {/* Review feedback */}
      {reviewNotesJoined && (
        <Card className={status === "REVISION_REQUESTED" ? "border-orange-300 bg-orange-50/50" : "border-green-300 bg-green-50/50"}>
          <CardContent className="pt-5 pb-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-2">
              Reviewer Feedback
              {reviewData && reviewData.aggregates.count > 1 && (
                <span className="ml-2 text-xs font-normal text-slate-500">
                  ({reviewData.aggregates.count} reviews)
                </span>
              )}
            </h3>
            <p className="text-sm text-slate-600 whitespace-pre-wrap">{reviewNotesJoined}</p>
            {reviewScore != null && (
              <p className="text-sm text-slate-500 mt-2">
                Mean score: <span className="font-semibold">{reviewScore}/100</span>
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Form */}
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <Card>
            <CardContent className="pt-6 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="title" className="text-sm font-semibold">
                  Abstract Title <span className="text-red-400">*</span>
                </Label>
                <Input
                  id="title"
                  value={editData.title}
                  onChange={(e) => setEditData({ ...editData, title: e.target.value })}
                  placeholder="Enter your abstract title"
                  className="text-base h-12 font-medium"
                  disabled={!canEdit}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6 space-y-2">
              <Label htmlFor="editContent" className="text-sm font-semibold">
                Abstract Content <span className="text-red-400">*</span>
              </Label>
              <Textarea
                id="editContent"
                value={editData.content}
                onChange={(e) => setEditData({ ...editData, content: e.target.value })}
                rows={16}
                className="resize-y min-h-[300px] text-base leading-relaxed"
                disabled={!canEdit}
              />
              <p className={`text-xs text-right ${overWords ? "text-red-500 font-medium" : "text-muted-foreground"}`}>
                {contentWords} / {MAX_ABSTRACT_WORDS} words
                {overWords && " — over the limit"}
              </p>
            </CardContent>
          </Card>

          {/* Co-authors */}
          <Card>
            <CardContent className="pt-6">
              <CoAuthorFields
                value={editData.coAuthors}
                onChange={(coAuthors) => setEditData({ ...editData, coAuthors })}
                disabled={!canEdit}
              />
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {canEdit && (
            <Card className="border-primary/20 bg-primary/[0.02]">
              <CardContent className="pt-5 space-y-3">
                {status === "DRAFT" && (
                  <Button
                    className="w-full btn-gradient font-semibold h-11"
                    disabled={isPending || overWords || !editData.presentationType}
                    onClick={() => {
                      if (!editData.presentationType) {
                        toast.error("Please select a presentation type to submit");
                        return;
                      }
                      if (isThemeMissing(themes.length > 0, editData.themeId)) {
                        toast.error(THEME_REQUIRED_MESSAGE);
                        return;
                      }
                      if (isSubThemeMissing(subThemesOf(themes, editData.themeId).length > 0, editData.subThemeId)) {
                        toast.error(SUB_THEME_REQUIRED_MESSAGE);
                        return;
                      }
                      updateMutation.mutate({ ...editData, status: "SUBMITTED", expectedUpdatedAt: abstractUpdatedAt });
                    }}
                  >
                    {updateMutation.isPending ? (
                      <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Submitting…</>
                    ) : (
                      <><Send className="mr-2 h-4 w-4" /> Submit for Review</>
                    )}
                  </Button>
                )}
                <Button
                  variant={status === "DRAFT" ? "outline" : "default"}
                  className={status !== "DRAFT" ? "w-full btn-gradient font-semibold h-11" : "w-full"}
                  disabled={isPending || overWords}
                  onClick={() => updateMutation.mutate({ ...editData, expectedUpdatedAt: abstractUpdatedAt })}
                >
                  <Save className="mr-2 h-4 w-4" />
                  {updateMutation.isPending ? "Saving…" : "Save Changes"}
                </Button>
                {status === "DRAFT" && (
                  <Button
                    variant="outline"
                    className="w-full text-red-600 hover:bg-red-50"
                    disabled={isPending}
                    onClick={() => {
                      if (confirm("Delete this abstract? This cannot be undone.")) {
                        deleteMutation.mutate();
                      }
                    }}
                  >
                    <Trash2 className="mr-2 h-4 w-4" /> Delete Draft
                  </Button>
                )}
                {["SUBMITTED", "REVISION_REQUESTED"].includes(status) && (
                  <Button
                    variant="outline"
                    className="w-full text-gray-500 hover:bg-gray-50"
                    disabled={isPending}
                    onClick={() => {
                      if (confirm("Withdraw this abstract? You can contact the organiser to reverse this.")) {
                        updateMutation.mutate({ ...editData, status: "WITHDRAWN", expectedUpdatedAt: abstractUpdatedAt });
                      }
                    }}
                  >
                    Withdraw Abstract
                  </Button>
                )}
                <p className="text-[11px] text-muted-foreground text-center leading-relaxed">
                  {status === "DRAFT"
                    ? "Save as draft or submit when ready."
                    : status === "REVISION_REQUESTED"
                      ? "Address the reviewer feedback and resubmit."
                      : "Save your changes."}
                </p>
              </CardContent>
            </Card>
          )}

          {submitterLocked && (
            <Card className="border-amber-200 bg-amber-50/50">
              <CardContent className="pt-5 space-y-2">
                <h3 className="text-sm font-semibold text-amber-900">Abstract submitted</h3>
                <p className="text-xs text-amber-800 leading-relaxed">
                  This abstract has been submitted and can no longer be edited or withdrawn here.
                  To request a change or withdrawal, please contact the organizer team
                  {contactEmail ? (
                    <> at <a href={`mailto:${contactEmail}`} className="font-medium underline">{contactEmail}</a></>
                  ) : null}
                  .
                </p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="pt-5 space-y-4">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Details</h3>

              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Presentation Type <span className="text-red-400">*</span></Label>
                <Select
                  value={editData.presentationType}
                  onValueChange={(value) => setEditData({ ...editData, presentationType: value })}
                  disabled={!canEdit}
                >
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Only the types this event offers — but an abstract's
                        existing type stays selectable even if the organizer
                        later disabled it (annotated in the label). */}
                    {enabledPresentationTypeOptions((eventData as { settings?: unknown } | undefined)?.settings, (abstract.presentationType as string | null) ?? null).map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5 overflow-visible">
                <Label className="text-xs font-medium">Specialty</Label>
                <SpecialtySelect
                  value={editData.specialty}
                  onChange={(specialty) => setEditData({ ...editData, specialty })}
                />
              </div>

              {tracks.length > 0 && (
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Track</Label>
                  <Select
                    value={editData.trackId}
                    onValueChange={(value) => setEditData({ ...editData, trackId: value })}
                    disabled={!canEdit}
                  >
                    <SelectTrigger className="h-9 text-sm">
                      <SelectValue placeholder="Select track" />
                    </SelectTrigger>
                    <SelectContent>
                      {tracks.map((track) => (
                        <SelectItem key={track.id} value={track.id}>
                          <div className="flex items-center gap-2">
                            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: track.color }} />
                            {track.name}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Theme */}
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">
                  Theme {themes.length > 0 && <span className="text-red-500">*</span>}
                </Label>
                <AbstractThemeSelect
                  eventId={eventId}
                  required={themes.length > 0}
                  value={editData.themeId || null}
                  onChange={(v) => setEditData({ ...editData, themeId: v ?? "", subThemeId: "" })}
                  disabled={!canEdit}
                />
              </div>

              {subThemesOf(themes, editData.themeId).length > 0 && (
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">
                    Sub-theme <span className="text-red-500">*</span>
                  </Label>
                  <AbstractSubThemeSelect
                    eventId={eventId}
                    themeId={editData.themeId || null}
                    value={editData.subThemeId || null}
                    onChange={(v) => setEditData({ ...editData, subThemeId: v ?? "" })}
                    disabled={!canEdit}
                  />
                </div>
              )}

              {speaker && (
                <div className="pt-3 border-t">
                  <p className="text-xs text-muted-foreground">Speaker</p>
                  <p className="text-sm font-medium">{speaker.firstName} {speaker.lastName}</p>
                  <p className="text-xs text-muted-foreground">{speaker.email}</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Per-abstract reviewer assignment (admin/organizer only — the
              card self-hides for submitters). */}
          <AbstractReviewersCard eventId={eventId} abstractId={abstractId} />

          {speaker && (
            <PresenterAgreementCard
              eventId={eventId}
              abstractId={abstractId}
              authorName={`${speaker.firstName} ${speaker.lastName}`.trim()}
              authorEmail={speaker.email}
              acceptedAt={speaker.presenterAgreementAcceptedAt ?? null}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default function EditAbstractPage() {
  const params = useParams();
  const eventId = params.eventId as string;
  const abstractId = params.abstractId as string;
  // Profile hard gate: an incomplete-profile submitter is sent to My Details
  // first (with a return link back here) — a DRAFT can't be submitted until
  // the details are filled. Staff/reviewers unaffected.
  useSubmitterProfileGate(eventId);

  const { data: tracksData = [] } = useTracks(eventId);
  const tracks = tracksData as Track[];

  const { data: abstract, isLoading, isError, error, refetch } = useQuery<{
    id: string;
    updatedAt: string;
    title: string;
    content: string;
    status: string;
    specialty: string | null;
    presentationType: string | null;
    trackId: string | null;
    themeId: string | null;
  }>({
    queryKey: ["abstract", abstractId],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/abstracts/${abstractId}`);
      if (!res.ok) {
        // Carry the status so the render below can tell "this is gone" from
        // "this failed" — they need different words and different retries.
        throw new ApiError(
          res.status === 404 ? "Abstract not found" : "Failed to fetch abstract",
          res.status,
        );
      }
      return res.json();
    },
    // A 404 is an answer, not a failure: retrying it just repeats the same
    // request against a row that does not exist. Retry the rest twice.
    retry: (failureCount, err) =>
      !(err instanceof ApiError && err.status === 404) && failureCount < 2,
  });

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // Previously this fell through to the spinner on ANY error, so a deleted or
  // inaccessible abstract span forever while React Query re-fetched on every
  // window focus — a loading state that can never end reads as a hung page.
  if (isError || !abstract) {
    const gone = error instanceof ApiError && error.status === 404;
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <h1 className="text-lg font-semibold">
          {gone ? "This abstract no longer exists" : "Couldn't load this abstract"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {gone
            ? "It may have been deleted, or the link may be out of date. Nothing else has changed."
            : "Something went wrong fetching it. Your work is safe — please try again."}
        </p>
        <div className="mt-6 flex justify-center gap-2">
          {!gone && (
            <Button variant="outline" onClick={() => refetch()}>
              Try again
            </Button>
          )}
          <Button asChild>
            <Link href={`/events/${eventId}/abstracts`}>Back to abstracts</Link>
          </Button>
        </div>
      </div>
    );
  }

  return <EditForm abstract={abstract} eventId={eventId} abstractId={abstractId} tracks={tracks} />;
}
