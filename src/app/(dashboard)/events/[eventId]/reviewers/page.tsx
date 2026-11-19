"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UserCheck, Plus, Trash2, Send, X, Search, PenLine } from "lucide-react";
import { PageHeader } from "@/components/ui/typography";
import { PermissionGate } from "@/components/permissions/permission-gate";
import { useReviewers, useAddReviewer, useRemoveReviewer } from "@/hooks/use-api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { formatPersonName } from "@/lib/utils";
import { plural } from "./send-report";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import { BulkEmailDialog } from "@/components/bulk-email-dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";

interface Reviewer {
  speakerId: string;
  userId: string;
  /** From their speaker record on this event; an account alone has none. */
  title?: string | null;
  firstName: string;
  lastName: string;
  email: string;
  organization: string | null;
  jobTitle: string | null;
  speakerStatus: string | null;
  accountActive: boolean;
  needsEmailConfirmation?: boolean;
  /** Abstracts assigned to them on this event. */
  assignments?: { assigned: number };
}

/** Someone holding assignments on this event who is not on its reviewer pool. */
interface AssignedOffPool {
  userId: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  assigned: number;
}

interface AvailableSpeaker {
  id: string;
  email: string;
  title?: string | null;
  firstName: string;
  lastName: string;
  organization: string | null;
  jobTitle: string | null;
  status: string;
}

const speakerStatusColors: Record<string, string> = {
  INVITED: "bg-yellow-100 text-yellow-800",
  CONFIRMED: "bg-green-100 text-green-800",
  DECLINED: "bg-red-100 text-red-800",
  CANCELLED: "bg-gray-100 text-gray-800",
};

/** "INVITED" as a person reads it: "Invited". */
const speakerStatusLabel = (status: string) => status.charAt(0) + status.slice(1).toLowerCase();

export default function ReviewersPage() {
  const params = useParams();
  const eventId = params.eventId as string;
  return (
    <PermissionGate permission="reviewers.pool.manage" eventId={eventId} what="this event's reviewers" back={{ href: `/events/${eventId}`, label: "Back to the event" }}>
      <Reviewers eventId={eventId} />
    </PermissionGate>
  );
}

/** How many abstracts a reviewer holds. My Reviews shows them which; no email lists them. */
function assignmentSummary(a: { assigned: number } | undefined): string {
  if (!a || a.assigned === 0) return "No abstracts assigned yet";
  return `${plural(a.assigned, "abstract", "abstracts")} assigned`;
}

/** Where a reviewer's account stands: one badge, the state that needs acting on first. */
function accountBadge(r: Reviewer): { label: string; className: string } {
  if (r.needsEmailConfirmation) return { label: "Must confirm email", className: "bg-amber-50 text-amber-800 border-amber-200" };
  if (r.accountActive) return { label: "Active", className: "bg-green-100 text-green-800" };
  return { label: "Pending invitation", className: "bg-yellow-100 text-yellow-800" };
}

/** Email, organisation and job title on one line; whichever of them exist. */
function contactLine(r: Reviewer): string {
  return [r.email, r.organization, r.jobTitle].filter(Boolean).join(" · ");
}

function matchesSearch(r: Reviewer, query: string): boolean {
  return [r.firstName, r.lastName, r.email, r.organization ?? ""].join(" ").toLowerCase().includes(query);
}

/** A list this long gets a search box. */
const SEARCH_FROM = 6;

/**
 * Who the email dialog is opened for (Nov 19, 2026). Every reviewer email,
 * the invitation included, goes through that dialog, so it can be previewed
 * before it is sent. No ids = everyone on the list.
 */
interface EmailTarget {
  ids: string[];
  emailType: "reviewer-invitation" | "custom";
  /** The one person a row's button addresses. */
  name?: string;
}

function removeDescription(assigned: number): string {
  const base = "They come off this event's reviewer pool";
  if (assigned === 0) return `${base}. They have no abstracts assigned here.`;
  return `${base} and off the ${assigned} abstract${assigned === 1 ? "" : "s"} assigned to them, so they can no longer score ${assigned === 1 ? "it" : "them"}. Reviews they already submitted are kept.`;
}

function triStateChecked(all: boolean, some: boolean): boolean | "indeterminate" {
  if (all) return true;
  return some ? "indeterminate" : false;
}

function Reviewers({ eventId }: { eventId: string }) {

  const { data, isLoading, isFetching } = useReviewers(eventId);
  const showDelayedLoader = useDelayedLoading(isLoading, 1000);
  const addReviewer = useAddReviewer(eventId);
  const removeReviewer = useRemoveReviewer(eventId);
  const [removeTarget, setRemoveTarget] = useState<Reviewer | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);

  const reviewers: Reviewer[] = data?.reviewers ?? [];
  const assignedOffPool: AssignedOffPool[] = data?.assignedOffPool ?? [];
  const availableSpeakers: AvailableSpeaker[] = data?.availableSpeakers ?? [];
  const speakerOptions = availableSpeakers.map((speaker) => ({
    value: speaker.id,
    label: `${formatPersonName(speaker.title, speaker.firstName, speaker.lastName)} (${speaker.email})`,
  }));

  const [dialogOpen, setDialogOpen] = useState(false);
  const [addTab, setAddTab] = useState<string>("speaker");
  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string>("");
  const [directEmail, setDirectEmail] = useState("");
  const [directFirstName, setDirectFirstName] = useState("");
  const [directLastName, setDirectLastName] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Open and target are separate states: the target is kept while the dialog
  // closes, so its wording does not change mid-fade.
  const [emailTarget, setEmailTarget] = useState<EmailTarget>({ ids: [], emailType: "custom" });
  const [emailOpen, setEmailOpen] = useState(false);
  const openEmail = (target: EmailTarget) => {
    setEmailTarget(target);
    setEmailOpen(true);
  };

  const resetForm = () => {
    setSelectedSpeakerId("");
    setDirectEmail("");
    setDirectFirstName("");
    setDirectLastName("");
  };

  const handleDialogChange = (open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      resetForm();
      setAddTab("speaker");
    }
  };

  const handleAddFromSpeaker = async () => {
    if (!selectedSpeakerId) return;

    try {
      const result = await addReviewer.mutateAsync({ type: "speaker", speakerId: selectedSpeakerId });
      toast.success((result as { message?: string }).message || "Reviewer added");
      resetForm();
      setDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to add reviewer");
    }
  };

  const handleAddByEmail = async () => {
    if (!directEmail || !directFirstName || !directLastName) return;

    try {
      const result = await addReviewer.mutateAsync({
        type: "direct",
        email: directEmail,
        firstName: directFirstName,
        lastName: directLastName,
      });
      toast.success((result as { message?: string }).message || "Reviewer added");
      resetForm();
      setDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to add reviewer");
    }
  };

  const handleRemoveReviewer = async (userId: string, name: string) => {
    setRemovingId(userId);
    try {
      const res = await removeReviewer.mutateAsync(userId);
      // Off the list, off the selection: a ticked row that is gone would
      // still be counted in "2 reviewers selected".
      setSelectedIds((prev) => {
        if (!prev.has(userId)) return prev;
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
      const gone = res.assignmentsRemoved;
      toast.success(gone > 0 ? `${name} removed, with ${gone} assignment${gone === 1 ? "" : "s"}` : `${name} removed from reviewers`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove reviewer");
    } finally {
      setRemovingId(null);
    }
  };

  const query = search.trim().toLowerCase();
  const shownReviewers = query ? reviewers.filter((r) => matchesSearch(r, query)) : reviewers;
  const activeCount = reviewers.filter((r) => r.accountActive && !r.needsEmailConfirmation).length;
  const assignmentCount = reviewers.reduce((sum, r) => sum + (r.assignments?.assigned ?? 0), 0);
  const stats = [
    { label: "Reviewers", value: reviewers.length },
    { label: "Active accounts", value: activeCount, tone: "text-green-600" },
    { label: "Not active yet", value: reviewers.length - activeCount },
    { label: "Abstracts assigned", value: assignmentCount },
  ];

  // Selection helpers. Select all ticks the rows on screen: with a search
  // typed, that is the people it found.
  const allSelected = shownReviewers.length > 0 && shownReviewers.every((r) => selectedIds.has(r.userId));
  const someSelected = shownReviewers.some((r) => selectedIds.has(r.userId));

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        shownReviewers.forEach((r) => next.delete(r.userId));
      } else {
        shownReviewers.forEach((r) => next.add(r.userId));
      }
      return next;
    });
  };

  const toggleSelect = (userId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        {showDelayedLoader ? <ReloadingSpinner /> : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={UserCheck}
        title="Reviewers"
        description="The people who review this event's abstracts"
        trailing={isFetching && !isLoading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" /> : null}
        actions={
          <>
          {reviewers.length > 0 && (
            <Button variant="outline" onClick={() => openEmail({ ids: [], emailType: "reviewer-invitation" })}>
              <Send className="mr-2 h-4 w-4" />
              {`Send invitation to all (${reviewers.length})`}
            </Button>
          )}
          {reviewers.length > 0 && (
            // With rows ticked it writes to them, and says how many: it always
            // did, and a note meant for three must not reach the committee.
            <Button variant="outline" onClick={() => openEmail({ ids: Array.from(selectedIds), emailType: "custom" })}>
              <PenLine className="mr-2 h-4 w-4" />
              {selectedIds.size > 0 ? `Custom email (${selectedIds.size})` : "Custom email"}
            </Button>
          )}
          <Dialog open={dialogOpen} onOpenChange={handleDialogChange}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Add Reviewer
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add Reviewer</DialogTitle>
                <DialogDescription>
                  Add a reviewer from your event speakers or invite someone directly by email.
                </DialogDescription>
              </DialogHeader>
              <Tabs value={addTab} onValueChange={setAddTab} className="pt-2">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="speaker">From Speakers</TabsTrigger>
                  <TabsTrigger value="email">By Email</TabsTrigger>
                </TabsList>

                <TabsContent value="speaker" className="space-y-4 pt-2">
                  {availableSpeakers.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No available speakers. All speakers are already reviewers or no speakers exist for this event.
                    </p>
                  ) : (
                    <>
                      {/* The app's standard picker: an event can hold hundreds of
                          speakers, and the plain list had no way to search them. */}
                      <SearchableSelect
                        value={selectedSpeakerId}
                        displayLabel={speakerOptions.find((o) => o.value === selectedSpeakerId)?.label}
                        onChange={setSelectedSpeakerId}
                        options={speakerOptions}
                        placeholder="Select a speaker..."
                        searchPlaceholder="Search by name or email..."
                        emptyText="No speaker matches."
                      />
                      <Button
                        onClick={handleAddFromSpeaker}
                        disabled={!selectedSpeakerId || addReviewer.isPending}
                        className="w-full"
                      >
                        {addReviewer.isPending ? "Adding..." : "Add Reviewer"}
                      </Button>
                    </>
                  )}
                </TabsContent>

                <TabsContent value="email" className="space-y-4 pt-2">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="reviewer-firstName">First Name</Label>
                      <Input
                        id="reviewer-firstName"
                        value={directFirstName}
                        onChange={(e) => setDirectFirstName(e.target.value)}
                        placeholder="John"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="reviewer-lastName">Last Name</Label>
                      <Input
                        id="reviewer-lastName"
                        value={directLastName}
                        onChange={(e) => setDirectLastName(e.target.value)}
                        placeholder="Doe"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="reviewer-email">Email</Label>
                    <Input
                      id="reviewer-email"
                      type="email"
                      value={directEmail}
                      onChange={(e) => setDirectEmail(e.target.value)}
                      placeholder="reviewer@example.com"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    No email is sent when you add them. Use Send on their row when you are ready.
                  </p>
                  <Button
                    onClick={handleAddByEmail}
                    disabled={!directEmail || !directFirstName || !directLastName || addReviewer.isPending}
                    className="w-full"
                  >
                    {addReviewer.isPending ? "Adding..." : "Add Reviewer"}
                  </Button>
                </TabsContent>
              </Tabs>
            </DialogContent>
          </Dialog>
          </>
        }
      />

      {/* Stats: one strip, so the list starts near the top of the page. */}
      <Card className="py-4">
        <CardContent className="grid grid-cols-2 gap-y-4 px-2 sm:grid-cols-4 sm:divide-x">
          {stats.map((stat) => (
            <div key={stat.label} className="px-4">
              <div className={`text-2xl font-semibold tabular-nums ${stat.tone ?? ""}`}>{stat.value}</div>
              <div className="text-xs text-muted-foreground">{stat.label}</div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Reviewers list */}
      {reviewers.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground text-center py-8">
              No reviewers assigned yet. Click &quot;Add Reviewer&quot; to get started.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="gap-0 overflow-hidden py-0">
          {/* The list's own bar: search and select all, or what to do with the ticked rows. */}
          <div className="flex min-h-14 flex-wrap items-center gap-3 border-b bg-muted/30 px-4 py-2.5">
            <Checkbox
              checked={triStateChecked(allSelected, someSelected)}
              onCheckedChange={toggleSelectAll}
              aria-label="Select all reviewers"
            />
            {selectedIds.size > 0 ? (
              <span className="text-sm font-medium">{plural(selectedIds.size, "reviewer", "reviewers")} selected</span>
            ) : (
              <span className="text-sm text-muted-foreground">Select all</span>
            )}
            {/* Shown while a search is typed even if the list has since shrunk
                below the threshold, and beside a selection, so a selection
                can be built across two searches. */}
            {(reviewers.length >= SEARCH_FROM || search !== "") && (
              <div className="relative w-full sm:w-72">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name, email or organisation"
                  aria-label="Search reviewers"
                  className="h-9 pl-8"
                />
              </div>
            )}
            {selectedIds.size > 0 && (
              <div className="ml-auto flex flex-wrap gap-2">
                <Button size="sm" onClick={() => openEmail({ ids: Array.from(selectedIds), emailType: "reviewer-invitation" })}>
                  <Send className="mr-2 h-4 w-4" />
                  Send invitation
                </Button>
                <Button size="sm" variant="outline" onClick={() => openEmail({ ids: Array.from(selectedIds), emailType: "custom" })}>
                  <PenLine className="mr-2 h-4 w-4" />
                  Custom email
                </Button>
                <Button size="sm" variant="ghost" onClick={clearSelection}>
                  <X className="mr-2 h-4 w-4" />
                  Clear
                </Button>
              </div>
            )}
          </div>

          {shownReviewers.length === 0 && (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">No reviewer matches &ldquo;{search.trim()}&rdquo;.</p>
          )}
          <ul className="divide-y">
            {shownReviewers.map((reviewer) => {
              const name = formatPersonName(reviewer.title, reviewer.firstName, reviewer.lastName);
              const badge = accountBadge(reviewer);
              return (
                <li
                  key={reviewer.userId}
                  className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-muted/40 ${selectedIds.has(reviewer.userId) ? "bg-primary/5" : ""}`}
                >
                  <Checkbox
                    checked={selectedIds.has(reviewer.userId)}
                    onCheckedChange={() => toggleSelect(reviewer.userId)}
                    aria-label={`Select ${reviewer.firstName} ${reviewer.lastName}`}
                  />
                  <div className="min-w-0 flex-1 basis-64">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{name}</span>
                      <Badge variant="outline" className={badge.className}>{badge.label}</Badge>
                      {reviewer.speakerStatus && (
                        <Badge variant="outline" className={speakerStatusColors[reviewer.speakerStatus] || ""}>
                          Speaker: {speakerStatusLabel(reviewer.speakerStatus)}
                        </Badge>
                      )}
                    </div>
                    <p className="truncate text-sm text-muted-foreground" title={contactLine(reviewer)}>{contactLine(reviewer)}</p>
                    <p className="text-xs text-muted-foreground">{assignmentSummary(reviewer.assignments)}</p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {/* Adding a reviewer sends nothing (Nov 10, 2026): this is
                        how they hear. It opens the email dialog on the
                        invitation, where Preview shows this reviewer's own copy. */}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openEmail({ ids: [reviewer.userId], emailType: "reviewer-invitation", name })}
                    >
                      <Send className="mr-2 h-4 w-4" />
                      Send invitation
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setRemoveTarget(reviewer);
                        setRemoveOpen(true);
                      }}
                      disabled={removingId === reviewer.userId}
                      className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                      aria-label={`Remove ${reviewer.firstName} ${reviewer.lastName}`}
                      title="Remove from this event's reviewers"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {assignedOffPool.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/60">
          <CardContent className="pt-5 pb-4 text-sm text-amber-900 space-y-2">
            <p className="font-medium">Assigned abstracts, but not on this list</p>
            <p>
              These people can still open and score what is assigned to them, and no button here emails them. Add them
              as a reviewer to manage them here, or unassign them on the abstract.
            </p>
            <ul className="list-disc pl-5">
              {assignedOffPool.map((p) => (
                <li key={p.userId}>
                  {`${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || p.email} ({p.email}): {plural(p.assigned, "abstract", "abstracts")}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Remove also takes away their assignments on this event (Nov 10, 2026).
          Open and target are separate states: the target is kept while the
          dialog closes, so its wording does not change mid-fade. */}
      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {removeTarget ? `${removeTarget.firstName} ${removeTarget.lastName}` : "this reviewer"}?
            </AlertDialogTitle>
            <AlertDialogDescription>{removeDescription(removeTarget?.assignments?.assigned ?? 0)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!removeTarget) return;
                handleRemoveReviewer(removeTarget.userId, `${removeTarget.firstName} ${removeTarget.lastName}`);
              }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Every reviewer email: the invitation (one row, the ticked rows, or
          everyone) and a custom message. Its Preview button is the reason the
          invitation no longer sends straight from a button press. */}
      <BulkEmailDialog
        open={emailOpen}
        onOpenChange={setEmailOpen}
        eventId={eventId}
        recipientType="reviewers"
        recipientIds={emailTarget.ids}
        recipientCount={emailTarget.ids.length > 0 ? emailTarget.ids.length : reviewers.length}
        selectionMode={emailTarget.ids.length > 0 ? "selected" : "all"}
        defaultEmailType={emailTarget.emailType}
        recipientName={emailTarget.name}
        // One row or the ticked rows are exactly that list: reviewers have no
        // filters to "match", so a scheduled send must not widen to the pool.
        fixedListOnly={emailTarget.ids.length > 0}
      />
    </div>
  );
}
