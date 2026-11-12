"use client";

/**
 * Corporate projects (Nov 12, 2026): the work the sales team sells that is not
 * an event in the system. A deal is for an event OR one of these. Each row
 * carries what the project has brought in: its deals, its open pipeline and
 * its won revenue, one figure per currency.
 *
 * Search and the owner filter live in the URL (useCrmFilters), like every
 * other CRM list.
 */
import { Suspense, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Archive, BriefcaseBusiness, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCan } from "@/hooks/use-can";
import { useSettled } from "@/hooks/use-settled";
import { cn } from "@/lib/utils";
import { CrmEmptyState } from "@/crm/components/crm-empty-state";
import { CrmLoadError } from "@/crm/components/crm-load-error";
import { CrmTableSkeleton } from "@/crm/components/crm-skeletons";
import { ListTruncationBanner } from "@/crm/components/list-truncation-banner";
import { OwnerFilter } from "@/crm/components/filters/owner-filter";
import { ProjectDialog } from "@/crm/components/project-dialog";
import { useCrmProjects } from "@/crm/hooks/use-crm-api";
import { useCrmFilters } from "@/crm/lib/use-crm-filters";
import { projectDays, projectMoney } from "@/crm/lib/project-format";
import type { CrmProjectRow } from "@/crm/lib/crm-types";

/** One figure per currency, stacked; a dash when there is none to show. */
function Money({ lines }: { lines: string[] }) {
  if (lines.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <>
      {lines.map((l) => (
        <span key={l} className="block">
          {l}
        </span>
      ))}
    </>
  );
}

function ProjectRow({ p }: { p: CrmProjectRow }) {
  return (
    <TableRow>
      <TableCell className="max-w-[20rem]">
        <Link href={`/crm/projects/${p.id}`} className="font-medium text-sky-700 hover:underline">
          {p.name}
        </Link>
        {p.event && (
          <Badge variant="outline" className="ml-2 border-amber-300 bg-amber-50 text-[10px] font-normal text-amber-800">
            Counts under {p.event.name}
          </Badge>
        )}
      </TableCell>
      <TableCell>{p.company?.name ?? <span className="text-muted-foreground">—</span>}</TableCell>
      <TableCell className="whitespace-nowrap">{projectDays(p.startDate, p.endDate) ?? <span className="text-muted-foreground">—</span>}</TableCell>
      <TableCell>{p.location ?? <span className="text-muted-foreground">—</span>}</TableCell>
      <TableCell>{p.owner ? `${p.owner.firstName} ${p.owner.lastName}` : <span className="text-muted-foreground">—</span>}</TableCell>
      <TableCell className="text-right tabular-nums">
        {p.dealCount}
        {p.dealCount > 0 && (
          <span className="block text-xs text-muted-foreground">
            {p.openDealCount} open · {p.wonDealCount} won
          </span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <Money lines={projectMoney(p.dealTotals, "open")} />
      </TableCell>
      <TableCell className="text-right font-medium tabular-nums">
        <Money lines={projectMoney(p.dealTotals, "won")} />
      </TableCell>
    </TableRow>
  );
}

function ProjectsInner() {
  const { data: session } = useSession();
  const canWrite = useCan("crm.write") === "allowed";
  const { get, set } = useCrmFilters();
  const [createOpen, setCreateOpen] = useState(false);

  const q = get("q");
  const owner = get("owner");
  const showArchived = !!get("archived");
  const settledQ = useSettled(q.trim(), 300);
  const { data, isLoading, isError, refetch } = useCrmProjects({
    q: settledQ || undefined,
    ownerId: owner || undefined,
    archived: showArchived ? "1" : undefined,
  });
  const rows = data?.projects ?? [];
  const filtered = !!settledQ || !!owner;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Corporate work that is not an event in the system: client meetings, advisory boards, experts tours
        </p>
        {canWrite && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New project
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            name="project-search"
            aria-label="Search projects"
            placeholder="Search projects…"
            value={q}
            onChange={(e) => set({ q: e.target.value })}
          />
        </div>
        <OwnerFilter
          value={owner}
          onChange={(userId) => set({ owner: userId ?? null })}
          placeholder="All projects"
          meId={session?.user?.id}
          meLabel="My projects"
        />
        <Button
          type="button"
          variant={showArchived ? "default" : "outline"}
          className={cn(showArchived && "bg-slate-700 hover:bg-slate-700")}
          onClick={() => set({ archived: showArchived ? null : "1" })}
        >
          <Archive className="mr-2 h-4 w-4" />
          Archived
        </Button>
      </div>

      <ListTruncationBanner meta={data} shown={rows.length} noun="projects" />

      {isLoading && <CrmTableSkeleton rows={6} cols={8} />}
      {isError && <CrmLoadError what="projects" onRetry={() => refetch()} />}
      {!isLoading && !isError && rows.length === 0 && (
        <CrmEmptyState
          icon={BriefcaseBusiness}
          title={emptyTitle(showArchived, filtered)}
          description={
            showArchived || filtered
              ? undefined
              : "Add one for corporate work you are selling, then create its deals from the Deals board or from the project's page."
          }
          action={
            canWrite && !showArchived && !filtered ? (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                New project
              </Button>
            ) : undefined
          }
        />
      )}
      {!isLoading && !isError && rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Project</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Dates</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead className="text-right">Deals</TableHead>
                <TableHead className="text-right">Open value</TableHead>
                <TableHead className="text-right">Won value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <ProjectRow key={p.id} p={p} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {createOpen && <ProjectDialog open={createOpen} onOpenChange={setCreateOpen} />}
    </div>
  );
}

function emptyTitle(archived: boolean, filtered: boolean): string {
  if (filtered) return "No projects match";
  return archived ? "No archived projects" : "No corporate projects yet";
}

export default function CrmProjectsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <ProjectsInner />
    </Suspense>
  );
}
