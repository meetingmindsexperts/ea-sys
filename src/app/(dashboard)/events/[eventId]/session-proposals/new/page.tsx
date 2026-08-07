"use client";

/**
 * Propose a Session — full-page submit form (abstracts/new shape), also the
 * DRAFT edit surface via ?edit=<proposalId> (submitters may edit ONLY while
 * DRAFT — the server enforces SUBMITTED_LOCKED; this page mirrors it).
 * SUBMITTERs are auto-bound to their own Speaker record; org staff pick the
 * proposer from the speaker list. See docs/SESSION_PROPOSALS_PLAN.md.
 */

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useSubmitterSurfaceGuard } from "@/hooks/use-submitter-surface-guard";
import { useSubmitterProfileGate } from "@/hooks/use-submitter-profile-gate";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import {
  useEvent,
  useSpeakers,
  useSessionProposalThemes,
  useCreateSessionProposal,
  useUpdateSessionProposal,
} from "@/hooks/use-api";
import { isDeadlinePassed, readSessionProposalDeadline } from "@/lib/submission-deadline";
import { MAX_PROPOSAL_DESCRIPTION_CHARS } from "@/lib/session-proposal-content";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Lightbulb, Loader2 } from "lucide-react";

const NONE = "__none__";

interface SpeakerRow {
  id: string;
  userId: string | null;
  firstName: string;
  lastName: string;
  email: string;
}

function ProposalForm() {
  const params = useParams<{ eventId: string }>();
  const eventId = params.eventId;
  // Surface separation: bounce a submitter whose signup flow doesn't cover
  // this surface (src/lib/submitter-surfaces.ts). No-op for staff.
  useSubmitterSurfaceGuard(eventId, "session-proposals");
  // Profile hard gate: an incomplete-profile submitter is sent to My Details
  // first (with a return link back here). Staff unaffected.
  useSubmitterProfileGate(eventId);
  const router = useRouter();
  const searchParams = useSearchParams();
  const editId = searchParams.get("edit");
  const { data: session } = useSession();
  const isSubmitter = session?.user?.role === "SUBMITTER";

  const { data: speakers = [] } = useSpeakers(eventId);
  const { data: event } = useEvent(eventId);
  // Deadline auto-end (Aug 6, 2026): after the deadline a SUBMITTER can no
  // longer create or submit — staff keep working normally. Editing an
  // existing draft stays possible (submission of it is what's blocked).
  const deadlinePassed =
    isSubmitter && isDeadlinePassed(readSessionProposalDeadline((event as { settings?: unknown } | undefined)?.settings));
  const { data: themes = [] } = useSessionProposalThemes(eventId);
  const createProposal = useCreateSessionProposal(eventId);
  const updateProposal = useUpdateSessionProposal(eventId);

  const mySpeaker = isSubmitter
    ? (speakers as SpeakerRow[]).find((s) => s.userId === session?.user?.id)
    : null;

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [themeId, setThemeId] = useState(NONE);
  const [format, setFormat] = useState(NONE);
  const [duration, setDuration] = useState("");
  const [speakerId, setSpeakerId] = useState("");
  const [loadedStatus, setLoadedStatus] = useState<string | null>(null);
  const [loadingEdit, setLoadingEdit] = useState(!!editId);

  // Edit mode: load the existing proposal once and populate the form.
  useEffect(() => {
    if (!editId) return;
    let cancelled = false;
    fetch(`/api/events/${eventId}/session-proposals/${editId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Failed to load proposal");
        return res.json();
      })
      .then((p) => {
        if (cancelled) return;
        setTitle(p.title ?? "");
        setDescription(p.description ?? "");
        setThemeId(p.theme?.id ?? NONE);
        setFormat(p.proposedFormat ?? NONE);
        setDuration(p.durationMinutes ? String(p.durationMinutes) : "");
        setSpeakerId(p.speaker?.id ?? "");
        setLoadedStatus(p.status ?? null);
      })
      .catch((err) => {
        console.error("session-proposal edit load failed", err);
        toast.error(err instanceof Error ? err.message : "Failed to load proposal");
      })
      .finally(() => { if (!cancelled) setLoadingEdit(false); });
    return () => { cancelled = true; };
  }, [editId, eventId]);

  const editLocked = !!editId && isSubmitter && loadedStatus !== null && loadedStatus !== "DRAFT";
  // Organizer/admin editing an existing proposal (Aug 4, 2026): saves KEEP the
  // current status — "Save as Draft" here would flip a SUBMITTED proposal to
  // DRAFT and make it vanish from the organizer list (drafts are
  // submitter-only by design).
  const isStaffEdit = !!editId && !isSubmitter;
  const saving = createProposal.isPending || updateProposal.isPending;

  const save = (status: "DRAFT" | "SUBMITTED" | "KEEP") => {
    const resolvedSpeakerId = isSubmitter ? mySpeaker?.id : speakerId;
    if (!resolvedSpeakerId) {
      toast.error(isSubmitter ? "Your speaker profile couldn't be found for this event." : "Select a proposer.");
      return;
    }
    if (!title.trim() || !description.trim()) {
      toast.error("Title and description are required.");
      return;
    }
    // `maxLength` only stops TYPING past the cap. A description loaded into
    // edit mode (or pasted before a future cap change) can still be over it,
    // so check the value rather than trusting the input attribute.
    if (description.length > MAX_PROPOSAL_DESCRIPTION_CHARS) {
      toast.error(
        `Description is ${description.length.toLocaleString()} characters. Please shorten it to ${MAX_PROPOSAL_DESCRIPTION_CHARS.toLocaleString()} or fewer.`,
      );
      return;
    }
    const durationMinutes = duration.trim() ? Number(duration) : undefined;
    if (durationMinutes !== undefined && (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 600)) {
      toast.error("Duration must be a whole number between 5 and 600 minutes.");
      return;
    }

    const onError = (err: unknown) => {
      console.error("session-proposal save failed", err);
      toast.error(err instanceof Error ? err.message : "Failed to save proposal");
    };
    const onSuccess = () => {
      toast.success(
        status === "SUBMITTED" ? "Proposal submitted!" : status === "DRAFT" ? "Draft saved" : "Proposal updated",
      );
      router.push(`/events/${eventId}/session-proposals`);
    };

    if (editId) {
      updateProposal.mutate(
        {
          proposalId: editId,
          title: title.trim(),
          description: description.trim(),
          themeId: themeId === NONE ? null : themeId,
          proposedFormat: format === NONE ? null : format,
          durationMinutes: durationMinutes ?? null,
          // KEEP (staff edit) omits status entirely so the PUT preserves it.
          ...(status !== "KEEP" ? { status } : {}),
        },
        { onSuccess, onError },
      );
    } else {
      if (status === "KEEP") return; // unreachable — create always picks a status
      createProposal.mutate(
        {
          speakerId: resolvedSpeakerId,
          title: title.trim(),
          description: description.trim(),
          ...(themeId !== NONE ? { themeId } : {}),
          ...(format !== NONE ? { proposedFormat: format } : {}),
          ...(durationMinutes !== undefined ? { durationMinutes } : {}),
          status,
        },
        { onSuccess, onError },
      );
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <Link
          href={`/events/${eventId}/session-proposals`}
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-2"
        >
          <ArrowLeft className="h-4 w-4" /> Back to session proposals
        </Link>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Lightbulb className="h-6 w-6 text-primary" />
          {editId ? "Edit Session Proposal" : "Propose a Session"}
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Suggest a session for this event — the organizing team will review your proposal and follow up.
        </p>
      </div>

      {loadingEdit ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading proposal…
        </div>
      ) : deadlinePassed && !editId ? (
        <Card className="border-amber-200 bg-amber-50/50">
          <CardContent className="py-8 text-sm text-amber-800">
            The session proposal deadline has passed — new proposals can no longer be
            submitted. Please contact the organizing team if you have a question.
          </CardContent>
        </Card>
      ) : editLocked ? (
        <div className="space-y-4">
          <Card className="border-amber-200 bg-amber-50/50">
            <CardContent className="py-6 text-sm text-amber-800">
              This proposal has been submitted and can no longer be edited. Contact the organizing team for changes.
            </CardContent>
          </Card>
          {/* Read-only view — "View Your Proposal" must actually show it
              (organizer-reported Aug 6, 2026). */}
          <Card>
            <CardContent className="pt-6 space-y-4 text-sm">
              <div>
                <div className="text-muted-foreground text-xs uppercase tracking-wide mb-1">Title</div>
                <div className="font-medium">{title || "—"}</div>
              </div>
              <div className="grid sm:grid-cols-3 gap-4">
                <div>
                  <div className="text-muted-foreground text-xs uppercase tracking-wide mb-1">Theme</div>
                  <div>{themes.find((t: { id: string; name: string }) => t.id === themeId)?.name ?? "—"}</div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs uppercase tracking-wide mb-1">Duration</div>
                  <div>{duration ? `${duration} min` : "—"}</div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs uppercase tracking-wide mb-1">Status</div>
                  <div>{loadedStatus ?? "—"}</div>
                </div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs uppercase tracking-wide mb-1">Description</div>
                <div className="whitespace-pre-wrap rounded-lg border p-4 bg-background">{description || "—"}</div>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : (
        <>
          {!isSubmitter && !editId && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Proposer</CardTitle>
              </CardHeader>
              <CardContent>
                <Select value={speakerId} onValueChange={setSpeakerId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select the proposing speaker" />
                  </SelectTrigger>
                  <SelectContent>
                    {(speakers as SpeakerRow[]).map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.firstName} {s.lastName} ({s.email})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Session Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="proposal-title">Session title <span className="text-red-500">*</span></Label>
                <Input
                  id="proposal-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Hands-on TAVR Workshop"
                  maxLength={500}
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <Label htmlFor="proposal-description">Description <span className="text-red-500">*</span></Label>
                  <span
                    className={`text-xs tabular-nums ${
                      description.length >= MAX_PROPOSAL_DESCRIPTION_CHARS
                        ? "text-amber-600"
                        : "text-muted-foreground"
                    }`}
                  >
                    {description.length.toLocaleString()} / {MAX_PROPOSAL_DESCRIPTION_CHARS.toLocaleString()}
                  </span>
                </div>
                <Textarea
                  id="proposal-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What the session covers, why it matters for this audience, and how it would run."
                  rows={16}
                  maxLength={MAX_PROPOSAL_DESCRIPTION_CHARS}
                  className="min-h-64 resize-y"
                />
              </div>
              <div className="grid sm:grid-cols-3 gap-4">
                {themes.length > 0 && (
                  <div className="space-y-1.5">
                    <Label>Theme</Label>
                    <Select value={themeId} onValueChange={setThemeId}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Theme" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>No theme</SelectItem>
                        {(themes as Array<{ id: string; name: string }>).map((t) => (
                          <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {/* Format picker removed (owner, Aug 4 2026 — "no need for
                    format"). The `format` state stays so editing an older
                    proposal preserves its stored value instead of wiping it. */}
                <div className="space-y-1.5">
                  <Label htmlFor="proposal-duration">Duration (minutes)</Label>
                  <Input
                    id="proposal-duration"
                    type="number"
                    min={5}
                    max={600}
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                    placeholder="e.g. 90"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {isStaffEdit ? (
            <>
              <div className="flex items-center gap-2">
                <Button onClick={() => save("KEEP")} disabled={saving}>
                  {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                  Save Changes
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Saves your edits without changing the proposal&apos;s status
                {loadedStatus ? ` (currently ${loadedStatus.toLowerCase()})` : ""}.
              </p>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                {!deadlinePassed && (
                  <Button onClick={() => save("SUBMITTED")} disabled={saving}>
                    {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                    Submit Proposal
                  </Button>
                )}
                <Button variant="outline" onClick={() => save("DRAFT")} disabled={saving}>
                  Save as Draft
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {deadlinePassed
                  ? "The submission deadline has passed — you can still save your draft, but it can no longer be submitted."
                  : "After you submit, the proposal is locked for editing — the organizing team will contact you about changes and next steps."}
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

export default function ProposalFormPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
        </div>
      }
    >
      <ProposalForm />
    </Suspense>
  );
}
