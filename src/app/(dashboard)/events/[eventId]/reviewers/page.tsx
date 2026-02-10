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
import { UserCheck, Plus, Mail, Building2, Trash2 } from "lucide-react";
import { useReviewers, useAddReviewer, useRemoveReviewer } from "@/hooks/use-api";
import { toast } from "sonner";

interface Reviewer {
  speakerId: string;
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  company: string | null;
  jobTitle: string | null;
  speakerStatus: string | null;
  accountActive: boolean;
}

interface AvailableSpeaker {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  company: string | null;
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

  const { data, isLoading, isFetching } = useReviewers(eventId);
  const addReviewer = useAddReviewer(eventId);
  const removeReviewer = useRemoveReviewer(eventId);

  const reviewers: Reviewer[] = data?.reviewers ?? [];
  const availableSpeakers: AvailableSpeaker[] = data?.availableSpeakers ?? [];

  const [dialogOpen, setDialogOpen] = useState(false);
  const [addTab, setAddTab] = useState<string>("speaker");
  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string>("");
  const [directEmail, setDirectEmail] = useState("");
  const [directFirstName, setDirectFirstName] = useState("");
  const [directLastName, setDirectLastName] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);

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
      await removeReviewer.mutateAsync(userId);
      toast.success(`${name} removed from reviewers`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove reviewer");
    } finally {
      setRemovingId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <UserCheck className="h-8 w-8" />
            Reviewers
            {isFetching && !isLoading && (
              <span className="ml-2 h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            )}
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage abstract reviewers for this event
          </p>
        </div>

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
                  An invitation email will be sent if this person doesn&apos;t have an account yet.
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
              {reviewers.filter((r) => r.accountActive).length}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Reviewers List */}
      <div>
        <h2 className="text-lg font-semibold mb-4">All Reviewers</h2>
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
              <Card key={reviewer.userId} className="hover:border-primary transition-colors">
                <CardContent className="pt-6">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <h3 className="text-lg font-semibold">
                          {reviewer.firstName} {reviewer.lastName}
                        </h3>
                        {reviewer.accountActive ? (
                          <Badge variant="outline" className="bg-green-100 text-green-800">
                            Active
                          </Badge>
                        ) : (
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
                        {reviewer.company && (
                          <div className="flex items-center gap-2">
                            <Building2 className="h-4 w-4" />
                            {reviewer.company}
                            {reviewer.jobTitle && ` • ${reviewer.jobTitle}`}
                          </div>
                        )}
                      </div>
                    </div>

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        handleRemoveReviewer(
                          reviewer.userId,
                          `${reviewer.firstName} ${reviewer.lastName}`
                        )
                      }
                      disabled={removingId === reviewer.userId}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      {removingId === reviewer.userId ? "Removing..." : "Remove"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
