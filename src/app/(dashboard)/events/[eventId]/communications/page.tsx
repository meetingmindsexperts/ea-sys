"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Mail,
  Users,
  Mic,
  FileText,
  UserCheck,
  Send,
  FileEdit,
  CreditCard,
  AlertCircle,
} from "lucide-react";
import {
  useRegistrations,
  useSpeakers,
  useAbstracts,
  useReviewers,
  useTickets,
} from "@/hooks/use-api";
import { BulkEmailDialog } from "@/components/bulk-email-dialog";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

type RecipientType = "speakers" | "registrations" | "reviewers" | "abstracts";

interface RegistrationItem {
  paymentStatus: string;
  ticketType?: { id: string; name: string };
}

interface SpeakerItem {
  status: string;
  email?: string;
}

interface AbstractItem {
  speaker?: { email?: string };
}

interface ReviewerItem {
  id: string;
}

interface TicketTypeItem {
  id: string;
  name: string;
}

export default function CommunicationsPage() {
  const params = useParams();
  const eventId = params.eventId as string;

  // Fetch all data for counts
  const registrationsQuery = useRegistrations(eventId);
  const speakersQuery = useSpeakers(eventId);
  const abstractsQuery = useAbstracts(eventId);
  const reviewersQuery = useReviewers(eventId);
  const ticketsQuery = useTickets(eventId);

  const registrations = (registrationsQuery.data ?? []) as RegistrationItem[];
  const speakers = (speakersQuery.data ?? []) as SpeakerItem[];
  const abstracts = (abstractsQuery.data ?? []) as AbstractItem[];
  const reviewerData = reviewersQuery.data as { reviewers?: ReviewerItem[] } | undefined;
  const reviewers = (reviewerData?.reviewers ?? []) as ReviewerItem[];
  const ticketTypes = (ticketsQuery.data ?? []) as TicketTypeItem[];

  const isLoading =
    registrationsQuery.isLoading ||
    speakersQuery.isLoading ||
    abstractsQuery.isLoading ||
    reviewersQuery.isLoading;
  const showDelayedLoader = useDelayedLoading(isLoading, 1000);

  // Registration sub-filters
  const [regPaymentFilter, setRegPaymentFilter] = useState("all");
  const [regTypeFilter, setRegTypeFilter] = useState("all");
  const [speakerStatusFilter, setSpeakerStatusFilter] = useState("all");

  // Bulk email dialog state
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  const [activeAudience, setActiveAudience] = useState<RecipientType>("registrations");
  const [activeStatusFilter, setActiveStatusFilter] = useState<string | undefined>();
  const [activeTicketTypeFilter, setActiveTicketTypeFilter] = useState<string | undefined>();

  // Computed counts
  const paidRegistrations = registrations.filter(
    (r) => r.paymentStatus === "PAID" || r.paymentStatus === "COMPLIMENTARY"
  );
  const unpaidRegistrations = registrations.filter(
    (r) => r.paymentStatus === "UNPAID"
  );

  const filteredRegistrations = registrations.filter((r) => {
    if (regPaymentFilter !== "all" && r.paymentStatus !== regPaymentFilter) return false;
    if (regTypeFilter !== "all" && r.ticketType?.id !== regTypeFilter) return false;
    return true;
  });

  const filteredSpeakers = speakers.filter((s) => {
    if (speakerStatusFilter !== "all" && s.status !== speakerStatusFilter) return false;
    return true;
  });

  // Unique abstract submitters (deduplicated by speaker email)
  const uniqueSubmitters = new Set(
    abstracts
      .map((a) => a.speaker?.email)
      .filter(Boolean)
  );

  function getAudienceCount(key: RecipientType): number {
    switch (key) {
      case "registrations":
        return filteredRegistrations.length;
      case "speakers":
        return filteredSpeakers.length;
      case "abstracts":
        return uniqueSubmitters.size;
      case "reviewers":
        return reviewers.length;
    }
  }

  function openEmailDialog(audience: RecipientType) {
    setActiveAudience(audience);
    if (audience === "registrations") {
      setActiveStatusFilter(undefined);
      setActiveTicketTypeFilter(
        regTypeFilter !== "all" ? regTypeFilter : undefined
      );
    } else if (audience === "speakers") {
      setActiveStatusFilter(
        speakerStatusFilter !== "all" ? speakerStatusFilter : undefined
      );
      setActiveTicketTypeFilter(undefined);
    } else {
      setActiveStatusFilter(undefined);
      setActiveTicketTypeFilter(undefined);
    }
    setEmailDialogOpen(true);
  }

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
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Mail className="h-8 w-8" />
            Communications
          </h1>
          <p className="text-muted-foreground mt-1">
            Send emails to your event audience — registrants, speakers, abstract submitters, and reviewers.
          </p>
        </div>
        <Link href={`/events/${eventId}/communications/templates`}>
          <Button variant="outline">
            <FileEdit className="mr-2 h-4 w-4" />
            Email Templates
          </Button>
        </Link>
      </div>

      {/* Quick Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-blue-50 p-2">
                <Users className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{registrations.length}</p>
                <p className="text-xs text-muted-foreground">Registrations</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-green-50 p-2">
                <CreditCard className="h-5 w-5 text-green-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{paidRegistrations.length}</p>
                <p className="text-xs text-muted-foreground">Paid</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-amber-50 p-2">
                <AlertCircle className="h-5 w-5 text-amber-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{unpaidRegistrations.length}</p>
                <p className="text-xs text-muted-foreground">Unpaid</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-purple-50 p-2">
                <Mic className="h-5 w-5 text-purple-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{speakers.length}</p>
                <p className="text-xs text-muted-foreground">Speakers</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Audience Cards */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Registrations Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Registrations
            </CardTitle>
            <CardDescription>
              Send emails to event registrants. Filter by payment status or registration type.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Payment Status</label>
                <Select value={regPaymentFilter} onValueChange={setRegPaymentFilter}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All ({registrations.length})</SelectItem>
                    <SelectItem value="PAID">Paid ({paidRegistrations.length})</SelectItem>
                    <SelectItem value="UNPAID">Unpaid ({unpaidRegistrations.length})</SelectItem>
                    <SelectItem value="COMPLIMENTARY">
                      Complimentary ({registrations.filter((r) => r.paymentStatus === "COMPLIMENTARY").length})
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Registration Type</label>
                <Select value={regTypeFilter} onValueChange={setRegTypeFilter}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    {ticketTypes.map((tt) => (
                      <SelectItem key={tt.id} value={tt.id}>
                        {tt.name} ({registrations.filter((r) => r.ticketType?.id === tt.id).length})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <span className="text-sm font-medium">
                {filteredRegistrations.length} recipient{filteredRegistrations.length !== 1 ? "s" : ""}
              </span>
              <Button
                size="sm"
                onClick={() => openEmailDialog("registrations")}
                disabled={filteredRegistrations.length === 0}
              >
                <Send className="mr-2 h-4 w-4" />
                Send Email
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Speakers Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mic className="h-5 w-5" />
              Speakers
            </CardTitle>
            <CardDescription>
              Send invitations, agreements, or custom emails to speakers.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Speaker Status</label>
              <Select value={speakerStatusFilter} onValueChange={setSpeakerStatusFilter}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All ({speakers.length})</SelectItem>
                  <SelectItem value="INVITED">
                    Invited ({speakers.filter((s) => s.status === "INVITED").length})
                  </SelectItem>
                  <SelectItem value="CONFIRMED">
                    Confirmed ({speakers.filter((s) => s.status === "CONFIRMED").length})
                  </SelectItem>
                  <SelectItem value="DECLINED">
                    Declined ({speakers.filter((s) => s.status === "DECLINED").length})
                  </SelectItem>
                  <SelectItem value="CANCELLED">
                    Cancelled ({speakers.filter((s) => s.status === "CANCELLED").length})
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <span className="text-sm font-medium">
                {filteredSpeakers.length} recipient{filteredSpeakers.length !== 1 ? "s" : ""}
              </span>
              <Button
                size="sm"
                onClick={() => openEmailDialog("speakers")}
                disabled={filteredSpeakers.length === 0}
              >
                <Send className="mr-2 h-4 w-4" />
                Send Email
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Abstract Submitters Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Abstract Submitters
            </CardTitle>
            <CardDescription>
              Send acceptance, rejection, revision requests, or reminders to abstract submitters.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-lg bg-muted/50 p-3">
                <p className="text-2xl font-bold">{abstracts.length}</p>
                <p className="text-xs text-muted-foreground">Total Abstracts</p>
              </div>
              <div className="rounded-lg bg-muted/50 p-3">
                <p className="text-2xl font-bold">{uniqueSubmitters.size}</p>
                <p className="text-xs text-muted-foreground">Unique Submitters</p>
              </div>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <span className="text-sm font-medium">
                {uniqueSubmitters.size} recipient{uniqueSubmitters.size !== 1 ? "s" : ""}
              </span>
              <Button
                size="sm"
                onClick={() => openEmailDialog("abstracts")}
                disabled={uniqueSubmitters.size === 0}
              >
                <Send className="mr-2 h-4 w-4" />
                Send Email
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Reviewers Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserCheck className="h-5 w-5" />
              Reviewers
            </CardTitle>
            <CardDescription>
              Send review invitations or custom messages to assigned reviewers.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg bg-muted/50 p-3">
              <p className="text-2xl font-bold">{reviewers.length}</p>
              <p className="text-xs text-muted-foreground">Assigned Reviewers</p>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <span className="text-sm font-medium">
                {reviewers.length} recipient{reviewers.length !== 1 ? "s" : ""}
              </span>
              <Button
                size="sm"
                onClick={() => openEmailDialog("reviewers")}
                disabled={reviewers.length === 0}
              >
                <Send className="mr-2 h-4 w-4" />
                Send Email
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Bulk Email Dialog */}
      <BulkEmailDialog
        open={emailDialogOpen}
        onOpenChange={setEmailDialogOpen}
        eventId={eventId}
        recipientType={activeAudience}
        recipientIds={[]}
        recipientCount={getAudienceCount(activeAudience)}
        selectionMode="all"
        statusFilter={activeStatusFilter}
        ticketTypeFilter={activeTicketTypeFilter}
      />
    </div>
  );
}
