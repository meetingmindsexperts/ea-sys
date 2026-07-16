"use client";

/**
 * Deal detail — the body of the dedicated deal page (/crm/deals/[dealId]).
 *
 * Record-page layout: an identity header, then a two-column body — the main work
 * area (close, follow-ups, activity, history) and a sticky sidebar of key facts +
 * the people on the deal. `onClosed` navigates the page away after archive/close.
 *
 * Notes are the reason this view exists: a human saying "I called them, they want
 * Gold, decision after the board meets" — the one thing no automated sync produces.
 * A note may only be edited by its author, so the delete affordance shows only where
 * it will be honoured.
 */
import { useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import {
  Archive,
  ArchiveRestore,
  Building2,
  CalendarDays,
  Info,
  Loader2,
  Mail,
  Package,
  Pencil,
  Trash2,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DEAL_CONTACT_ROLE_LABELS,
  DEAL_STATUS_COLORS,
  formatDealValue,
  personName,
  type CrmBoardDeal,
  type CrmDealContactRole,
} from "@/crm/lib/crm-types";
import {
  useAddDealContact,
  useCloseDeal,
  useCreateTask,
  useCrmContacts,
  useRemoveDealContact,
  useSetDealArchived,
} from "@/crm/hooks/use-crm-api";
import { canDeleteCrm } from "@/crm/lib/crm-roles";
import { CrmActivityTimeline } from "@/crm/components/crm-activity-timeline";
import { CrmNotesCard } from "@/crm/components/crm-notes-card";
import { EditDealDialog } from "@/crm/components/edit-deal-dialog";
import { CrmEmailDialog } from "@/crm/components/crm-email-dialog";
import { DealProducts } from "@/crm/components/crm-deal-products";
import { RecordHeader, RecordGrid, RecordCard, Facts, Fact, Dash } from "@/crm/components/record-layout";

export function DealDetailBody({
  deal,
  canWrite,
  onClosed,
}: {
  deal: CrmBoardDeal;
  canWrite: boolean;
  /** Called after the deal is archived or closed (won/lost) — navigate away. */
  onClosed?: () => void;
}) {
  const { data: session } = useSession();
  const canDelete = canDeleteCrm(session?.user?.role);

  const [taskTitle, setTaskTitle] = useState("");
  const [taskDue, setTaskDue] = useState("");
  const [lostReason, setLostReason] = useState("");
  const [closing, setClosing] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);

  const createTask = useCreateTask();
  const closeDeal = useCloseDeal(deal.id);
  const setArchived = useSetDealArchived(deal.id);

  const value = formatDealValue(deal.dealValue, deal.currency);
  const isClosed = deal.status !== "OPEN";
  const contactCount = deal.contacts?.length ?? 0;

  async function handleAddTask() {
    if (!taskTitle.trim()) return;
    try {
      await createTask.mutateAsync({
        title: taskTitle.trim(),
        dealId: deal.id,
        dueAt: taskDue || null,
        remindAt: taskDue || null,
      });
    } catch {
      // Surfaced by the hook's onError toast; keep the typed title for a retry.
      return;
    }
    toast.success("Follow-up added");
    setTaskTitle("");
    setTaskDue("");
  }

  async function handleClose(outcome: "WON" | "LOST") {
    setClosing(true);
    try {
      await closeDeal.mutateAsync({
        outcome,
        lostReason: outcome === "LOST" ? lostReason.trim() || null : null,
      });
      toast.success(outcome === "WON" ? "Deal won 🎉" : "Deal marked lost");
      setLostReason("");
      onClosed?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not close the deal");
    } finally {
      setClosing(false);
    }
  }

  return (
    <div className="space-y-5">
      <RecordHeader
        title={deal.name}
        badges={
          <>
            <Badge variant="outline" className={DEAL_STATUS_COLORS[deal.status]}>
              {deal.status}
            </Badge>
            {deal.event && <Badge variant="outline">{deal.event.name}</Badge>}
            {deal.archivedAt && (
              <Badge variant="outline" className="border-rose-200 bg-rose-100 text-rose-700">
                Archived
              </Badge>
            )}
          </>
        }
        actions={
          (canWrite || canDelete) && (
            <>
              {canWrite && (
                <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
                  <Pencil className="mr-2 h-3.5 w-3.5" />
                  Edit
                </Button>
              )}
              {canWrite && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={contactCount === 0}
                  title={contactCount === 0 ? "Add a contact to this deal first" : "Email the people on this deal"}
                  onClick={() => setEmailOpen(true)}
                >
                  <Mail className="mr-2 h-3.5 w-3.5" />
                  Email
                </Button>
              )}
              {canDelete &&
                (deal.archivedAt ? (
                  <Button size="sm" variant="outline" disabled={setArchived.isPending} onClick={() => setArchived.mutate(false)}>
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
                      setArchived.mutate(true, { onSuccess: () => onClosed?.() });
                    }}
                  >
                    <Archive className="mr-2 h-3.5 w-3.5" />
                    Archive
                  </Button>
                ))}
            </>
          )
        }
      />

      <RecordGrid
        sidebar={
          <>
            <RecordCard icon={Info} title="Details">
              <Facts>
                <Fact label="Value">{value ?? <Dash />}</Fact>
                {deal.stage && <Fact label="Stage">{deal.stage.name}</Fact>}
                <Fact label="Owner">{personName(deal.owner)}</Fact>
                <Fact label="Company">
                  {deal.company ? (
                    <Link
                      href={`/crm/companies/${deal.company.id}`}
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      <Building2 className="h-3.5 w-3.5" />
                      {deal.company.name}
                    </Link>
                  ) : (
                    <Dash />
                  )}
                </Fact>
                <Fact label="Expected close">
                  {deal.expectedClose ? new Date(deal.expectedClose).toLocaleDateString() : <Dash />}
                </Fact>
                <Fact label="Created">{new Date(deal.createdAt).toLocaleDateString()}</Fact>
                {deal.status === "LOST" && deal.lostReason && (
                  <Fact label="Lost because">{deal.lostReason}</Fact>
                )}
              </Facts>
            </RecordCard>

            <RecordCard
              icon={Users}
              title="People"
              action={<Badge variant="secondary" className="tabular-nums">{contactCount}</Badge>}
            >
              <DealContacts deal={deal} canWrite={canWrite} />
            </RecordCard>
          </>
        }
      >
        {/* ── Close ──────────────────────────────────────────────────────── */}
        {canWrite && !isClosed && (
          <RecordCard title="Close this deal">
            <div className="space-y-3">
              <Input
                placeholder="Reason (if lost)"
                value={lostReason}
                onChange={(e) => setLostReason(e.target.value)}
              />
              <div className="flex gap-2">
                <Button onClick={() => handleClose("WON")} disabled={closing} className="flex-1">
                  {closing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Mark won
                </Button>
                <Button variant="outline" onClick={() => handleClose("LOST")} disabled={closing} className="flex-1">
                  Mark lost
                </Button>
              </div>
            </div>
          </RecordCard>
        )}

        {/* ── Products (line items) ──────────────────────────────────────── */}
        <RecordCard icon={Package} title="Products">
          <DealProducts dealId={deal.id} canWrite={canWrite} />
        </RecordCard>

        {/* ── Follow-up ──────────────────────────────────────────────────── */}
        {canWrite && (
          <RecordCard icon={CalendarDays} title="Add a follow-up">
            <div className="space-y-2">
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  placeholder="Chase Abbott about the Gold package"
                  value={taskTitle}
                  onChange={(e) => setTaskTitle(e.target.value)}
                />
                <div className="flex gap-2">
                  <Input type="date" className="w-40" value={taskDue} onChange={(e) => setTaskDue(e.target.value)} />
                  <Button onClick={handleAddTask} disabled={!taskTitle.trim() || createTask.isPending}>
                    Add
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                A due date also sets the reminder — you&apos;ll get an email when it&apos;s due.
              </p>
            </div>
          </RecordCard>
        )}

        {/* ── Activity (shared notes card — money-gated, renders null for MEMBER) ── */}
        <CrmNotesCard attach={{ dealId: deal.id }} canWrite={canWrite} />

        {/* ── History (renders its own heading) ──────────────────────────── */}
        <RecordCard>
          <CrmActivityTimeline entityType="DEAL" entityId={deal.id} />
        </RecordCard>
      </RecordGrid>

      <EditDealDialog deal={deal} open={editOpen} onOpenChange={setEditOpen} />
      <CrmEmailDialog open={emailOpen} onOpenChange={setEmailOpen} target={{ kind: "deal", id: deal.id }} />
    </div>
  );
}

/**
 * The people on a deal — list + add picker (rendered inside the sidebar "People"
 * card). The picker is over CRM contacts (reps, procurement, marketing), NOT the
 * event HCP store: putting a doctor here would be a category error.
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
      {onDeal.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nobody linked yet — add the rep you&apos;re actually talking to.
        </p>
      ) : (
        <ul className="space-y-2">
          {onDeal.map(({ crmContact, role: r }) => (
            <li key={crmContact.id} className="flex items-center justify-between gap-2 rounded-md border p-2">
              <div className="min-w-0">
                <Link
                  href={`/crm/contacts/${crmContact.id}`}
                  className="block truncate text-sm font-medium hover:underline"
                >
                  {crmContact.firstName} {crmContact.lastName}
                </Link>
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
                    className="text-muted-foreground transition-colors hover:text-destructive"
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
        <div className="space-y-2 border-t pt-3">
          <Select value={picked} onValueChange={setPicked}>
            <SelectTrigger className="w-full">
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
          <div className="flex gap-2">
            <Select value={role} onValueChange={(v) => setRole(v as CrmDealContactRole)}>
              <SelectTrigger className="flex-1">
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
        </div>
      )}
    </div>
  );
}
