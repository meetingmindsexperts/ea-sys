"use client";

/**
 * Notes / calls / meetings log for ONE CRM record (deal, account or contact).
 *
 * Extracted from the deal page so the same card mounts on all three record
 * pages — the notes API always accepted companyId/crmContactId, but only the
 * deal page rendered a form over it (the "API exists, UI doesn't" gap).
 * One component = the cross-caller-duplication rule at UI scale.
 *
 * MONEY-GATED (CRM review M2): notes routinely quote deal numbers in prose, so
 * they follow the deal-values predicate, not the read gate — the server 403s a
 * money-blind MEMBER, and this card renders nothing for them (never a broken
 * fetch behind a visible panel).
 */
import { useState } from "react";
import { useSession } from "next-auth/react";
import { Loader2, Phone, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RecordCard } from "@/crm/components/record-layout";
import { canViewDealValues } from "@/crm/lib/crm-roles";
import { ACTIVITY_TYPE_LABELS, personName, type CrmActivityType } from "@/crm/lib/crm-types";
import { useCreateNote, useCrmNotes, useDeleteNote } from "@/crm/hooks/use-crm-api";

export function CrmNotesCard({
  attach,
  canWrite,
  title = "Activity",
  placeholder = "Called Dr Khan — wants the Gold tier, decision after their board meets.",
}: {
  /** Exactly one of dealId / companyId / crmContactId. */
  attach: { dealId?: string; companyId?: string; crmContactId?: string };
  canWrite: boolean;
  title?: string;
  placeholder?: string;
}) {
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const canSeeNotes = canViewDealValues(session?.user?.role);

  const { data: notes = [], isLoading: notesLoading } = useCrmNotes(attach, { enabled: canSeeNotes });
  const createNote = useCreateNote();
  const deleteNote = useDeleteNote();

  const [noteBody, setNoteBody] = useState("");
  const [noteType, setNoteType] = useState<CrmActivityType>("NOTE");

  if (!canSeeNotes) return null;

  async function handleAddNote() {
    if (!noteBody.trim()) return;
    try {
      await createNote.mutateAsync({ body: noteBody.trim(), activityType: noteType, ...attach });
    } catch {
      // Surfaced by the hook's onError toast; keep the typed note for a retry.
      return;
    }
    setNoteBody("");
    setNoteType("NOTE");
  }

  return (
    <RecordCard icon={Phone} title={title}>
      <div className="space-y-4">
        {canWrite && (
          <div className="space-y-2">
            <Textarea
              rows={3}
              placeholder={placeholder}
              value={noteBody}
              onChange={(e) => setNoteBody(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <Select value={noteType} onValueChange={(v) => setNoteType(v as CrmActivityType)}>
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(ACTIVITY_TYPE_LABELS) as CrmActivityType[]).map((t) => (
                    <SelectItem key={t} value={t}>
                      {ACTIVITY_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={handleAddNote} disabled={!noteBody.trim() || createNote.isPending}>
                {createNote.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Log it
              </Button>
            </div>
          </div>
        )}

        {notesLoading ? (
          <p className="py-2 text-sm text-muted-foreground">Loading activity…</p>
        ) : notes.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">Nothing logged yet.</p>
        ) : (
          <ul className="space-y-3">
            {notes.map((n) => {
              const isAuthor = !!currentUserId && n.authorId === currentUserId;
              return (
                <li key={n.id} className="rounded-lg border bg-muted/20 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">
                        {ACTIVITY_TYPE_LABELS[n.activityType]}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {n.author ? personName(n.author) : "(deleted user)"} ·{" "}
                        {new Date(n.createdAt).toLocaleString()}
                      </span>
                    </div>
                    {isAuthor && (
                      <button
                        type="button"
                        aria-label="Delete note"
                        className="text-muted-foreground transition-colors hover:text-destructive"
                        onClick={() => deleteNote.mutate(n.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm">{n.body}</p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </RecordCard>
  );
}
