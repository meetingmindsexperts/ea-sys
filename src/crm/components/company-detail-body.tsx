"use client";

/**
 * Account detail — the body of the dedicated account page (/crm/companies/[id]).
 *
 * Record-page layout: identity header with pipeline stats (open / won / people),
 * then a two-column body — the account's deals, activity and history on the left,
 * and a sticky rail (facts, people, about) on the right. Fetches by id;
 * `onArchived` navigates the page away after archiving.
 *
 * The "Needs review" banner is the fuzzy-duplicate flag — advisory (the server
 * created the row rather than blocking it). Merging is a human job (a v1 gap).
 */
import { useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import {
  Archive,
  ArchiveRestore,
  Building2,
  ExternalLink,
  Handshake,
  History,
  Info,
  Loader2,
  Pencil,
  TriangleAlert,
  UserPlus,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCrmCompany, useUpdateCompany, useSetCompanyArchived } from "@/crm/hooks/use-crm-api";
import { canDeleteCrm } from "@/crm/lib/crm-roles";
import { CrmActivityTimeline } from "@/crm/components/crm-activity-timeline";
import { EditCompanyDialog } from "@/crm/components/edit-company-dialog";
import { DEAL_STATUS_COLORS, LIFECYCLE_COLORS, LIFECYCLE_LABELS, formatDealValue } from "@/crm/lib/crm-types";
import { RecordHeader, RecordGrid, RecordCard, Facts, Fact, Dash } from "@/crm/components/record-layout";
import { CrmNotesCard } from "@/crm/components/crm-notes-card";
import { CreateDealDialog } from "@/crm/components/create-deal-dialog";
import { CreateCrmContactDialog } from "@/crm/components/create-crm-contact-dialog";
import { useCrmStages } from "@/crm/hooks/use-crm-api";

export function CompanyDetailBody({
  companyId,
  canWrite,
  onArchived,
}: {
  companyId: string;
  canWrite: boolean;
  onArchived?: () => void;
}) {
  const { data: session } = useSession();
  const canDelete = canDeleteCrm(session?.user?.role);
  const { data: company, isLoading, isError } = useCrmCompany(companyId);
  const update = useUpdateCompany(companyId);
  const setArchived = useSetCompanyArchived(companyId);
  const { data: stages = [] } = useCrmStages();
  const [newDealOpen, setNewDealOpen] = useState(false);
  const [addContactOpen, setAddContactOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-16 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading account…
      </div>
    );
  }
  if (isError || !company) {
    return (
      <div className="rounded-xl border bg-muted/20 p-8 text-center">
        <p className="text-sm text-muted-foreground">
          This account could not be found — it may have been removed.
        </p>
      </div>
    );
  }

  const website = company.website
    ? company.website.startsWith("http")
      ? company.website
      : `https://${company.website}`
    : null;
  const location = [company.city, company.country].filter(Boolean).join(", ");
  const subtitle = [company.industry, location].filter(Boolean).join(" · ");
  const openDeals = company.deals.filter((d) => d.status === "OPEN").length;
  const wonDeals = company.deals.filter((d) => d.status === "WON").length;

  return (
    <div className="space-y-5">
      <RecordHeader
        icon={Building2}
        title={company.name}
        subtitle={subtitle || undefined}
        badges={
          company.archivedAt ? (
            <Badge variant="outline" className="border-rose-200 bg-rose-100 text-rose-700">
              Archived
            </Badge>
          ) : undefined
        }
        stats={[
          { label: "Open deals", value: openDeals },
          { label: "Won", value: wonDeals },
          { label: "People", value: company.contacts.length },
        ]}
        actions={
          (canWrite || canDelete) && (
            <>
              {canWrite && !company.archivedAt && (
                <>
                  <Button size="sm" onClick={() => setNewDealOpen(true)}>
                    <Handshake className="mr-2 h-3.5 w-3.5" />
                    New deal
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setAddContactOpen(true)}>
                    <UserPlus className="mr-2 h-3.5 w-3.5" />
                    Add contact
                  </Button>
                </>
              )}
              {canWrite && (
                <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
                  <Pencil className="mr-2 h-3.5 w-3.5" />
                  Edit
                </Button>
              )}
              {canDelete &&
                (company.archivedAt ? (
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
                      if (!confirm("Archive this account? It will be hidden from the lists. Its deals are not affected. You can restore it from the archived view.")) return;
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
          <>
            <RecordCard icon={Info} title="Details">
              <Facts>
                <Fact label="Industry">{company.industry || <Dash />}</Fact>
                <Fact label="Location">{location || <Dash />}</Fact>
                <Fact label="Website">
                  {website ? (
                    <a
                      href={website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      <span className="break-all">{company.website}</span>
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                  ) : (
                    <Dash />
                  )}
                </Fact>
                <Fact label="Created">{new Date(company.createdAt).toLocaleDateString()}</Fact>
              </Facts>
            </RecordCard>

            <RecordCard
              icon={Users}
              title="People"
              action={<Badge variant="secondary" className="tabular-nums">{company.contacts.length}</Badge>}
              bodyClassName={company.contacts.length === 0 ? "p-4" : "p-3"}
            >
              {company.contacts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No contacts linked yet. Link them from the contact&apos;s detail.
                </p>
              ) : (
                <ul className="space-y-2">
                  {company.contacts.map((c) => (
                    <li key={c.id}>
                      <Link
                        href={`/crm/contacts/${c.id}`}
                        className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm transition-colors hover:bg-muted/40"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium">
                            {c.firstName} {c.lastName}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {c.jobTitle ? `${c.jobTitle} · ` : ""}
                            {c.email}
                          </p>
                        </div>
                        {c.lifecycleStage && (
                          <Badge variant="outline" className={LIFECYCLE_COLORS[c.lifecycleStage]}>
                            {LIFECYCLE_LABELS[c.lifecycleStage]}
                          </Badge>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </RecordCard>

            {company.notes && (
              <RecordCard title="About">
                <p className="whitespace-pre-wrap text-sm">{company.notes}</p>
              </RecordCard>
            )}
          </>
        }
      >
        {company.needsReview && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="flex-1 text-sm">
              <p className="font-medium text-amber-900">Possible duplicate</p>
              <p className="mt-1 text-amber-800">
                This name looks similar to an existing account. If they are genuinely different
                organizations, dismiss this.
              </p>
              {canWrite && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={async () => {
                    try {
                      await update.mutateAsync({ needsReview: false });
                    } catch {
                      // Surfaced by the hook's onError toast.
                      return;
                    }
                    toast.success("Marked as distinct");
                  }}
                  disabled={update.isPending}
                >
                  They&apos;re different — dismiss
                </Button>
              )}
            </div>
          </div>
        )}

        <RecordCard
          icon={Handshake}
          title="Deals"
          action={<Badge variant="secondary" className="tabular-nums">{company.deals.length}</Badge>}
          bodyClassName={company.deals.length === 0 ? "p-4" : "p-3"}
        >
          {company.deals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No deals yet.</p>
          ) : (
            <ul className="space-y-2">
              {company.deals.map((d) => {
                const value = formatDealValue(d.dealValue, d.currency);
                return (
                  <li key={d.id}>
                    <Link
                      href={`/crm/deals/${d.id}`}
                      className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm transition-colors hover:bg-muted/40"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium">{d.name}</p>
                        {d.event && <p className="truncate text-xs text-muted-foreground">{d.event.name}</p>}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="font-medium tabular-nums">{value ?? <Dash />}</span>
                        <Badge variant="outline" className={DEAL_STATUS_COLORS[d.status]}>
                          {d.status}
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
          attach={{ companyId: company.id }}
          canWrite={canWrite}
          placeholder="Spoke to their events team — budget confirmed for two Gold packages next year."
        />

        <RecordCard icon={History} title="History">
          <CrmActivityTimeline entityType="COMPANY" entityId={company.id} />
        </RecordCard>
      </RecordGrid>

      <EditCompanyDialog company={company} open={editOpen} onOpenChange={setEditOpen} />
      {/* keyed by open state so each open remounts with THIS company pre-selected */}
      {newDealOpen && (
        <CreateDealDialog
          open={newDealOpen}
          onOpenChange={setNewDealOpen}
          stages={stages}
          defaultCompany={{ id: company.id, name: company.name }}
        />
      )}
      {addContactOpen && (
        <CreateCrmContactDialog
          open={addContactOpen}
          onOpenChange={setAddContactOpen}
          defaultCompanyId={company.id}
        />
      )}
    </div>
  );
}
