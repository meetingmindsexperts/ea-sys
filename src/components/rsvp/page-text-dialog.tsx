"use client";

/**
 * The words on an RSVP's own page, in the organiser's hands (owner, Nov 25, 2026: "give text boxes
 * for organizer to add" the question and the line under it, and "thank you text also").
 *
 * Four boxes: the note under the event's name (the create form's "Note for invitees"), the question,
 * the line under the question, and the message shown once the invitee has answered. For the last
 * three an empty box means the built-in wording, which the box shows as its placeholder
 * (question-wording.ts, the same words the page renders); an empty note shows no note.
 * The greeting "Thank you, Dr. Name!" above the message is the system's and is not edited here.
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  defaultRsvpQuestion,
  defaultRsvpQuestionHelp,
  defaultRsvpThankYou,
  RSVP_QUESTION_HELP_MAX,
  RSVP_QUESTION_MAX,
  RSVP_THANK_YOU_MAX,
} from "@/lib/rsvp/question-wording";

export interface RsvpPageText {
  name: string;
  description: string | null;
  questionText?: string | null;
  questionHelpText?: string | null;
  thankYouText?: string | null;
  selectionMode: "SINGLE" | "MULTI";
}

const DESCRIPTION_MAX = 2000;

type PageTextForm = { description: string; questionText: string; questionHelpText: string; thankYouText: string };

/** The boxes whose text differs from what the dialog opened with, trimmed as they will be stored. */
export function changedPageText(opened: PageTextForm, form: PageTextForm): Partial<PageTextForm> {
  const out: Partial<PageTextForm> = {};
  for (const key of ["description", "questionText", "questionHelpText", "thankYouText"] as const) {
    if (form[key].trim() !== opened[key].trim()) out[key] = form[key].trim();
  }
  return out;
}

export function RsvpPageTextDialog({
  open,
  onOpenChange,
  apiBase,
  campaign,
  manyItems,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `/api/events/{eventId}/rsvp-campaigns/{campaignId}` */
  apiBase: string;
  campaign: RsvpPageText;
  /** More than one option on offer: the built-in question reads differently then. */
  manyItems: boolean;
  onSaved: () => void | Promise<void>;
}) {
  // What the boxes opened with. Only a box the organiser changed is sent (review of 3b8d4f365): an
  // empty box means "clear it", so sending all four would wipe a text this dialog was never given,
  // and would undo a colleague's save made while this one was open.
  const [opened] = useState(() => ({
    description: campaign.description ?? "",
    questionText: campaign.questionText ?? "",
    questionHelpText: campaign.questionHelpText ?? "",
    thankYouText: campaign.thankYouText ?? "",
  }));
  const [form, setForm] = useState(opened);
  const [saving, setSaving] = useState(false);
  const single = campaign.selectionMode === "SINGLE";

  const save = async () => {
    const changed = changedPageText(opened, form);
    if (Object.keys(changed).length === 0) {
      onOpenChange(false);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(apiBase, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changed),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        console.error("rsvp-console:page-text-save-failed", res.status, json?.error);
        toast.error(json?.error || "Could not save the page text");
        return;
      }
    } catch (err) {
      console.error("rsvp-console:page-text-save-error", err);
      toast.error("Could not save the page text");
      return;
    } finally {
      setSaving(false);
    }
    // Saved: say so and close before the console reloads, so a failed reload is never read as a
    // failed save.
    toast.success("Page text saved");
    onOpenChange(false);
    await Promise.resolve(onSaved()).catch((err) => console.error("rsvp-console:reload-after-page-text-failed", err));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Page text</DialogTitle>
          <DialogDescription>
            The words invitees read on this RSVP&apos;s page. Leave the question, its line or the thank-you empty to use
            the wording shown in grey.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="rsvp-text-intro">Note for invitees</Label>
            <Textarea
              id="rsvp-text-intro"
              rows={3}
              maxLength={DESCRIPTION_MAX}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Shown under the event&apos;s name, above the form. Leave it empty to show no note.
            </p>
          </div>
          <div>
            <Label htmlFor="rsvp-text-question">Question</Label>
            <Input
              id="rsvp-text-question"
              maxLength={RSVP_QUESTION_MAX}
              value={form.questionText}
              onChange={(e) => setForm((f) => ({ ...f, questionText: e.target.value }))}
              placeholder={defaultRsvpQuestion(manyItems, single)}
            />
          </div>
          <div>
            <Label htmlFor="rsvp-text-help">Line under the question</Label>
            <Textarea
              id="rsvp-text-help"
              rows={2}
              maxLength={RSVP_QUESTION_HELP_MAX}
              value={form.questionHelpText}
              onChange={(e) => setForm((f) => ({ ...f, questionHelpText: e.target.value }))}
              placeholder={defaultRsvpQuestionHelp(manyItems, single)}
            />
          </div>
          <div>
            <Label htmlFor="rsvp-text-thanks">Thank-you message</Label>
            <Textarea
              id="rsvp-text-thanks"
              rows={3}
              maxLength={RSVP_THANK_YOU_MAX}
              value={form.thankYouText}
              onChange={(e) => setForm((f) => ({ ...f, thankYouText: e.target.value }))}
              placeholder={defaultRsvpThankYou(campaign.name)}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Shown after they submit, under &ldquo;Thank you, Dr. Name!&rdquo; (the greeting is written for you, with the
              person&apos;s title when the event knows it). The same message goes to people who accept and people who
              decline.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
