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
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import {
  useSpeakers,
  useSessionProposalThemes,
  useCreateSessionProposal,
  useUpdateSessionProposal,
} from "@/hooks/use-api";
import { SESSION_TYPE_KIND, SESSION_TYPE_LABELS } from "@/lib/session-enums";
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

const PROGRAM_FORMATS = (Object.keys(SESSION_TYPE_KIND) as Array<keyof typeof SESSION_TYPE_KIND>).filter(
  (t) => SESSION_TYPE_KIND[t] === "program",
);

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
  const router = useRouter();
  const searchParams = useSearchParams();
  const editId = searchParams.get("edit");
  const { data: session } = useSession();
  const isSubmitter = session?.user?.role === "SUBMITTER";

  const { data: speakers = [] } = useSpeakers(eventId);
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
  const saving = createProposal.isPending || updateProposal.isPending;

  const save = (status: "DRAFT" | "SUBMITTED") => {
    const resolvedSpeakerId = isSubmitter ? mySpeaker?.id : speakerId;
    if (!resolvedSpeakerId) {
      toast.error(isSubmitter ? "Your speaker profile couldn't be found for this event." : "Select a proposer.");
      return;
    }
    if (!title.trim() || !description.trim()) {
      toast.error("Title and description are required.");
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
      toast.success(status === "SUBMITTED" ? "Proposal submitted!" : "Draft saved");
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
          status,
        },
        { onSuccess, onError },
      );
    } else {
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
      ) : editLocked ? (
        <Card className="border-amber-200 bg-amber-50/50">
          <CardContent className="py-8 text-sm text-amber-800">
            This proposal has been submitted and can no longer be edited. Contact the organizing team for changes.
          </CardContent>
        </Card>
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
                <Label htmlFor="proposal-description">Description <span className="text-red-500">*</span></Label>
                <Textarea
                  id="proposal-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What the session covers, why it matters for this audience, and how it would run."
                  rows={8}
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
                <div className="space-y-1.5">
                  <Label>Format</Label>
                  <Select value={format} onValueChange={setFormat}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Format" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Not sure yet</SelectItem>
                      {PROGRAM_FORMATS.map((f) => (
                        <SelectItem key={f} value={f}>{SESSION_TYPE_LABELS[f]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
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

          <div className="flex items-center gap-2">
            <Button onClick={() => save("SUBMITTED")} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Submit Proposal
            </Button>
            <Button variant="outline" onClick={() => save("DRAFT")} disabled={saving}>
              Save as Draft
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            After you submit, the proposal is locked for editing — the organizing team will contact you about changes
            and next steps.
          </p>
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
