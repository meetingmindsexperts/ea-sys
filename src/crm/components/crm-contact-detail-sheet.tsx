"use client";

/**
 * CRM contact detail — a rep / procurement / marketing person (NOT an HCP).
 *
 * Mirrors the company sheet: summary, edit, archive/restore, and the History
 * change-log. The Link2 line shows when this rep is ALSO in the event contact store
 * (they attend) — linked, never duplicated.
 */
import { useState } from "react";
import { useSession } from "next-auth/react";
import { Archive, ArchiveRestore, Link2, Loader2, Mail, Pencil, Phone } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useCrmContactDetail, useSetCrmContactArchived } from "@/crm/hooks/use-crm-api";
import { canDeleteCrm } from "@/crm/lib/crm-roles";
import { CrmActivityTimeline } from "@/crm/components/crm-activity-timeline";
import { EditCrmContactDialog } from "@/crm/components/edit-crm-contact-dialog";
import {
  DEAL_STATUS_COLORS,
  LIFECYCLE_COLORS,
  LIFECYCLE_LABELS,
  formatDealValue,
} from "@/crm/lib/crm-types";

export function CrmContactDetailSheet({
  crmContactId,
  onOpenChange,
  canWrite,
}: {
  crmContactId: string | null;
  onOpenChange: (o: boolean) => void;
  canWrite: boolean;
}) {
  const { data: session } = useSession();
  const canDelete = canDeleteCrm(session?.user?.role);
  const { data: contact, isLoading } = useCrmContactDetail(crmContactId);
  const setArchived = useSetCrmContactArchived(crmContactId ?? "");
  const [editOpen, setEditOpen] = useState(false);

  return (
    <Sheet open={!!crmContactId} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {isLoading || !contact ? (
          <div className="flex items-center gap-2 p-6 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2 pr-8">
                {contact.firstName} {contact.lastName}
                {contact.contactId && <Link2 className="h-4 w-4 text-muted-foreground" />}
              </SheetTitle>
              <SheetDescription asChild>
                <span className="flex flex-wrap items-center gap-2">
                  {contact.company && <Badge variant="outline">{contact.company.name}</Badge>}
                  {contact.lifecycleStage && (
                    <Badge variant="outline" className={LIFECYCLE_COLORS[contact.lifecycleStage]}>
                      {LIFECYCLE_LABELS[contact.lifecycleStage]}
                    </Badge>
                  )}
                  {contact.archivedAt && (
                    <Badge variant="outline" className="bg-rose-100 text-rose-700 border-rose-200">
                      Archived
                    </Badge>
                  )}
                </span>
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-6 px-4 pb-8">
              {(canWrite || canDelete) && (
                <div className="flex flex-wrap items-center gap-2">
                  {canWrite && (
                    <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
                      <Pencil className="mr-2 h-3.5 w-3.5" />
                      Edit
                    </Button>
                  )}
                  {canDelete &&
                    (contact.archivedAt ? (
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
                          if (!confirm("Archive this contact? They will be hidden from the lists. You can restore them from the archived view.")) return;
                          setArchived.mutate(true, { onSuccess: () => onOpenChange(false) });
                        }}
                      >
                        <Archive className="mr-2 h-3.5 w-3.5" />
                        Archive
                      </Button>
                    ))}
                </div>
              )}

              {/* ── Contact details ─────────────────────────────────────── */}
              <div className="space-y-1 text-sm">
                <p className="flex items-center gap-2">
                  <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                  {contact.email}
                </p>
                {contact.jobTitle && <p className="text-muted-foreground">{contact.jobTitle}</p>}
                {contact.phone && (
                  <p className="flex items-center gap-2">
                    <Phone className="h-3.5 w-3.5 text-muted-foreground" />
                    {contact.phone}
                  </p>
                )}
                {contact.contactId && (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Link2 className="h-3.5 w-3.5" />
                    Also in the event contact store — they attend as well.
                  </p>
                )}
              </div>

              {contact.notes && (
                <p className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm">
                  {contact.notes}
                </p>
              )}

              <Separator />

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Deals ({contact.deals.length})</h3>
                {contact.deals.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Not on any deals yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {contact.deals.map(({ deal }) => {
                      const value = formatDealValue(deal.dealValue, deal.currency);
                      return (
                        <li key={deal.id} className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm">
                          <div className="min-w-0">
                            <p className="truncate font-medium">{deal.name}</p>
                            {deal.event && <p className="text-xs text-muted-foreground">{deal.event.name}</p>}
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <span className="font-medium">
                              {value ?? <span className="text-muted-foreground">—</span>}
                            </span>
                            <Badge variant="outline" className={DEAL_STATUS_COLORS[deal.status]}>
                              {deal.status}
                            </Badge>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <Separator />

              <CrmActivityTimeline entityType="CONTACT" entityId={contact.id} />
            </div>

            <EditCrmContactDialog contact={contact} open={editOpen} onOpenChange={setEditOpen} />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
