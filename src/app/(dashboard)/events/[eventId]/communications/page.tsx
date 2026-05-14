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
  UserPlus,
  FileSignature,
  Megaphone,
  Crown,
  CheckCircle2,
  RotateCcw,
  Clock,
  type LucideIcon,
} from "lucide-react";
import {
  useRegistrations,
  useSpeakers,
  useAbstracts,
  useReviewers,
  useTickets,
} from "@/hooks/use-api";
import { BulkEmailDialog } from "@/components/bulk-email-dialog";
import { ScheduledEmailsList } from "@/components/communications/scheduled-emails-list";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

type RecipientType = "speakers" | "registrations" | "reviewers" | "abstracts";

interface RegistrationItem {
  status: string;
  paymentStatus: string;
  ticketType?: { id: string; name: string };
}

interface SpeakerItem {
  status: string;
  email?: string;
  agreementAcceptedAt: string | null;
  _count?: { sessions: number };
  sessions?: Array<{ role: string }>;
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

// ───────────────────────── Workflow tiles ─────────────────────────
// Pre-built filter + email-type presets for common organizer workflows.
// Tiles bypass the page-level filter dropdowns ("Advanced filters") —
// clicking one opens the dialog with the tile's filters + email type
// applied, leaving any in-progress advanced composition untouched.

type SpeakerEmailType = "invitation" | "agreement" | "custom";
type RegistrationEmailType = "confirmation" | "reminder" | "custom";

interface SpeakerTile {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  filters: {
    status?: string;
    agreementSigned?: string;
    hasSession?: string;
    sessionRole?: string;
  };
  defaultEmailType: SpeakerEmailType;
  matches: (s: SpeakerItem) => boolean;
}

interface RegistrationTile {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  filters: {
    status?: string;
    paymentStatus?: string;
    ticketTypeId?: string;
  };
  defaultEmailType: RegistrationEmailType;
  matches: (r: RegistrationItem) => boolean;
}

const SPEAKER_TILES: SpeakerTile[] = [
  {
    id: "send-invitations",
    label: "Send Invitations",
    description: "Invited speakers awaiting response",
    icon: UserPlus,
    filters: { status: "INVITED" },
    defaultEmailType: "invitation",
    matches: (s) => s.status === "INVITED",
  },
  {
    id: "chase-agreements",
    label: "Chase Agreements",
    description: "Confirmed but agreement not signed",
    icon: FileSignature,
    filters: { status: "CONFIRMED", agreementSigned: "unsigned" },
    defaultEmailType: "agreement",
    matches: (s) => s.status === "CONFIRMED" && !s.agreementAcceptedAt,
  },
  {
    id: "brief-moderators",
    label: "Brief Moderators",
    description: "Speakers in a moderator role",
    icon: Megaphone,
    filters: { sessionRole: "MODERATOR" },
    defaultEmailType: "custom",
    matches: (s) => !!s.sessions?.some((sx) => sx.role === "MODERATOR"),
  },
  {
    id: "brief-chairpersons",
    label: "Brief Chairpersons",
    description: "Speakers in a chair role",
    icon: Crown,
    filters: { sessionRole: "CHAIRPERSON" },
    defaultEmailType: "custom",
    matches: (s) => !!s.sessions?.some((sx) => sx.role === "CHAIRPERSON"),
  },
  {
    id: "active-faculty",
    label: "Active Faculty",
    description: "Confirmed, signed, with at least one session",
    icon: CheckCircle2,
    filters: { status: "CONFIRMED", agreementSigned: "signed", hasSession: "yes" },
    defaultEmailType: "custom",
    matches: (s) =>
      s.status === "CONFIRMED" &&
      !!s.agreementAcceptedAt &&
      (s._count?.sessions ?? s.sessions?.length ?? 0) > 0,
  },
  {
    id: "reinvite-declined",
    label: "Reinvite Declined",
    description: "Previously declined speakers",
    icon: RotateCcw,
    filters: { status: "DECLINED" },
    defaultEmailType: "invitation",
    matches: (s) => s.status === "DECLINED",
  },
];

const REGISTRATION_TILES: RegistrationTile[] = [
  {
    id: "chase-unpaid",
    label: "Chase Unpaid",
    description: "Confirmed but payment outstanding",
    icon: CreditCard,
    filters: { status: "CONFIRMED", paymentStatus: "UNPAID" },
    defaultEmailType: "custom",
    matches: (r) => r.status === "CONFIRMED" && r.paymentStatus === "UNPAID",
  },
  {
    id: "welcome-paid",
    label: "Welcome Paid",
    description: "Paid / complimentary / inclusive registrants",
    icon: Mail,
    // Multi-value filter not expressible in current schema — page filter is
    // single-value. Tile keeps the predicate broad (PAID/COMPLIMENTARY/
    // INCLUSIVE), but the dialog payload narrows to PAID; organizer can
    // re-send for COMPLIMENTARY / INCLUSIVE via Advanced filters.
    filters: { status: "CONFIRMED", paymentStatus: "PAID" },
    defaultEmailType: "confirmation",
    matches: (r) =>
      r.status === "CONFIRMED" &&
      (r.paymentStatus === "PAID" ||
        r.paymentStatus === "COMPLIMENTARY" ||
        r.paymentStatus === "INCLUSIVE"),
  },
  {
    id: "pre-event-reminder",
    label: "Pre-event Reminder",
    description: "All confirmed registrants",
    icon: Clock,
    filters: { status: "CONFIRMED" },
    defaultEmailType: "reminder",
    matches: (r) => r.status === "CONFIRMED",
  },
  {
    id: "cancelled-reengage",
    label: "Cancelled Re-engagement",
    description: "Cancelled registrations",
    icon: RotateCcw,
    filters: { status: "CANCELLED" },
    defaultEmailType: "custom",
    matches: (r) => r.status === "CANCELLED",
  },
];

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
  const [regStatusFilter, setRegStatusFilter] = useState("all");
  const [regPaymentFilter, setRegPaymentFilter] = useState("all");
  const [regTypeFilter, setRegTypeFilter] = useState("all");
  const [speakerStatusFilter, setSpeakerStatusFilter] = useState("all");
  // Tier-1 speaker filters
  const [speakerAgreementFilter, setSpeakerAgreementFilter] = useState("all");
  const [speakerHasSessionFilter, setSpeakerHasSessionFilter] = useState("all");
  const [speakerRoleFilter, setSpeakerRoleFilter] = useState("all");

  // Bulk email dialog state
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  const [activeAudience, setActiveAudience] = useState<RecipientType>("registrations");
  const [activeStatusFilter, setActiveStatusFilter] = useState<string | undefined>();
  const [activePaymentStatusFilter, setActivePaymentStatusFilter] = useState<string | undefined>();
  const [activeTicketTypeFilter, setActiveTicketTypeFilter] = useState<string | undefined>();
  const [activeAgreementSignedFilter, setActiveAgreementSignedFilter] = useState<string | undefined>();
  const [activeHasSessionFilter, setActiveHasSessionFilter] = useState<string | undefined>();
  const [activeSessionRoleFilter, setActiveSessionRoleFilter] = useState<string | undefined>();
  const [activeDefaultEmailType, setActiveDefaultEmailType] = useState<string | undefined>();

  // Computed counts
  const paidRegistrations = registrations.filter(
    (r) => r.paymentStatus === "PAID" || r.paymentStatus === "COMPLIMENTARY"
  );
  const unpaidRegistrations = registrations.filter(
    (r) => r.paymentStatus === "UNPAID"
  );

  const filteredRegistrations = registrations.filter((r) => {
    if (regStatusFilter !== "all" && r.status !== regStatusFilter) return false;
    if (regPaymentFilter !== "all" && r.paymentStatus !== regPaymentFilter) return false;
    if (regTypeFilter !== "all" && r.ticketType?.id !== regTypeFilter) return false;
    return true;
  });

  const filteredSpeakers = speakers.filter((s) => {
    if (speakerStatusFilter !== "all" && s.status !== speakerStatusFilter) return false;
    if (speakerAgreementFilter === "signed" && !s.agreementAcceptedAt) return false;
    if (speakerAgreementFilter === "unsigned" && s.agreementAcceptedAt) return false;
    const sessionCount = s._count?.sessions ?? s.sessions?.length ?? 0;
    if (speakerHasSessionFilter === "yes" && sessionCount === 0) return false;
    if (speakerHasSessionFilter === "no" && sessionCount > 0) return false;
    if (speakerRoleFilter !== "all") {
      const roles = s.sessions?.map((sx) => sx.role) ?? [];
      if (!roles.includes(speakerRoleFilter)) return false;
    }
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
      // Pass the page-level filters through so the dialog pre-selects
      // the same values the organizer just picked here.
      setActiveStatusFilter(
        regStatusFilter !== "all" ? regStatusFilter : undefined
      );
      // W2-F4 — pass the page-level payment filter through so e.g.
      // "Unpaid" pre-selects in the dialog. Saves the organizer
      // re-selecting the same value twice.
      setActivePaymentStatusFilter(
        regPaymentFilter !== "all" ? regPaymentFilter : undefined
      );
      setActiveTicketTypeFilter(
        regTypeFilter !== "all" ? regTypeFilter : undefined
      );
      setActiveAgreementSignedFilter(undefined);
      setActiveHasSessionFilter(undefined);
      setActiveSessionRoleFilter(undefined);
    } else if (audience === "speakers") {
      setActiveStatusFilter(
        speakerStatusFilter !== "all" ? speakerStatusFilter : undefined
      );
      setActivePaymentStatusFilter(undefined);
      setActiveTicketTypeFilter(undefined);
      setActiveAgreementSignedFilter(
        speakerAgreementFilter !== "all" ? speakerAgreementFilter : undefined
      );
      setActiveHasSessionFilter(
        speakerHasSessionFilter !== "all" ? speakerHasSessionFilter : undefined
      );
      setActiveSessionRoleFilter(
        speakerRoleFilter !== "all" ? speakerRoleFilter : undefined
      );
    } else {
      setActiveStatusFilter(undefined);
      setActivePaymentStatusFilter(undefined);
      setActiveTicketTypeFilter(undefined);
      setActiveAgreementSignedFilter(undefined);
      setActiveHasSessionFilter(undefined);
      setActiveSessionRoleFilter(undefined);
    }
    setActiveDefaultEmailType(undefined);
    setEmailDialogOpen(true);
  }

  // Tile click — bypasses the page-level filter dropdowns entirely.
  // Pushes the tile's filter combo + email type straight into the
  // dialog. Leaves the Advanced filter inputs untouched so an
  // in-progress composition isn't clobbered by an unrelated quick
  // tile send.
  function openTileDialog(
    audience: "speakers" | "registrations",
    tile: SpeakerTile | RegistrationTile
  ) {
    setActiveAudience(audience);
    setActiveStatusFilter(tile.filters.status);
    if (audience === "registrations") {
      const f = tile.filters as RegistrationTile["filters"];
      setActivePaymentStatusFilter(f.paymentStatus);
      setActiveTicketTypeFilter(f.ticketTypeId);
      setActiveAgreementSignedFilter(undefined);
      setActiveHasSessionFilter(undefined);
      setActiveSessionRoleFilter(undefined);
    } else {
      const f = tile.filters as SpeakerTile["filters"];
      setActivePaymentStatusFilter(undefined);
      setActiveTicketTypeFilter(undefined);
      setActiveAgreementSignedFilter(f.agreementSigned);
      setActiveHasSessionFilter(f.hasSession);
      setActiveSessionRoleFilter(f.sessionRole);
    }
    setActiveDefaultEmailType(tile.defaultEmailType);
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
              One-click sends for common workflows, or open Advanced filters to compose freely.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Workflow tiles — one-click presets for common sends */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {REGISTRATION_TILES.map((tile) => {
                const count = registrations.filter(tile.matches).length;
                const Icon = tile.icon;
                return (
                  <button
                    key={tile.id}
                    type="button"
                    onClick={() => openTileDialog("registrations", tile)}
                    disabled={count === 0}
                    className="flex flex-col gap-1 rounded-lg border p-3 text-left transition hover:border-primary hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:bg-transparent"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                        <span className="truncate text-sm font-medium">{tile.label}</span>
                      </div>
                      <span className="text-sm font-semibold tabular-nums">{count}</span>
                    </div>
                    <p className="line-clamp-1 text-xs text-muted-foreground">{tile.description}</p>
                  </button>
                );
              })}
            </div>

            {/* Advanced filters — escape hatch for ad-hoc segments */}
            <details className="group rounded-lg border [&[open]>summary>svg]:rotate-90">
              <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground">
                <svg className="h-3 w-3 transition-transform" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                  <path d="M4.5 2.5l4 3.5-4 3.5z" />
                </svg>
                Advanced filters
              </summary>
              <div className="space-y-4 border-t p-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Registration Status</label>
                <Select value={regStatusFilter} onValueChange={setRegStatusFilter}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All ({registrations.length})</SelectItem>
                    <SelectItem value="PENDING">
                      Pending ({registrations.filter((r) => r.status === "PENDING").length})
                    </SelectItem>
                    <SelectItem value="CONFIRMED">
                      Confirmed ({registrations.filter((r) => r.status === "CONFIRMED").length})
                    </SelectItem>
                    <SelectItem value="CHECKED_IN">
                      Checked In ({registrations.filter((r) => r.status === "CHECKED_IN").length})
                    </SelectItem>
                    <SelectItem value="CANCELLED">
                      Cancelled ({registrations.filter((r) => r.status === "CANCELLED").length})
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
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
              </div>
            </details>
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
              One-click sends for common workflows, or open Advanced filters to compose freely.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Workflow tiles — one-click presets for common sends */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {SPEAKER_TILES.map((tile) => {
                const count = speakers.filter(tile.matches).length;
                const Icon = tile.icon;
                return (
                  <button
                    key={tile.id}
                    type="button"
                    onClick={() => openTileDialog("speakers", tile)}
                    disabled={count === 0}
                    className="flex flex-col gap-1 rounded-lg border p-3 text-left transition hover:border-primary hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:bg-transparent"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                        <span className="truncate text-sm font-medium">{tile.label}</span>
                      </div>
                      <span className="text-sm font-semibold tabular-nums">{count}</span>
                    </div>
                    <p className="line-clamp-1 text-xs text-muted-foreground">{tile.description}</p>
                  </button>
                );
              })}
            </div>

            {/* Advanced filters — escape hatch for ad-hoc segments */}
            <details className="group rounded-lg border [&[open]>summary>svg]:rotate-90">
              <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground">
                <svg className="h-3 w-3 transition-transform" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                  <path d="M4.5 2.5l4 3.5-4 3.5z" />
                </svg>
                Advanced filters
              </summary>
              <div className="space-y-4 border-t p-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Agreement</label>
                <Select value={speakerAgreementFilter} onValueChange={setSpeakerAgreementFilter}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All ({speakers.length})</SelectItem>
                    <SelectItem value="signed">
                      Signed ({speakers.filter((s) => s.agreementAcceptedAt).length})
                    </SelectItem>
                    <SelectItem value="unsigned">
                      Unsigned ({speakers.filter((s) => !s.agreementAcceptedAt).length})
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Has Session</label>
                <Select value={speakerHasSessionFilter} onValueChange={setSpeakerHasSessionFilter}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All ({speakers.length})</SelectItem>
                    <SelectItem value="yes">
                      Has Session ({speakers.filter((s) => (s._count?.sessions ?? s.sessions?.length ?? 0) > 0).length})
                    </SelectItem>
                    <SelectItem value="no">
                      No Session ({speakers.filter((s) => (s._count?.sessions ?? s.sessions?.length ?? 0) === 0).length})
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Session Role</label>
                <Select value={speakerRoleFilter} onValueChange={setSpeakerRoleFilter}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Roles</SelectItem>
                    <SelectItem value="SPEAKER">
                      Speaker ({speakers.filter((s) => s.sessions?.some((sx) => sx.role === "SPEAKER")).length})
                    </SelectItem>
                    <SelectItem value="MODERATOR">
                      Moderator ({speakers.filter((s) => s.sessions?.some((sx) => sx.role === "MODERATOR")).length})
                    </SelectItem>
                    <SelectItem value="CHAIRPERSON">
                      Chairperson ({speakers.filter((s) => s.sessions?.some((sx) => sx.role === "CHAIRPERSON")).length})
                    </SelectItem>
                    <SelectItem value="PANELIST">
                      Panelist ({speakers.filter((s) => s.sessions?.some((sx) => sx.role === "PANELIST")).length})
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
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
              </div>
            </details>
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

      {/* Scheduled Emails */}
      <ScheduledEmailsList eventId={eventId} />

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
        paymentStatusFilter={activePaymentStatusFilter}
        ticketTypeFilter={activeTicketTypeFilter}
        agreementSignedFilter={activeAgreementSignedFilter}
        hasSessionFilter={activeHasSessionFilter}
        sessionRoleFilter={activeSessionRoleFilter}
        defaultEmailType={activeDefaultEmailType}
      />
    </div>
  );
}
