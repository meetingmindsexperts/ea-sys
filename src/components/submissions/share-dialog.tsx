"use client";

/**
 * The organiser's "Share" dialog for abstracts and session proposals (Sep 29,
 * 2026; docs/SUBMISSION_SHARE_PLAN.md). Draws its checkboxes from the shared
 * catalogue in src/lib/submission-share.ts, so the dialog, the save route and
 * the public route can never disagree about what a field is.
 *
 * Contact details sit in their own amber group, and switching one on asks for
 * confirmation first (owner ruling D3: allowed, never by accident).
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Copy, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import {
  SHAREABLE_STATUSES,
  SHARE_FIELDS,
  SHARE_KIND_LABEL,
  type FieldGroup,
  type ShareKind,
} from "@/lib/submission-share";
import {
  useRegenerateSubmissionShare,
  useSaveSubmissionShare,
  useSubmissionShares,
  type SubmissionShareLinkView,
} from "@/hooks/use-api";

const GROUP_TITLE: Record<FieldGroup, string> = {
  submission: "Submission",
  people: "People",
  contact: "Contact details",
};

interface Props {
  eventId: string;
  kind: ShareKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SubmissionShareDialog({ eventId, kind, open, onOpenChange }: Props) {
  const { data: links, isLoading } = useSubmissionShares(eventId, open);
  const link = links?.find((l) => l.kind === kind);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-4 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent border-b">
          <DialogTitle>Share {SHARE_KIND_LABEL[kind].toLowerCase()}</DialogTitle>
          <DialogDescription>
            A read-only page anyone with the link can open. It updates live. The export still has every column.
          </DialogDescription>
        </DialogHeader>
        {isLoading || !link ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          // Keyed on the stored version: the draft starts from the saved
          // settings on every opening and after every save, with no effect
          // copying props into state.
          <ShareForm key={`${link.path ?? "new"}:${link.updatedAt ?? ""}`} eventId={eventId} kind={kind} link={link} onClose={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ShareForm({
  eventId,
  kind,
  link,
  onClose,
}: {
  eventId: string;
  kind: ShareKind;
  link: SubmissionShareLinkView;
  onClose: () => void;
}) {
  const save = useSaveSubmissionShare(eventId);
  const regenerate = useRegenerateSubmissionShare(eventId);

  const [enabled, setEnabled] = useState(link.exists ? link.enabled : true);
  const [statuses, setStatuses] = useState<string[]>(link.statuses);
  const [fields, setFields] = useState<string[]>(link.fields);
  const [pendingContact, setPendingContact] = useState<string | null>(null);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);

  const catalogue = SHARE_FIELDS[kind];
  const url = link.path && typeof window !== "undefined" ? `${window.location.origin}${link.path}` : null;
  const label = SHARE_KIND_LABEL[kind].toLowerCase();

  const shownLabels = useMemo(
    () => ["Number", "Title", ...catalogue.filter((f) => fields.includes(f.key)).map((f) => f.label)],
    [catalogue, fields],
  );
  const contactOn = catalogue.some((f) => f.group === "contact" && fields.includes(f.key));

  const toggleField = (key: string, group: FieldGroup, checked: boolean) => {
    if (checked && group === "contact") {
      setPendingContact(key);
      return;
    }
    setFields((cur) => (checked ? [...cur, key] : cur.filter((k) => k !== key)));
  };

  const toggleStatus = (value: string, checked: boolean) =>
    setStatuses((cur) => (checked ? [...cur, value] : cur.filter((s) => s !== value)));

  const onSave = async () => {
    if (statuses.length === 0) {
      toast.error("Choose at least one status to show.");
      return;
    }
    try {
      await save.mutateAsync({ kind, enabled, statuses, fields });
      toast.success(link.exists ? "Shared link updated" : "Shared link created");
    } catch (err) {
      console.error("[submission-share] save failed", err);
      toast.error(err instanceof Error ? err.message : "Could not save the shared link");
    }
  };

  const onRegenerate = async () => {
    setConfirmRegenerate(false);
    try {
      await regenerate.mutateAsync(kind);
      toast.success("New link created. The old link no longer works.");
    } catch (err) {
      console.error("[submission-share] regenerate failed", err);
      toast.error(err instanceof Error ? err.message : "Could not regenerate the link");
    }
  };

  const copy = () => {
    if (!url) return;
    navigator.clipboard
      .writeText(url)
      .then(() => toast.success("Link copied"))
      .catch((err) => {
        console.error("[submission-share] copy failed", err);
        toast.error("Couldn't copy the link");
      });
  };

  const pendingField = catalogue.find((f) => f.key === pendingContact);

  return (
    <>
            <div className="px-6 py-5 space-y-5">
              {/* Link */}
              <section className="rounded-lg border bg-muted/40 p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">Link is {enabled ? "on" : "off"}</p>
                    <p className="text-xs text-muted-foreground">
                      {enabled ? "Anyone with the link can view." : "The link shows a \"no longer active\" message."}
                    </p>
                  </div>
                  <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Link on or off" />
                </div>
                {url ? (
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      readOnly
                      value={url}
                      onFocus={(e) => e.currentTarget.select()}
                      className="flex-1 min-w-0 rounded-md border bg-background px-3 py-1.5 text-xs font-mono"
                      aria-label="Shared link"
                    />
                    <div className="flex gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={copy}>
                        <Copy className="h-4 w-4 mr-1" /> Copy
                      </Button>
                      <Button type="button" variant="outline" size="sm" asChild>
                        <a href={url} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="h-4 w-4 mr-1" /> Open
                        </a>
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setConfirmRegenerate(true)}
                        disabled={regenerate.isPending}
                      >
                        <RefreshCw className={cn("h-4 w-4 mr-1", regenerate.isPending && "animate-spin")} /> New link
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">The link is created when you save.</p>
                )}
                {link.updatedAt && (
                  <p className="text-xs text-muted-foreground">
                    Last changed {new Date(link.updatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
                    {link.updatedByName ? ` by ${link.updatedByName}` : ""}
                  </p>
                )}
              </section>

              {/* Statuses */}
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Which {label} appear</h3>
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {SHAREABLE_STATUSES[kind].map((s) => (
                    <label key={s.value} className="flex items-center gap-2 text-sm cursor-pointer">
                      <Checkbox
                        checked={statuses.includes(s.value)}
                        onCheckedChange={(v) => toggleStatus(s.value, v === true)}
                      />
                      {s.label}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">Drafts and withdrawn {label} never appear.</p>
              </section>

              {/* Fields */}
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">What viewers see</h3>
                <p className="text-xs text-muted-foreground">Number and title are always shown. Reviews and scores never are.</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {(["submission", "people"] as const).map((group) => (
                    <div key={group} className="rounded-lg border bg-muted/30 p-3 space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{GROUP_TITLE[group]}</p>
                      {catalogue
                        .filter((f) => f.group === group)
                        .map((f) => (
                          <label key={f.key} className="flex items-center gap-2 text-sm cursor-pointer">
                            <Checkbox
                              checked={fields.includes(f.key)}
                              onCheckedChange={(v) => toggleField(f.key, f.group, v === true)}
                            />
                            {f.label}
                          </label>
                        ))}
                    </div>
                  ))}
                </div>
                <div className={cn("rounded-lg border p-3 space-y-2", contactOn ? "border-amber-300 bg-amber-50" : "border-amber-200/70 bg-amber-50/40")}>
                  <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-800">
                    <AlertTriangle className="h-3.5 w-3.5" /> {GROUP_TITLE.contact}
                  </p>
                  <p className="text-xs text-amber-900/80">Off by default. Everyone with the link would see these.</p>
                  {catalogue
                    .filter((f) => f.group === "contact")
                    .map((f) => (
                      <label key={f.key} className="flex items-center gap-2 text-sm cursor-pointer">
                        <Checkbox
                          checked={fields.includes(f.key)}
                          onCheckedChange={(v) => toggleField(f.key, f.group, v === true)}
                        />
                        {f.label}
                      </label>
                    ))}
                </div>
              </section>

              <p className="rounded-md bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Viewers will see: </span>
                {shownLabels.join(", ")}.
              </p>
            </div>

          <DialogFooter className="px-6 py-4 border-t bg-muted/30">
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button onClick={() => void onSave()} disabled={save.isPending}>
              {save.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {link.exists ? "Save changes" : "Create link"}
            </Button>
          </DialogFooter>

      <AlertDialog open={!!pendingContact} onOpenChange={(o) => !o && setPendingContact(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Show {pendingField?.label.toLowerCase()}?</AlertDialogTitle>
            <AlertDialogDescription>
              Everyone with this link will see it, including anyone the link is forwarded to. Who switched it on
              is recorded.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep hidden</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingContact) setFields((cur) => [...cur, pendingContact]);
                setPendingContact(null);
              }}
            >
              Show it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmRegenerate} onOpenChange={setConfirmRegenerate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Create a new link?</AlertDialogTitle>
            <AlertDialogDescription>
              Anyone using the old link loses access at once. You will need to send the new link again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onRegenerate()}>Create new link</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
