"use client";

/**
 * Contact detail — the body of the dedicated contact page (/crm/contacts/[id]).
 *
 * A CRM contact is a business person (rep / procurement / marketing), NOT an event
 * HCP — a different table and population. Record-page layout: identity header, then
 * a two-column body (deals + history on the left, a facts sidebar on the right).
 * The "Also an event contact" badge shows when this rep is ALSO in the event contact
 * store (they attend) — linked, never duplicated. `onArchived` navigates the page away.
 */
import { useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import {
  Archive,
  ArchiveRestore,
  Handshake,
  History,
  Info,
  Link2,
  Loader2,
  Mail,
  Pencil,
  Phone,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCrmContactDetail, useSetCrmContactArchived, useUpdateCrmContact } from "@/crm/hooks/use-crm-api";
import { canDeleteCrm } from "@/crm/lib/crm-roles";
import { CrmActivityTimeline } from "@/crm/components/crm-activity-timeline";
import { PurgeRecordButton } from "@/crm/components/purge-record-button";
import {
  CrmContactFormFields,
  crmContactFormPayload,
  crmContactFormValid,
  crmContactToForm,
  emptyCrmContactForm,
  type CrmContactFormState,
} from "@/crm/components/crm-contact-form-fields";
import {
  CONTACT_STATUS_COLORS,
  CONTACT_STATUS_LABELS,
  DEAL_STATUS_COLORS,
  LIFECYCLE_COLORS,
  LIFECYCLE_LABELS,
  formatDealValue,
} from "@/crm/lib/crm-types";
import { contactScoreColor } from "@/crm/lib/contact-score";
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
  const updateContact = useUpdateCrmContact(crmContactId);

  // Inline editing (owner request, July 21): no popup — Edit swaps the record
  // body for the shared contact form in place, Save/Cancel in the header.
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<CrmContactFormState>(emptyCrmContactForm);

  async function handleSave() {
    if (!crmContactFormValid(form)) {
      toast.error("First name, last name and email are required");
      return;
    }
    try {
      await updateContact.mutateAsync(crmContactFormPayload(form));
      toast.success("Contact updated");
      setEditing(false);
    } catch {
      // The mutation's onError already toasts the server's message.
    }
  }

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

  const initials =
    `${contact.firstName.charAt(0)}${contact.lastName.charAt(0)}`.trim() || "?";

  return (
    <div className="space-y-5">
      <RecordHeader
        avatarText={initials}
        title={`${contact.firstName} ${contact.lastName}`}
        subtitle={
          contact.jobTitle || contact.company ? (
            <>
              {contact.jobTitle}
              {contact.jobTitle && contact.company ? " · " : ""}
              {contact.company && (
                <Link
                  href={`/crm/companies/${contact.company.id}`}
                  className="hover:text-foreground hover:underline"
                >
                  {contact.company.name}
                </Link>
              )}
            </>
          ) : undefined
        }
        badges={
          <>
            {contact.status && (
              <Badge variant="outline" className={CONTACT_STATUS_COLORS[contact.status]}>
                {CONTACT_STATUS_LABELS[contact.status]}
              </Badge>
            )}
            {contact.lifecycleStage && (
              <Badge variant="outline" className={LIFECYCLE_COLORS[contact.lifecycleStage]}>
                {LIFECYCLE_LABELS[contact.lifecycleStage]}
              </Badge>
            )}
            {contact.contactId && (
              <Badge variant="outline" className="gap-1 text-muted-foreground">
                <Link2 className="h-3 w-3" />
                Also an event contact
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
          editing ? (
            <>
              <Button size="sm" variant="outline" onClick={() => setEditing(false)} disabled={updateContact.isPending}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={updateContact.isPending}>
                {updateContact.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                Save
              </Button>
            </>
          ) : (
          (canWrite || canDelete) && (
            <>
              {/* An archived contact is frozen — restore before editing. */}
              {canWrite && !contact.archivedAt && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setForm(crmContactToForm(contact));
                    setEditing(true);
                  }}
                >
                  <Pencil className="mr-2 h-3.5 w-3.5" />
                  Edit
                </Button>
              )}
              <PurgeRecordButton
                entity="contact"
                id={contact.id}
                name={`${contact.firstName} ${contact.lastName}`.trim()}
                archived={!!contact.archivedAt}
                onPurged={() => onArchived?.()}
              />
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
          )
        }
      />

      {editing ? (
        <RecordCard icon={Pencil} title="Edit contact" className="max-w-2xl">
          <CrmContactFormFields
            value={form}
            onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
            idPrefix="edit-contact"
          />
          <p className="mt-3 text-xs text-muted-foreground">
            Changes are recorded in the contact&apos;s history.
          </p>
        </RecordCard>
      ) : (
      <RecordGrid
        sidebar={
          <>
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
              <Fact label="Mobile">
                {contact.mobile ? (
                  <a href={`tel:${contact.mobile}`} className="inline-flex items-center gap-1.5 hover:underline">
                    <Phone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    {contact.mobile}
                  </a>
                ) : (
                  <Dash />
                )}
              </Fact>
              <Fact label="Job title">{contact.jobTitle || <Dash />}</Fact>
              <Fact label="Owner">
                {contact.owner ? `${contact.owner.firstName} ${contact.owner.lastName}` : <Dash />}
              </Fact>
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
              {(contact.tags?.length ?? 0) > 0 && (
                <Fact label="Tags">
                  <span className="flex flex-wrap gap-1">
                    {contact.tags?.map((t) => (
                      <Badge key={t} variant="secondary" className="font-normal">
                        {t}
                      </Badge>
                    ))}
                  </span>
                </Fact>
              )}
              {contact.contactId && (
                <div className="flex items-start gap-1.5 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
                  <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Also in the event contact store — they attend as well.
                </div>
              )}
            </Facts>
          </RecordCard>

          {contact.score && (
            <RecordCard
              title="Score"
              action={
                <Badge variant="outline" className={contactScoreColor(contact.score.total)}>
                  {contact.score.total} / 100
                </Badge>
              }
            >
              <ul className="space-y-1 text-xs text-muted-foreground">
                <li className="flex justify-between">
                  <span>Open deals</span>
                  <span className="tabular-nums">+{contact.score.openDealPoints}</span>
                </li>
                <li className="flex justify-between">
                  <span>Won a deal</span>
                  <span className="tabular-nums">+{contact.score.wonDealPoints}</span>
                </li>
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                Auto-computed from deal involvement — it updates as deals open, win or archive.
              </p>
            </RecordCard>
          )}

          {contact.notes && (
            <RecordCard title="About">
              <p className="whitespace-pre-wrap text-sm">{contact.notes}</p>
            </RecordCard>
          )}
        </>
        }
      >
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

        <RecordCard icon={History} title="History">
          <CrmActivityTimeline entityType="CONTACT" entityId={contact.id} />
        </RecordCard>
      </RecordGrid>
      )}
    </div>
  );
}
