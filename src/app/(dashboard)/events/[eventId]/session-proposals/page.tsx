"use client";

/**
 * Session Proposals — the v1 organizer INBOX (list / view / export, no review
 * workflow) + the SUBMITTER's "My Session Proposals" view, dual-mode like the
 * abstracts list (scoping is SERVER-side; this page only flips copy and
 * affordances). See docs/SESSION_PROPOSALS_PLAN.md.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import {
  useSessionProposals,
  useSessionProposalThemes,
  useUpdateSessionProposal,
  useDeleteSessionProposal,
  useCreateSessionProposalTheme,
  useUpdateSessionProposalTheme,
  useDeleteSessionProposalTheme,
} from "@/hooks/use-api";
import { canWrite } from "@/lib/can-write";
import { formatPersonName } from "@/lib/utils";
import { SESSION_TYPE_LABELS } from "@/lib/session-enums";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  Lightbulb, Download, Tags, Plus, Pencil, Trash2, Check, X, Loader2,
} from "lucide-react";

type ProposalStatus = "DRAFT" | "SUBMITTED" | "WITHDRAWN";

const STATUS_LABELS: Record<ProposalStatus, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  WITHDRAWN: "Withdrawn",
};
const STATUS_COLORS: Record<ProposalStatus, string> = {
  DRAFT: "bg-gray-100 text-gray-700 border-gray-200",
  SUBMITTED: "bg-sky-100 text-sky-700 border-sky-200",
  WITHDRAWN: "bg-amber-100 text-amber-700 border-amber-200",
};

interface ProposalTheme {
  id: string;
  name: string;
  sortOrder: number;
  _count?: { proposals: number };
}

interface ProposalRow {
  id: string;
  title: string;
  description: string;
  status: ProposalStatus;
  proposedFormat: keyof typeof SESSION_TYPE_LABELS | null;
  durationMinutes: number | null;
  submittedAt: string | null;
  createdAt: string;
  theme: { id: string; name: string } | null;
  speaker: {
    id: string;
    userId: string | null;
    title: string | null;
    firstName: string;
    lastName: string;
    email: string;
    organization: string | null;
    country: string | null;
  };
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export default function SessionProposalsPage() {
  const params = useParams<{ eventId: string }>();
  const eventId = params.eventId;
  const { data: session } = useSession();
  const isSubmitter = session?.user?.role === "SUBMITTER";
  const canManage = canWrite(session?.user?.role);

  const { data: proposals = [], isLoading, isError } = useSessionProposals(eventId);
  const { data: themes = [] } = useSessionProposalThemes(eventId);
  const updateProposal = useUpdateSessionProposal(eventId);
  const deleteProposal = useDeleteSessionProposal(eventId);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [themeFilter, setThemeFilter] = useState<string>("all");
  const [selected, setSelected] = useState<ProposalRow | null>(null);
  const [themesOpen, setThemesOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const rows = proposals as ProposalRow[];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((p) => {
      if (statusFilter !== "all" && p.status !== statusFilter) return false;
      if (themeFilter !== "all" && p.theme?.id !== themeFilter) return false;
      if (!q) return true;
      const proposer = `${p.speaker.firstName} ${p.speaker.lastName} ${p.speaker.email}`.toLowerCase();
      return p.title.toLowerCase().includes(q) || proposer.includes(q);
    });
  }, [rows, search, statusFilter, themeFilter]);

  const counts = useMemo(() => {
    const c: Record<ProposalStatus, number> = { DRAFT: 0, SUBMITTED: 0, WITHDRAWN: 0 };
    for (const p of rows) c[p.status] += 1;
    return c;
  }, [rows]);

  const setStatus = (proposal: ProposalRow, status: ProposalStatus) => {
    updateProposal.mutate(
      { proposalId: proposal.id, status },
      {
        onSuccess: () => {
          toast.success(status === "WITHDRAWN" ? "Proposal withdrawn" : "Proposal reinstated");
          setSelected(null);
        },
        onError: (err) => {
          console.error("session-proposal status change failed", err);
          toast.error(err instanceof Error ? err.message : "Failed to update proposal");
        },
      },
    );
  };

  const handleDelete = (proposal: ProposalRow) => {
    deleteProposal.mutate(proposal.id, {
      onSuccess: () => {
        toast.success("Proposal deleted");
        setConfirmDelete(false);
        setSelected(null);
      },
      onError: (err) => {
        console.error("session-proposal delete failed", err);
        toast.error(err instanceof Error ? err.message : "Failed to delete proposal");
        setConfirmDelete(false);
      },
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Lightbulb className="h-6 w-6 text-primary" />
            {isSubmitter ? "My Session Proposals" : "Session Proposals"}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {isSubmitter
              ? "Propose a session for this event and track what you have submitted."
              : "Session ideas proposed by submitters — review, export, and follow up with proposers."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canManage && (
            <>
              <Button variant="outline" size="sm" onClick={() => setThemesOpen(true)}>
                <Tags className="h-4 w-4 mr-1" /> Themes
              </Button>
              <Button variant="outline" size="sm" asChild>
                <a href={`/api/events/${eventId}/session-proposals?export=csv`}>
                  <Download className="h-4 w-4 mr-1" /> Export CSV
                </a>
              </Button>
            </>
          )}
          {(isSubmitter || canManage) && (
            <Button size="sm" asChild>
              <Link href={`/events/${eventId}/session-proposals/new`}>
                <Plus className="h-4 w-4 mr-1" /> Propose a Session
              </Link>
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {(isSubmitter
          ? (["DRAFT", "SUBMITTED", "WITHDRAWN"] as const)
          : (["SUBMITTED", "WITHDRAWN"] as const)
        ).map((s) => (
          <Card key={s}>
            <CardContent className="py-4">
              <div className="text-2xl font-bold">{counts[s]}</div>
              <div className="text-sm text-muted-foreground">{STATUS_LABELS[s]}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder={isSubmitter ? "Search your proposals…" : "Search title or proposer…"}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {(isSubmitter ? (["DRAFT", "SUBMITTED", "WITHDRAWN"] as const) : (["SUBMITTED", "WITHDRAWN"] as const)).map(
              (s) => (
                <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
        {themes.length > 0 && (
          <Select value={themeFilter} onValueChange={setThemeFilter}>
            <SelectTrigger className="w-52">
              <SelectValue placeholder="Theme" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All themes</SelectItem>
              {(themes as ProposalTheme[]).map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading proposals…
        </div>
      ) : isError ? (
        <Card className="border-red-200 bg-red-50/50">
          <CardContent className="py-8 text-center text-sm text-red-700">
            Couldn&apos;t load session proposals. Please refresh and try again.
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {rows.length === 0
              ? isSubmitter
                ? "You haven't proposed a session yet."
                : "No session proposals yet. Share the submitter registration link to start collecting proposals."
              : "No proposals match the current filters."}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                {!isSubmitter && <TableHead>Proposer</TableHead>}
                <TableHead>Theme</TableHead>
                <TableHead>Format</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Submitted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((p) => (
                <TableRow key={p.id} className="cursor-pointer" onClick={() => setSelected(p)}>
                  <TableCell className="font-medium max-w-[320px] truncate">{p.title}</TableCell>
                  {!isSubmitter && (
                    <TableCell>
                      <div>{formatPersonName(p.speaker.title, p.speaker.firstName, p.speaker.lastName)}</div>
                      <div className="text-xs text-muted-foreground">{p.speaker.organization || p.speaker.email}</div>
                    </TableCell>
                  )}
                  <TableCell>
                    {p.theme ? <Badge variant="outline">{p.theme.name}</Badge> : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>{p.proposedFormat ? SESSION_TYPE_LABELS[p.proposedFormat] : "—"}</TableCell>
                  <TableCell>{p.durationMinutes ? `${p.durationMinutes} min` : "—"}</TableCell>
                  <TableCell>
                    <Badge className={STATUS_COLORS[p.status]} variant="outline">
                      {STATUS_LABELS[p.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>{formatDate(p.submittedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Detail sheet */}
      <Sheet open={!!selected} onOpenChange={(open) => { if (!open) { setSelected(null); setConfirmDelete(false); } }}>
        <SheetContent className="sm:max-w-2xl overflow-y-auto">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="pr-8">{selected.title}</SheetTitle>
                <SheetDescription asChild>
                  <span>
                    <Badge className={STATUS_COLORS[selected.status]} variant="outline">
                      {STATUS_LABELS[selected.status]}
                    </Badge>
                    {selected.submittedAt && (
                      <span className="ml-2 text-xs">Submitted {formatDate(selected.submittedAt)}</span>
                    )}
                  </span>
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-5 px-4 pb-8">
                {!isSubmitter && (
                  <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-1">
                    <div className="font-medium">
                      {formatPersonName(selected.speaker.title, selected.speaker.firstName, selected.speaker.lastName)}
                    </div>
                    <div className="text-muted-foreground">{selected.speaker.email}</div>
                    {(selected.speaker.organization || selected.speaker.country) && (
                      <div className="text-muted-foreground">
                        {[selected.speaker.organization, selected.speaker.country].filter(Boolean).join(" · ")}
                      </div>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <div className="text-muted-foreground text-xs uppercase tracking-wide mb-1">Theme</div>
                    <div>{selected.theme?.name ?? "—"}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground text-xs uppercase tracking-wide mb-1">Format</div>
                    <div>{selected.proposedFormat ? SESSION_TYPE_LABELS[selected.proposedFormat] : "—"}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground text-xs uppercase tracking-wide mb-1">Duration</div>
                    <div>{selected.durationMinutes ? `${selected.durationMinutes} min` : "—"}</div>
                  </div>
                </div>

                <div>
                  <div className="text-muted-foreground text-xs uppercase tracking-wide mb-1">Description</div>
                  <div className="text-sm whitespace-pre-wrap rounded-lg border p-4 bg-background">
                    {selected.description}
                  </div>
                </div>

                {isSubmitter && selected.status === "DRAFT" && (
                  <Button asChild size="sm">
                    <Link href={`/events/${eventId}/session-proposals/new?edit=${selected.id}`}>
                      <Pencil className="h-4 w-4 mr-1" /> Continue editing
                    </Link>
                  </Button>
                )}
                {isSubmitter && selected.status === "SUBMITTED" && (
                  <p className="text-xs text-muted-foreground border-l-2 border-amber-300 pl-3">
                    Submitted proposals are locked — contact the organizing team for changes.
                  </p>
                )}

                {canManage && (
                  <div className="flex flex-wrap items-center gap-2 border-t pt-4">
                    {selected.status === "SUBMITTED" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={updateProposal.isPending}
                        onClick={() => setStatus(selected, "WITHDRAWN")}
                      >
                        Withdraw
                      </Button>
                    ) : selected.status === "WITHDRAWN" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={updateProposal.isPending}
                        onClick={() => setStatus(selected, "SUBMITTED")}
                      >
                        Reinstate
                      </Button>
                    ) : null}
                    {confirmDelete ? (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-red-600">Delete permanently?</span>
                        <Button variant="destructive" size="sm" disabled={deleteProposal.isPending} onClick={() => handleDelete(selected)}>
                          <Check className="h-4 w-4 mr-1" /> Yes, delete
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : (
                      <Button variant="outline" size="sm" className="text-red-600" onClick={() => setConfirmDelete(true)}>
                        <Trash2 className="h-4 w-4 mr-1" /> Delete
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {canManage && (
        <ThemesDialog eventId={eventId} open={themesOpen} onOpenChange={setThemesOpen} themes={themes as ProposalTheme[]} />
      )}
    </div>
  );
}

function ThemesDialog({
  eventId,
  open,
  onOpenChange,
  themes,
}: {
  eventId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  themes: ProposalTheme[];
}) {
  const createTheme = useCreateSessionProposalTheme(eventId);
  const updateTheme = useUpdateSessionProposalTheme(eventId);
  const deleteTheme = useDeleteSessionProposalTheme(eventId);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const handleAdd = () => {
    const name = newName.trim();
    if (!name) return;
    createTheme.mutate(
      { name },
      {
        onSuccess: () => setNewName(""),
        onError: (err) => {
          console.error("session-proposal theme create failed", err);
          toast.error(err instanceof Error ? err.message : "Failed to add theme");
        },
      },
    );
  };

  const handleRename = (themeId: string) => {
    const name = editingName.trim();
    if (!name) return;
    updateTheme.mutate(
      { themeId, name },
      {
        onSuccess: () => setEditingId(null),
        onError: (err) => {
          console.error("session-proposal theme rename failed", err);
          toast.error(err instanceof Error ? err.message : "Failed to rename theme");
        },
      },
    );
  };

  const handleDelete = (themeId: string) => {
    deleteTheme.mutate(themeId, {
      onError: (err) => {
        console.error("session-proposal theme delete failed", err);
        toast.error(err instanceof Error ? err.message : "Failed to delete theme");
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Proposal Themes</DialogTitle>
          <DialogDescription>
            The theme list proposers pick from on the submission form. A theme in use can&apos;t be deleted.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder="Add a theme (e.g. Interventional Cardiology)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAdd(); } }}
            />
            <Button onClick={handleAdd} disabled={createTheme.isPending || !newName.trim()}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          {themes.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No themes yet — proposals can still be submitted without one.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {themes.map((t) => (
                <li key={t.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  {editingId === t.id ? (
                    <>
                      <Input
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleRename(t.id); } }}
                        className="h-8"
                        autoFocus
                      />
                      <Button size="sm" variant="outline" onClick={() => handleRename(t.id)} disabled={updateTheme.isPending}>
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                        <X className="h-4 w-4" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1">{t.name}</span>
                      <span className="text-xs text-muted-foreground">{t._count?.proposals ?? 0} proposal(s)</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => { setEditingId(t.id); setEditingName(t.name); }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-red-600"
                        disabled={deleteTheme.isPending || (t._count?.proposals ?? 0) > 0}
                        onClick={() => handleDelete(t.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
