"use client";

/**
 * Deal detail — the record of what actually happened on a deal.
 *
 * Notes are the reason this sheet exists. Everything else in EA-SYS's activity
 * trail is derived (emails sent, fields changed); a note is a human saying "I
 * called them, they want Gold, decision after the board meets". It is the one thing
 * no automated sync can produce, and it is why the pipeline is worth more than a
 * spreadsheet.
 *
 * A note may only be edited by its author, so we render the delete affordance only
 * where it will actually be honoured — offering a button that always 403s is worse
 * than offering none.
 */
import { useState } from "react";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { Archive, ArchiveRestore, Building2, CalendarDays, Loader2, Pencil, Phone, Trash2, Users } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  ACTIVITY_TYPE_LABELS,
  DEAL_CONTACT_ROLE_LABELS,
  DEAL_STATUS_COLORS,
  formatDealValue,
  personName,
  type CrmActivityType,
  type CrmBoardDeal,
  type CrmDealContactRole,
} from "@/crm/lib/crm-types";
import {
  useAddDealContact,
  useCloseDeal,
  useCreateNote,
  useCreateTask,
  useCrmContacts,
  useCrmNotes,
  useDeleteNote,
  useRemoveDealContact,
  useSetDealArchived,
} from "@/crm/hooks/use-crm-api";
import { canDeleteCrm } from "@/crm/lib/crm-roles";
import { CrmActivityTimeline } from "@/crm/components/crm-activity-timeline";
import { EditDealDialog } from "@/crm/components/edit-deal-dialog";

export function DealDetailSheet({
  deal,
  onOpenChange,
  canWrite,
}: {
  deal: CrmBoardDeal | null;
  onOpenChange: (open: boolean) => void;
  canWrite: boolean;
}) {
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const canDelete = canDeleteCrm(session?.user?.role);

  const [noteBody, setNoteBody] = useState("");
  const [noteType, setNoteType] = useState<CrmActivityType>("NOTE");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDue, setTaskDue] = useState("");
  const [lostReason, setLostReason] = useState("");
  const [closing, setClosing] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const { data: notes = [], isLoading: notesLoading } = useCrmNotes(
    deal ? { dealId: deal.id } : {},
  );
  const createNote = useCreateNote();
  const deleteNote = useDeleteNote();
  const createTask = useCreateTask();
  const closeDeal = useCloseDeal(deal?.id ?? "");
  const setArchived = useSetDealArchived(deal?.id ?? "");

  if (!deal) return null;

  const value = formatDealValue(deal.dealValue, deal.currency);
  const isClosed = deal.status !== "OPEN";

  async function handleAddNote() {
    if (!noteBody.trim() || !deal) return;
    await createNote.mutateAsync({ body: noteBody.trim(), activityType: noteType, dealId: deal.id });
    setNoteBody("");
    setNoteType("NOTE");
  }

  async function handleAddTask() {
    if (!taskTitle.trim() || !deal) return;
    await createTask.mutateAsync({
      title: taskTitle.trim(),
      dealId: deal.id,
      dueAt: taskDue || null,
      // Default the reminder to the due date — a follow-up with a deadline and no
      // reminder is a follow-up you will miss.
      remindAt: taskDue || null,
    });
    toast.success("Follow-up added");
    setTaskTitle("");
    setTaskDue("");
  }

  async function handleClose(outcome: "WON" | "LOST") {
    if (!deal) return;
    setClosing(true);
    try {
      await closeDeal.mutateAsync({
        outcome,
        lostReason: outcome === "LOST" ? lostReason.trim() || null : null,
      });
      toast.success(outcome === "WON" ? "Deal won 🎉" : "Deal marked lost");
      setLostReason("");
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not close the deal");
    } finally {
      setClosing(false);
    }
  }

  return (
    <Sheet open={!!deal} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="pr-8">{deal.name}</SheetTitle>
          <SheetDescription asChild>
            <span className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={DEAL_STATUS_COLORS[deal.status]}>
                {deal.status}
              </Badge>
              {deal.event && <Badge variant="outline">{deal.event.name}</Badge>}
              {deal.archivedAt && (
                <Badge variant="outline" className="bg-rose-100 text-rose-700 border-rose-200">
                  Archived
                </Badge>
              )}
            </span>
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-6 px-4 pb-8">
          {/* ── Record actions ──────────────────────────────────────────── */}
          {(canWrite || canDelete) && (
            <div className="flex flex-wrap items-center gap-2">
              {canWrite && (
                <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
                  <Pencil className="mr-2 h-3.5 w-3.5" />
                  Edit
                </Button>
              )}
              {canDelete &&
                (deal.archivedAt ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={setArchived.isPending}
                    onClick={() => setArchived.mutate(false)}
                  >
                    <ArchiveRestore className="mr-2 h-3.5 w-3.5" />
                    Restore
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive hover:text-destructive"
                    disabled={setArchived.isPending}
                    onClick={() => {
                      if (!confirm("Archive this deal? It will be hidden from the board and the reports. You can restore it from the archived view.")) return;
                      setArchived.mutate(true, { onSuccess: () => onOpenChange(false) });
                    }}
                  >
                    <Archive className="mr-2 h-3.5 w-3.5" />
                    Archive
                  </Button>
                ))}
            </div>
          )}
          {/* ── Summary ─────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-4 rounded-lg border p-4">
            <Field label="Value">
              {/* Redacted for MEMBER — an em dash, not a fake zero. */}
              {value ?? <span className="text-muted-foreground">—</span>}
            </Field>
            <Field label="Owner">{personName(deal.owner)}</Field>
            <Field label="Company">
              {deal.company ? (
                <span className="flex items-center gap-1">
                  <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                  {deal.company.name}
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </Field>
            <Field label="Expected close">
              {deal.expectedClose ? (
                new Date(deal.expectedClose).toLocaleDateString()
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </Field>
            {deal.status === "LOST" && deal.lostReason && (
              <div className="col-span-2">
                <Field label="Lost because">{deal.lostReason}</Field>
              </div>
            )}
          </div>

          {/* ── Close ───────────────────────────────────────────────────── */}
          {canWrite && !isClosed && (
            <div className="space-y-3 rounded-lg border p-4">
              <p className="text-sm font-medium">Close this deal</p>
              <Input
                placeholder="Reason (if lost)"
                value={lostReason}
                onChange={(e) => setLostReason(e.target.value)}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => handleClose("WON")}
                  disabled={closing}
                  className="flex-1"
                >
                  {closing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Mark won
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleClose("LOST")}
                  disabled={closing}
                  className="flex-1"
                >
                  Mark lost
                </Button>
              </div>
            </div>
          )}

          <Separator />

          {/* ── Follow-up ───────────────────────────────────────────────── */}
          {canWrite && (
            <div className="space-y-3">
              <p className="flex items-center gap-2 text-sm font-medium">
                <CalendarDays className="h-4 w-4" />
                Add a follow-up
              </p>
              <div className="flex gap-2">
                <Input
                  placeholder="Chase Abbott about the Gold package"
                  value={taskTitle}
                  onChange={(e) => setTaskTitle(e.target.value)}
                />
                <Input
                  type="date"
                  className="w-40"
                  value={taskDue}
                  onChange={(e) => setTaskDue(e.target.value)}
                />
                <Button
                  size="sm"
                  onClick={handleAddTask}
                  disabled={!taskTitle.trim() || createTask.isPending}
                >
                  Add
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                A due date also sets the reminder — you&apos;ll get an email when it&apos;s due.
              </p>
            </div>
          )}

          <Separator />

          {/* ── Activity ────────────────────────────────────────────────── */}
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Phone className="h-4 w-4" />
              Activity
            </p>

            {canWrite && (
              <div className="space-y-2">
                <Textarea
                  rows={3}
                  placeholder="Called Dr Khan — wants the Gold tier, decision after their board meets."
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
                  <Button
                    size="sm"
                    onClick={handleAddNote}
                    disabled={!noteBody.trim() || createNote.isPending}
                  >
                    {createNote.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Log it
                  </Button>
                </div>
              </div>
            )}

            {notesLoading ? (
              <p className="py-4 text-sm text-muted-foreground">Loading activity…</p>
            ) : notes.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                Nothing logged yet.
              </p>
            ) : (
              <ul className="space-y-3">
                {notes.map((n) => {
                  // Only the author can edit or delete their own note — so only show
                  // the affordance to them. A button that always 403s is worse than
                  // no button.
                  const isAuthor = !!currentUserId && n.authorId === currentUserId;
                  return (
                    <li key={n.id} className="rounded-md border p-3">
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
                            className="text-muted-foreground hover:text-destructive"
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

          <Separator />

          {/* ── People on this deal ──────────────────────────────────────────
              A sponsorship deal is not negotiated with one human: there's the rep
              who wants it, the marketing lead who owns the budget, and the
              procurement officer who can veto it. Each carries the role they play
              ON THIS DEAL — the same rep can be PRIMARY here and INFLUENCER
              elsewhere, which is why the role lives on the link. */}
          <DealContacts deal={deal} canWrite={canWrite} />

          <Separator />

          {/* ── History (system change log) ─────────────────────────────── */}
          <CrmActivityTimeline entityType="DEAL" entityId={deal.id} />
        </div>
      </SheetContent>

      <EditDealDialog deal={deal} open={editOpen} onOpenChange={setEditOpen} />
    </Sheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="text-sm font-medium">{children}</div>
    </div>
  );
}


/**
 * The people on a deal.
 *
 * The picker is over CRM contacts (reps, procurement, marketing) — deliberately NOT
 * the event contact store. HCPs are a different population and live in a different
 * table; putting a doctor here would be a category error, and putting a rep in
 * THERE would push them into the HCP marketing mirror.
 */
function DealContacts({ deal, canWrite }: { deal: CrmBoardDeal; canWrite: boolean }) {
  const [picked, setPicked] = useState("");
  const [role, setRole] = useState<CrmDealContactRole>("PRIMARY");

  const { data: allContacts = [] } = useCrmContacts();
  const add = useAddDealContact(deal.id);
  const remove = useRemoveDealContact(deal.id);

  const onDeal = deal.contacts ?? [];
  const onDealIds = new Set(onDeal.map((c) => c.crmContact.id));
  const available = allContacts.filter((c) => !onDealIds.has(c.id));

  return (
    <div className="space-y-3">
      <p className="flex items-center gap-2 text-sm font-medium">
        <Users className="h-4 w-4" />
        People on this deal
      </p>

      {onDeal.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nobody linked yet — add the rep you&apos;re actually talking to.
        </p>
      ) : (
        <ul className="space-y-2">
          {onDeal.map(({ crmContact, role: r }) => (
            <li
              key={crmContact.id}
              className="flex items-center justify-between gap-2 rounded-md border p-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {crmContact.firstName} {crmContact.lastName}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {crmContact.jobTitle ? `${crmContact.jobTitle} · ` : ""}
                  {crmContact.email}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant="outline" className="text-[10px]">
                  {DEAL_CONTACT_ROLE_LABELS[r]}
                </Badge>
                {canWrite && (
                  <button
                    type="button"
                    aria-label={`Remove ${crmContact.firstName} from this deal`}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => remove.mutate(crmContact.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {canWrite && available.length > 0 && (
        <div className="flex items-center gap-2">
          <Select value={picked} onValueChange={setPicked}>
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="Add a contact…" />
            </SelectTrigger>
            <SelectContent>
              {available.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.firstName} {c.lastName}
                  {c.company ? ` — ${c.company.name}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={role} onValueChange={(v) => setRole(v as CrmDealContactRole)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(DEAL_CONTACT_ROLE_LABELS) as CrmDealContactRole[]).map((r) => (
                <SelectItem key={r} value={r}>
                  {DEAL_CONTACT_ROLE_LABELS[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            size="sm"
            disabled={!picked || add.isPending}
            onClick={() => {
              add.mutate({ crmContactId: picked, role });
              setPicked("");
            }}
          >
            Add
          </Button>
        </div>
      )}
    </div>
  );
}
