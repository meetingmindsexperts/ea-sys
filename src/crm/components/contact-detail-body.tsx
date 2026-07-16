"use client";

/**
 * Contact detail — the body of the dedicated contact page (/crm/contacts/[id]).
 *
 * A CRM contact is a business person (rep / procurement / marketing), NOT an event
 * HCP — a different table and population. Record-page layout: identity header, then
 * a two-column body (deals + history on the left, a facts sidebar on the right).
 * The Link2 marker shows when this rep is ALSO in the event contact store (they
 * attend) — linked, never duplicated. `onArchived` navigates the page away.
 */
import { useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  Archive,
  ArchiveRestore,
  Handshake,
  Info,
  Link2,
  Loader2,
  Mail,
  Pencil,
  Phone,
  User,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCrmContactDetail, useSetCrmContactArchived } from "@/crm/hooks/use-crm-api";
import { canDeleteCrm } from "@/crm/lib/crm-roles";
import { CrmActivityTimeline } from "@/crm/components/crm-activity-timeline";
import { EditCrmContactDialog } from "@/crm/components/edit-crm-contact-dialog";
import { DEAL_STATUS_COLORS, LIFECYCLE_COLORS, LIFECYCLE_LABELS, formatDealValue } from "@/crm/lib/crm-types";
import { RecordHeader, RecordGrid, RecordCard, Facts, Fact, Dash } from "@/crm/components/record-layout";
import { CrmNotesCard } from "@/crm/components/crm-notes-card";

export function ContactDetailBody({
  crmContactId,
  canWrite,
  onArchived,
}: {
  crmContactId: string;
  canWrite: boolean;
  onArchived?: () => void;
}) {
  const { data: session } = useSession();
  const canDelete = canDeleteCrm(session?.user?.role);
  const { data: contact, isLoading, isError } = useCrmContactDetail(crmContactId);
  const setArchived = useSetCrmContactArchived(crmContactId);
  const [editOpen, setEditOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-16 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading contact…
      </div>
    );
  }
  if (isError || !contact) {
    return (
      <div className="rounded-xl border bg-muted/20 p-8 text-center">
        <p className="text-sm text-muted-foreground">
          This contact could not be found — it may have been removed.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <RecordHeader
        icon={User}
        title={
          <span className="inline-flex items-center gap-2">
            {contact.firstName} {contact.lastName}
            {contact.contactId && <Link2 className="h-4 w-4 text-muted-foreground" />}
          </span>
        }
        badges={
          <>
            {contact.company && (
              <Link href={`/crm/companies/${contact.company.id}`}>
                <Badge variant="outline" className="hover:bg-muted">
                  {contact.company.name}
                </Badge>
              </Link>
            )}
            {contact.lifecycleStage && (
              <Badge variant="outline" className={LIFECYCLE_COLORS[contact.lifecycleStage]}>
                {LIFECYCLE_LABELS[contact.lifecycleStage]}
              </Badge>
            )}
            {contact.archivedAt && (
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
                      setArchived.mutate(true, { onSuccess: () => onArchived?.() });
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
          <RecordCard icon={Info} title="Details">
            <Facts>
              <Fact label="Email">
                <a href={`mailto:${contact.email}`} className="inline-flex items-center gap-1.5 text-primary hover:underline">
                  <Mail className="h-3.5 w-3.5 shrink-0" />
                  <span className="break-all">{contact.email}</span>
                </a>
              </Fact>
              <Fact label="Phone">
                {contact.phone ? (
                  <a href={`tel:${contact.phone}`} className="inline-flex items-center gap-1.5 hover:underline">
                    <Phone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    {contact.phone}
                  </a>
                ) : (
                  <Dash />
                )}
              </Fact>
              <Fact label="Job title">{contact.jobTitle || <Dash />}</Fact>
              <Fact label="Company">
                {contact.company ? (
                  <Link href={`/crm/companies/${contact.company.id}`} className="text-primary hover:underline">
                    {contact.company.name}
                  </Link>
                ) : (
                  <Dash />
                )}
              </Fact>
              {contact.country && <Fact label="Country">{contact.country}</Fact>}
              {contact.contactId && (
                <div className="flex items-start gap-1.5 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
                  <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Also in the event contact store — they attend as well.
                </div>
              )}
            </Facts>
          </RecordCard>
        }
      >
        {contact.notes && (
          <RecordCard title="Notes">
            <p className="whitespace-pre-wrap text-sm">{contact.notes}</p>
          </RecordCard>
        )}

        <RecordCard
          icon={Handshake}
          title="Deals"
          action={<Badge variant="secondary" className="tabular-nums">{contact.deals.length}</Badge>}
          bodyClassName={contact.deals.length === 0 ? "p-4" : "p-3"}
        >
          {contact.deals.length === 0 ? (
            <p className="text-sm text-muted-foreground">Not on any deals yet.</p>
          ) : (
            <ul className="space-y-2">
              {contact.deals.map(({ deal, role }) => {
                const value = formatDealValue(deal.dealValue, deal.currency);
                return (
                  <li key={deal.id}>
                    <Link
                      href={`/crm/deals/${deal.id}`}
                      className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm transition-colors hover:bg-muted/40"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium">{deal.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {deal.event ? `${deal.event.name} · ` : ""}
                          {role.charAt(0) + role.slice(1).toLowerCase()}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="font-medium tabular-nums">{value ?? <Dash />}</span>
                        <Badge variant="outline" className={DEAL_STATUS_COLORS[deal.status]}>
                          {deal.status}
                        </Badge>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </RecordCard>

        {/* Logged calls/meetings — the shared notes card (money-gated; null for MEMBER). */}
        <CrmNotesCard
          attach={{ crmContactId: contact.id }}
          canWrite={canWrite}
          placeholder="Called Sarah — she owns the sponsorship budget, wants the prospectus by Friday."
        />

        <RecordCard>
          <CrmActivityTimeline entityType="CONTACT" entityId={contact.id} />
        </RecordCard>
      </RecordGrid>

      <EditCrmContactDialog contact={contact} open={editOpen} onOpenChange={setEditOpen} />
    </div>
  );
}
