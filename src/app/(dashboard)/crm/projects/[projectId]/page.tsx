"use client";

/**
 * One corporate project (/crm/projects/[projectId], Nov 12, 2026): what it is,
 * what it has brought in, its deals, and the one correction it can carry:
 * a link to the event it turned out to duplicate.
 *
 * THE LINK is spelled out on the page, because it changes figures elsewhere:
 * a linked project's deals count under that event in the reports and in the
 * event's Budget revenue (src/crm/lib/deal-attribution.ts). Nothing is moved,
 * so unlinking puts them back.
 */
import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Archive, ArchiveRestore, ArrowLeft, BriefcaseBusiness, CalendarDays, Link2, Link2Off, Loader2, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RecordCard, RecordGrid, RecordHeader, Facts, Fact, Dash } from "@/components/record-layout";
import { useCan } from "@/hooks/use-can";
import { CreateDealDialog } from "@/crm/components/create-deal-dialog";
import { CrmLoadError } from "@/crm/components/crm-load-error";
import { EventCombobox } from "@/crm/components/event-combobox";
import { ProjectDialog } from "@/crm/components/project-dialog";
import { useCrmProject, useCrmStages, useUpdateProject } from "@/crm/hooks/use-crm-api";
import { DEAL_STATUS_COLORS, formatDealValue, type CrmProjectDetail } from "@/crm/lib/crm-types";
import { projectDays, projectMoney } from "@/crm/lib/project-format";

function moneyLine(lines: string[]) {
  return lines.length ? lines.join(" + ") : <Dash />;
}

/** Everything a link changes, said where the decision is made (review of e92d660f: the card named two of five). */
const LINK_REACH =
  "in the reports, on the board's event filter, in the CSV export and in the event's budget revenue, and the contacts on its open and won deals are included when someone emails that event's sponsors";
const LINK_CONFIRM =
  "Link this project to the event? Its deals will count under the event " +
  LINK_REACH +
  ". Nothing is moved, and unlinking puts them back.";

/** Link the project to the event it duplicates, or clear that link. */
function EventLinkCard({ project, canWrite }: { project: CrmProjectDetail; canWrite: boolean }) {
  const update = useUpdateProject(project.id);
  const [picked, setPicked] = useState<string | null>(null);

  async function save(eventId: string | null) {
    // Linking reaches the event's sponsor emails, so it is confirmed; unlinking only takes that away.
    if (eventId && !confirm(LINK_CONFIRM)) return;
    try {
      await update.mutateAsync({ eventId });
      toast.success(eventId ? "Linked. Its deals now count under that event." : "Unlinked. Its deals count under the project again.");
      setPicked(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change the link");
    }
  }

  return (
    <RecordCard icon={Link2} title="Is this really an event?">
      {project.event ? (
        <div className="space-y-3 text-sm">
          <p>
            Linked to <span className="font-medium">{project.event.name}</span>. This project&rsquo;s deals count under that event{" "}
            {LINK_REACH}.
          </p>
          {canWrite && !project.archivedAt && (
            <Button type="button" variant="outline" size="sm" onClick={() => save(null)} disabled={update.isPending}>
              {update.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Link2Off className="mr-2 h-3.5 w-3.5" />}
              Unlink
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Only if this project was entered by mistake for an event or webinar that is already in the system. Linking makes its deals
            count under that event {LINK_REACH}. Nothing is moved, and unlinking puts them back.
          </p>
          {canWrite && !project.archivedAt && (
            <>
              <EventCombobox value={picked} onChange={setPicked} clearLabel="No event" placeholder="Choose the event…" className="w-full" />
              <Button type="button" size="sm" onClick={() => save(picked)} disabled={!picked || update.isPending}>
                {update.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Link2 className="mr-2 h-3.5 w-3.5" />}
                Link to this event
              </Button>
            </>
          )}
        </div>
      )}
    </RecordCard>
  );
}

export default function CrmProjectPage() {
  const params = useParams();
  const projectId = Array.isArray(params.projectId) ? params.projectId[0] : (params.projectId ?? "");
  const router = useRouter();
  const canWrite = useCan("crm.write") === "allowed";
  const canDelete = useCan("crm.delete") === "allowed";

  const { data: project, isLoading, isError, refetch } = useCrmProject(projectId);
  const { data: stages = [] } = useCrmStages();
  const update = useUpdateProject(projectId);
  const [editOpen, setEditOpen] = useState(false);
  const [dealOpen, setDealOpen] = useState(false);

  async function setArchived(archived: boolean) {
    if (archived && !confirm("Archive this project? It will be hidden from the picker and the list. Its deals are not affected. You can restore it later.")) return;
    try {
      await update.mutateAsync({ archived });
      toast.success(archived ? "Project archived" : "Project restored");
      if (archived) router.push("/crm/projects");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the project");
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/crm/projects">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to projects
        </Link>
      </Button>

      {isLoading && <div className="h-64 animate-pulse rounded-xl border bg-muted/30" />}
      {isError && <CrmLoadError what="this project" onRetry={() => refetch()} />}
      {project && (
        <>
          <RecordHeader
            icon={BriefcaseBusiness}
            title={project.name}
            subtitle={[project.company?.name, projectDays(project.startDate, project.endDate), project.location].filter(Boolean).join(" · ") || "Corporate project"}
            badges={
              <>
                {project.archivedAt && (
                  <Badge variant="outline" className="border-rose-200 bg-rose-100 text-rose-700">
                    Archived
                  </Badge>
                )}
                {project.event && (
                  <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">
                    Counts under {project.event.name}
                  </Badge>
                )}
              </>
            }
            actions={
              <>
                {canWrite && !project.archivedAt && (
                  <>
                    <Button className="btn-gradient text-white shadow-sm" size="sm" onClick={() => setDealOpen(true)}>
                      <Plus className="mr-2 h-4 w-4" />
                      New deal
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                      <Pencil className="mr-2 h-3.5 w-3.5" />
                      Edit
                    </Button>
                  </>
                )}
                {canDelete && (
                  <Button variant="outline" size="sm" onClick={() => setArchived(!project.archivedAt)} disabled={update.isPending}>
                    {project.archivedAt ? <ArchiveRestore className="mr-2 h-3.5 w-3.5" /> : <Archive className="mr-2 h-3.5 w-3.5" />}
                    {project.archivedAt ? "Restore" : "Archive"}
                  </Button>
                )}
              </>
            }
            stats={[
              { label: "Deals", value: `${project.dealCount} (${project.openDealCount} open, ${project.wonDealCount} won)` },
              { label: "Open value", value: moneyLine(projectMoney(project.dealTotals, "open")) },
              { label: "Won value", value: moneyLine(projectMoney(project.dealTotals, "won")) },
            ]}
          />

          <RecordGrid
            sidebar={
              <>
                <RecordCard icon={CalendarDays} title="Details">
                  <Facts>
                    <Fact label="Client account">
                      {project.company ? (
                        <Link href={`/crm/accounts/${project.company.id}`} className="text-sky-700 hover:underline">
                          {project.company.name}
                        </Link>
                      ) : (
                        <Dash />
                      )}
                    </Fact>
                    <Fact label="Dates">{projectDays(project.startDate, project.endDate) ?? <Dash />}</Fact>
                    <Fact label="Location">{project.location ?? <Dash />}</Fact>
                    <Fact label="Project owner">{project.owner ? `${project.owner.firstName} ${project.owner.lastName}` : <Dash />}</Fact>
                    <Fact label="Created">{new Date(project.createdAt).toLocaleDateString()}</Fact>
                  </Facts>
                </RecordCard>
                <EventLinkCard project={project} canWrite={canWrite} />
              </>
            }
          >
            <RecordCard
              icon={BriefcaseBusiness}
              title={`Deals (${project.dealCount})`}
              action={
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/crm/deals?project=${project.id}`}>Open on the board</Link>
                </Button>
              }
            >
              {/* The list is capped; the header's count and totals are not. Say so when they differ. */}
              {project.dealCount > project.deals.length && (
                <p className="mb-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                  Showing the newest {project.deals.length} of {project.dealCount} deals. Open the board for the rest.
                </p>
              )}
              {project.deals.length === 0 ? (
                <p className="text-sm text-muted-foreground">No deals on this project yet.</p>
              ) : (
                <ul className="space-y-2">
                  {project.deals.map((d) => (
                    <li key={d.id}>
                      <Link
                        href={`/crm/deals/${d.id}`}
                        className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm transition-colors hover:bg-muted/40"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium">{d.name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {[d.company?.name, d.stage?.name, d.owner ? `${d.owner.firstName} ${d.owner.lastName}` : null].filter(Boolean).join(" · ")}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="font-medium tabular-nums">{formatDealValue(d.dealValue, d.currency) ?? <Dash />}</span>
                          <Badge variant="outline" className={DEAL_STATUS_COLORS[d.status]}>
                            {d.status.charAt(0) + d.status.slice(1).toLowerCase()}
                          </Badge>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </RecordCard>
          </RecordGrid>

          {/* Keyed so the form is rebuilt from the saved project each time it opens. */}
          {editOpen && <ProjectDialog key={`edit-${project.id}`} open={editOpen} onOpenChange={setEditOpen} project={project} />}
          <CreateDealDialog
            open={dealOpen}
            onOpenChange={setDealOpen}
            stages={stages}
            defaultProject={{ id: project.id, name: project.name }}
            defaultCompany={project.company ? { id: project.company.id, name: project.company.name } : null}
          />
        </>
      )}
    </div>
  );
}
