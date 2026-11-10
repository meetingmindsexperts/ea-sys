"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UserCheck, Plus, Mail, Building2, Trash2, Send, X } from "lucide-react";
import { PermissionGate } from "@/components/permissions/permission-gate";
import { useReviewers, useAddReviewer, useRemoveReviewer, useResendReviewerInvitation, useSendReviewerAssignments } from "@/hooks/use-api";
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
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import { BulkEmailDialog } from "@/components/bulk-email-dialog";

interface Reviewer {
  speakerId: string;
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  organization: string | null;
  jobTitle: string | null;
  speakerStatus: string | null;
  accountActive: boolean;
  needsEmailConfirmation?: boolean;
  /** Assigned abstracts on this event, and how many were not emailed yet. */
  assignments?: { assigned: number; unsent: number };
}

interface AvailableSpeaker {
  id: string;
  email: string;
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

export default function ReviewersPage() {
  const params = useParams();
  const eventId = params.eventId as string;
  return (
    <PermissionGate permission="reviewers.pool.manage" eventId={eventId} what="this event's reviewers" back={{ href: `/events/${eventId}`, label: "Back to the event" }}>
      <Reviewers eventId={eventId} />
    </PermissionGate>
  );
}

/** A new account is sent the setup invitation; one that can sign in, the reviewer email. */
function sendLabel(accountActive: boolean, sending: boolean): string {
  if (sending) return "Sending...";
  return accountActive ? "Send email" : "Send invitation";
}

/** "3 abstracts assigned, 1 not emailed yet" under each reviewer. */
function assignmentSummary(a: { assigned: number; unsent: number } | undefined): string {
  if (!a || a.assigned === 0) return "No abstracts assigned yet";
  const assigned = `${a.assigned} abstract${a.assigned === 1 ? "" : "s"} assigned`;
  return a.unsent > 0 ? `${assigned}, ${a.unsent} not emailed yet` : assigned;
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
  const resendInvitation = useResendReviewerInvitation(eventId);
  const sendAssignments = useSendReviewerAssignments(eventId);
  const [sendingAssignmentsFor, setSendingAssignmentsFor] = useState<string | "all" | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Reviewer | null>(null);

  const reviewers: Reviewer[] = data?.reviewers ?? [];
  const availableSpeakers: AvailableSpeaker[] = data?.availableSpeakers ?? [];

  const [dialogOpen, setDialogOpen] = useState(false);
  const [addTab, setAddTab] = useState<string>("speaker");
  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string>("");
  const [directEmail, setDirectEmail] = useState("");
  const [directFirstName, setDirectFirstName] = useState("");
  const [directLastName, setDirectLastName] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);

  // Bulk email state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkEmailOpen, setBulkEmailOpen] = useState(false);

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
      const gone = res.assignmentsRemoved;
      toast.success(gone > 0 ? `${name} removed, with ${gone} assignment${gone === 1 ? "" : "s"}` : `${name} removed from reviewers`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove reviewer");
    } finally {
      setRemovingId(null);
    }
  };

  const handleResendInvitation = async (userId: string, name: string) => {
    setResendingId(userId);
    try {
      const res = await resendInvitation.mutateAsync(userId);
      toast.success(
        res.type === "setup"
          ? `Invitation sent to ${name}`
          : `Reviewer email sent to ${name}`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send the email");
    } finally {
      setResendingId(null);
    }
  };

  // Assigning sends nothing (Nov 10, 2026): this emails each reviewer once,
  // listing every assignment they have not been told about yet.
  const handleSendAssignments = async (target: string | "all") => {
    setSendingAssignmentsFor(target);
    try {
      const res = await sendAssignments.mutateAsync(target === "all" ? undefined : [target]);
      if (res.emailed > 0) toast.success(`Assignments emailed to ${res.emailed} reviewer${res.emailed === 1 ? "" : "s"}`);
      const failed = res.results.filter((r) => !r.ok && r.code !== "NOTHING_PENDING");
      if (failed.length > 0) toast.error(`${failed.length} could not be sent: ${failed[0].message ?? "send failed"}`);
      if (res.emailed === 0 && failed.length === 0) toast.info("Nothing new to send");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send assignments");
    } finally {
      setSendingAssignmentsFor(null);
    }
  };
  const totalUnsent = reviewers.reduce((n, r) => n + (r.assignments?.unsent ?? 0), 0);

  // Selection helpers
  const allSelected = reviewers.length > 0 && reviewers.every((r) => selectedIds.has(r.userId));
  const someSelected = reviewers.some((r) => selectedIds.has(r.userId));

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        reviewers.forEach((r) => next.delete(r.userId));
      } else {
        reviewers.forEach((r) => next.add(r.userId));
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
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
            <UserCheck className="h-6 w-6 shrink-0 text-primary" />
            Reviewers
            {isFetching && !isLoading && (
              <span className="ml-2 h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            )}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage abstract reviewers for this event
          </p>
        </div>

        <div className="flex gap-2">
          {totalUnsent > 0 && (
            <Button
              variant="outline"
              onClick={() => handleSendAssignments("all")}
              disabled={sendingAssignmentsFor !== null}
            >
              <Send className="mr-2 h-4 w-4" />
              {sendingAssignmentsFor === "all" ? "Sending..." : `Send all assignments (${totalUnsent})`}
            </Button>
          )}
          {reviewers.length > 0 && (
            <Button
              variant="outline"
              onClick={() => setBulkEmailOpen(true)}
            >
              <Send className="mr-2 h-4 w-4" />
              {selectedIds.size > 0 ? `Email (${selectedIds.size})` : "Email All"}
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
                      <Select value={selectedSpeakerId} onValueChange={setSelectedSpeakerId}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a speaker..." />
                        </SelectTrigger>
                        <SelectContent>
                          {availableSpeakers.map((speaker) => (
                            <SelectItem key={speaker.id} value={speaker.id}>
                              {speaker.firstName} {speaker.lastName} — {speaker.email}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
        </div>
      </div>

      {/* Bulk Selection Toolbar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border bg-muted/50 px-4 py-3 shadow-sm">
          <span className="text-sm font-medium">
            {selectedIds.size} reviewer{selectedIds.size !== 1 ? "s" : ""} selected
          </span>
          <div className="flex gap-2 ml-auto">
            <Button
              size="sm"
              onClick={() => setBulkEmailOpen(true)}
            >
              <Send className="mr-2 h-4 w-4" />
              Send Email
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={clearSelection}
            >
              <X className="mr-2 h-4 w-4" />
              Clear
            </Button>
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Reviewers
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{reviewers.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Active Accounts
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {reviewers.filter((r) => r.accountActive && !r.needsEmailConfirmation).length}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Reviewers List */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">All Reviewers</h2>
          {reviewers.length > 0 && (
            <div className="flex items-center gap-2">
              <Checkbox
                checked={triStateChecked(allSelected, someSelected)}
                onCheckedChange={toggleSelectAll}
                aria-label="Select all reviewers"
              />
              <span className="text-sm text-muted-foreground">
                Select all
              </span>
            </div>
          )}
        </div>
        {reviewers.length === 0 ? (
          <Card>
            <CardContent className="pt-6">
              <p className="text-muted-foreground text-center py-8">
                No reviewers assigned yet. Click &quot;Add Reviewer&quot; to get started.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {reviewers.map((reviewer) => (
              <Card key={reviewer.userId} className={`transition-all duration-200 hover:border-primary/50 hover:shadow-[0_4px_12px_rgba(0,0,0,0.08),0_8px_24px_rgba(0,0,0,0.04)] hover:-translate-y-0.5 ${selectedIds.has(reviewer.userId) ? "border-primary bg-primary/5" : ""}`}>
                <CardContent className="pt-6">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3 flex-1">
                      <Checkbox
                        checked={selectedIds.has(reviewer.userId)}
                        onCheckedChange={() => toggleSelect(reviewer.userId)}
                        aria-label={`Select ${reviewer.firstName} ${reviewer.lastName}`}
                        className="mt-1"
                      />
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <h3 className="text-lg font-semibold">
                            {reviewer.firstName} {reviewer.lastName}
                          </h3>
                          {reviewer.needsEmailConfirmation && (
                            <Badge variant="outline" className="bg-amber-50 text-amber-800 border-amber-200">
                              Must confirm email
                            </Badge>
                          )}
                          {!reviewer.needsEmailConfirmation && reviewer.accountActive && (
                            <Badge variant="outline" className="bg-green-100 text-green-800">
                              Active
                            </Badge>
                          )}
                          {!reviewer.needsEmailConfirmation && !reviewer.accountActive && (
                            <Badge variant="outline" className="bg-yellow-100 text-yellow-800">
                              Pending Invitation
                            </Badge>
                          )}
                          {reviewer.speakerStatus && (
                            <Badge
                              variant="outline"
                              className={speakerStatusColors[reviewer.speakerStatus] || ""}
                            >
                              Speaker: {reviewer.speakerStatus}
                            </Badge>
                          )}
                        </div>

                        <div className="space-y-1 text-sm text-muted-foreground">
                          <div className="flex items-center gap-2">
                            <Mail className="h-4 w-4" />
                            {reviewer.email}
                          </div>
                          {reviewer.organization && (
                            <div className="flex items-center gap-2">
                              <Building2 className="h-4 w-4" />
                              {reviewer.organization}
                              {reviewer.jobTitle && ` • ${reviewer.jobTitle}`}
                            </div>
                          )}
                          <div>{assignmentSummary(reviewer.assignments)}</div>
                        </div>
                      </div>
                    </div>

                    <div className="flex gap-2 shrink-0">
                      {/* Adding a reviewer sends nothing (Nov 10, 2026): this
                          is how they hear. A new account gets the setup
                          invitation, an active one the reviewer email. */}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          handleResendInvitation(
                            reviewer.userId,
                            `${reviewer.firstName} ${reviewer.lastName}`
                          )
                        }
                        disabled={resendingId === reviewer.userId}
                      >
                        <Send className="mr-2 h-4 w-4" />
                        {sendLabel(reviewer.accountActive, resendingId === reviewer.userId)}
                      </Button>
                      {(reviewer.assignments?.unsent ?? 0) > 0 && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleSendAssignments(reviewer.userId)}
                          disabled={sendingAssignmentsFor !== null}
                        >
                          <Send className="mr-2 h-4 w-4" />
                          {sendingAssignmentsFor === reviewer.userId ? "Sending..." : `Send assignments (${reviewer.assignments?.unsent})`}
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRemoveTarget(reviewer)}
                        disabled={removingId === reviewer.userId}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        {removingId === reviewer.userId ? "Removing..." : "Remove"}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Remove also takes away their assignments on this event (Nov 10, 2026). */}
      <AlertDialog open={!!removeTarget} onOpenChange={(o) => !o && setRemoveTarget(null)}>
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
                setRemoveTarget(null);
              }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk Email Dialog */}
      <BulkEmailDialog
        open={bulkEmailOpen}
        onOpenChange={setBulkEmailOpen}
        eventId={eventId}
        recipientType="reviewers"
        recipientIds={Array.from(selectedIds)}
        recipientCount={selectedIds.size > 0 ? selectedIds.size : reviewers.length}
        selectionMode={selectedIds.size > 0 ? "selected" : "all"}
      />
    </div>
  );
}
