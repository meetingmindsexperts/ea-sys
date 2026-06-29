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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
  ClipboardList,
  ListChecks,
  type LucideIcon,
} from "lucide-react";
import { resolvePastedIds } from "@/app/(dashboard)/events/[eventId]/registrations/resolve-pasted-ids";
import {
  useRegistrations,
  useSpeakers,
  useAbstracts,
  useReviewers,
  useTickets,
  useEmailTemplates,
  useEventTags,
} from "@/hooks/use-api";
import { TagInput } from "@/components/ui/tag-input";
import { isCustomTemplateSlug } from "@/lib/email-template-slugs";
import { BulkEmailDialog, type BulkEmailEffectiveFilters } from "@/components/bulk-email-dialog";
import {
  PAYMENT_STATUS_DISPLAY_ORDER,
  PAYMENT_STATUS_LABELS,
} from "@/app/(dashboard)/events/[eventId]/registrations/registration-enums";
import { ScheduledEmailsList } from "@/components/communications/scheduled-emails-list";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

type RecipientType = "speakers" | "registrations" | "reviewers" | "abstracts";

interface RegistrationItem {
  id: string;
  serialId: number | null;
  status: string;
  paymentStatus: string;
  badgeType?: string | null;
  ticketType?: { id: string; name: string; isFaculty?: boolean };
  attendee?: { email?: string | null; tags?: string[] } | null;
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
type RegistrationEmailType =
  | "confirmation"
  | "reminder"
  | "custom"
  | "survey-invitation";

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
    // Multi-value paymentStatus (comma list) — the backend resolves it to a
    // SQL IN, so the send now reaches all three settled states, matching the
    // tile's count + the `matches` predicate below.
    filters: { status: "CONFIRMED", paymentStatus: "PAID,COMPLIMENTARY,INCLUSIVE" },
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
  {
    // Per-event post-event feedback survey invitation. Pre-selects
    // CHECKED_IN audience because the survey is for people who
    // actually showed up; backend mints a per-recipient
    // `survey:{regId}` token + injects {{surveyLink}}. Organizer
    // overrides the body via the per-event "Survey Invitation"
    // template entry (esp. CME events that want to mention cert
    // delivery — the default body is cert-neutral).
    id: "send-survey",
    label: "Send Survey Invitations",
    description: "Post-event feedback link to checked-in attendees",
    icon: ClipboardList,
    filters: { status: "CHECKED_IN" },
    defaultEmailType: "survey-invitation",
    matches: (r) => r.status === "CHECKED_IN",
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
  const templatesQuery = useEmailTemplates(eventId);
  // Existing attendee tags → autocomplete suggestions for the tag filter.
  const tagsQuery = useEventTags(eventId);
  const tagSuggestions = (tagsQuery.data?.tags ?? []).map((t) => t.tag);

  // Active organizer-created templates (excludes system defaults) — surfaced
  // as one-click tiles so a custom template an organizer activated is
  // reachable here, not just buried in the dialog's Email Type dropdown.
  const customTemplates = (
    (templatesQuery.data?.templates ?? []) as Array<{ slug: string; name: string; isActive: boolean }>
  ).filter((t) => t.isActive && isCustomTemplateSlug(t.slug));

  const registrations = (registrationsQuery.data ?? []) as RegistrationItem[];
  const speakers = (speakersQuery.data ?? []) as SpeakerItem[];
  const abstracts = (abstractsQuery.data ?? []) as AbstractItem[];
  const reviewerData = reviewersQuery.data as { reviewers?: ReviewerItem[] } | undefined;
  const reviewers = (reviewerData?.reviewers ?? []) as ReviewerItem[];
  const ticketTypes = (ticketsQuery.data ?? []) as TicketTypeItem[];
  // Distinct non-empty badge types present on this event's registrations —
  // drives the Badge Type filter dropdown.
  const badgeTypes = Array.from(
    new Set(
      registrations
        .map((r) => r.badgeType)
        .filter((b): b is string => !!b && b.trim().length > 0),
    ),
  ).sort();

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
  const [regBadgeFilter, setRegBadgeFilter] = useState<string[]>([]);
  const [regTagsFilter, setRegTagsFilter] = useState<string[]>([]);
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
  const [activeBadgeTypesFilter, setActiveBadgeTypesFilter] = useState<string[]>([]);
  const [activeTagsFilter, setActiveTagsFilter] = useState<string[]>([]);
  const [activeAgreementSignedFilter, setActiveAgreementSignedFilter] = useState<string | undefined>();
  const [activeHasSessionFilter, setActiveHasSessionFilter] = useState<string | undefined>();
  const [activeSessionRoleFilter, setActiveSessionRoleFilter] = useState<string | undefined>();
  const [activeDefaultEmailType, setActiveDefaultEmailType] = useState<string | undefined>();
  // When the organizer picks specific recipients ("Select by IDs"), the dialog
  // runs in "selected" mode over these ids instead of an audience-wide filter.
  const [activeRecipientIds, setActiveRecipientIds] = useState<string[]>([]);
  const [activeSelectionMode, setActiveSelectionMode] = useState<"all" | "selected">("all");

  // "Select by IDs" — paste a CSV column of registration #s / IDs / emails to
  // email exactly those registrations (the workflow the organizer used on the
  // registrations list: copy a column from a spreadsheet, bulk-act on it).
  const [selectByIdsOpen, setSelectByIdsOpen] = useState(false);
  const [pasteIds, setPasteIds] = useState("");
  const [matchResult, setMatchResult] = useState<{ matched: string[]; unmatched: string[] } | null>(null);

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
    if (regBadgeFilter.length > 0 && !(r.badgeType && regBadgeFilter.includes(r.badgeType))) return false;
    if (regTagsFilter.length > 0) {
      const tags = r.attendee?.tags ?? [];
      if (!regTagsFilter.some((t) => tags.includes(t))) return false;
    }
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

  // Live recipient counts the dialog calls with its current effective filters
  // (so a tile or an in-dialog payment override shows the true number, not the
  // advanced-filter total). Mirror the send `where` dimensions; paymentStatus
  // may be a comma-separated multi-value list.
  function countRegistrations(f: BulkEmailEffectiveFilters): number {
    const payStatuses =
      f.paymentStatus && f.paymentStatus !== "all"
        ? f.paymentStatus.split(",").map((s) => s.trim()).filter(Boolean)
        : null;
    return registrations.filter((r) => {
      if (f.status && f.status !== "all" && r.status !== f.status) return false;
      if (payStatuses && !payStatuses.includes(r.paymentStatus)) return false;
      if (f.ticketTypeIds && f.ticketTypeIds.length > 0 && !(r.ticketType?.id && f.ticketTypeIds.includes(r.ticketType.id))) return false;
      if (f.badgeTypes && f.badgeTypes.length > 0 && !(r.badgeType && f.badgeTypes.includes(r.badgeType))) return false;
      if (f.tags && f.tags.length > 0) {
        const tags = r.attendee?.tags ?? [];
        if (!f.tags.some((t) => tags.includes(t))) return false;
      }
      if (f.excludeFaculty && r.ticketType?.isFaculty) return false;
      return true;
    }).length;
  }

  function countSpeakers(f: BulkEmailEffectiveFilters): number {
    return speakers.filter((s) => {
      if (f.status && f.status !== "all" && s.status !== f.status) return false;
      if (f.agreementSigned === "signed" && !s.agreementAcceptedAt) return false;
      if (f.agreementSigned === "unsigned" && s.agreementAcceptedAt) return false;
      const sessionCount = s._count?.sessions ?? s.sessions?.length ?? 0;
      if (f.hasSession === "yes" && sessionCount === 0) return false;
      if (f.hasSession === "no" && sessionCount > 0) return false;
      if (f.sessionRole) {
        const roles = s.sessions?.map((x) => x.role) ?? [];
        if (!roles.includes(f.sessionRole)) return false;
      }
      return true;
    }).length;
  }

  const recipientCountFor =
    activeAudience === "registrations"
      ? countRegistrations
      : activeAudience === "speakers"
        ? countSpeakers
        : undefined;

  function openEmailDialog(audience: RecipientType) {
    setActiveAudience(audience);
    setActiveSelectionMode("all");
    setActiveRecipientIds([]);
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
      setActiveBadgeTypesFilter(regBadgeFilter);
      setActiveTagsFilter(regTagsFilter);
      setActiveAgreementSignedFilter(undefined);
      setActiveHasSessionFilter(undefined);
      setActiveSessionRoleFilter(undefined);
    } else if (audience === "speakers") {
      setActiveStatusFilter(
        speakerStatusFilter !== "all" ? speakerStatusFilter : undefined
      );
      setActivePaymentStatusFilter(undefined);
      setActiveTicketTypeFilter(undefined);
      setActiveBadgeTypesFilter([]);
      setActiveTagsFilter([]);
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
      setActiveBadgeTypesFilter([]);
      setActiveTagsFilter([]);
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
    setActiveSelectionMode("all");
    setActiveRecipientIds([]);
    setActiveStatusFilter(tile.filters.status);
    if (audience === "registrations") {
      const f = tile.filters as RegistrationTile["filters"];
      setActivePaymentStatusFilter(f.paymentStatus);
      setActiveTicketTypeFilter(f.ticketTypeId);
      setActiveBadgeTypesFilter([]);
      setActiveTagsFilter([]);
      setActiveAgreementSignedFilter(undefined);
      setActiveHasSessionFilter(undefined);
      setActiveSessionRoleFilter(undefined);
    } else {
      const f = tile.filters as SpeakerTile["filters"];
      setActivePaymentStatusFilter(undefined);
      setActiveTicketTypeFilter(undefined);
      setActiveBadgeTypesFilter([]);
      setActiveTagsFilter([]);
      setActiveAgreementSignedFilter(f.agreementSigned);
      setActiveHasSessionFilter(f.hasSession);
      setActiveSessionRoleFilter(f.sessionRole);
    }
    setActiveDefaultEmailType(tile.defaultEmailType);
    setEmailDialogOpen(true);
  }

  // Open the dialog for an audience pre-selected to a saved custom template.
  // Sends to ALL of that audience (no extra filter) — the organizer can
  // narrow via Advanced filters or selected recipients before sending.
  function openTemplateDialog(audience: RecipientType, slug: string) {
    setActiveAudience(audience);
    setActiveSelectionMode("all");
    setActiveRecipientIds([]);
    setActiveStatusFilter(undefined);
    setActivePaymentStatusFilter(undefined);
    setActiveTicketTypeFilter(undefined);
    setActiveBadgeTypesFilter([]);
    setActiveTagsFilter([]);
    setActiveAgreementSignedFilter(undefined);
    setActiveHasSessionFilter(undefined);
    setActiveSessionRoleFilter(undefined);
    setActiveDefaultEmailType(`template:${slug}`);
    setEmailDialogOpen(true);
  }

  const handleMatchPastedIds = () =>
    setMatchResult(resolvePastedIds(pasteIds, registrations));

  // Resolve the pasted ids → open the dialog in "selected" mode over exactly
  // those registrations. Always registrations audience (the paste box is on the
  // registrations card and matches registration #s / emails).
  function applyPastedSelection() {
    const result = matchResult ?? resolvePastedIds(pasteIds, registrations);
    if (result.matched.length === 0) return;
    setActiveAudience("registrations");
    setActiveSelectionMode("selected");
    setActiveRecipientIds(result.matched);
    setActiveStatusFilter(undefined);
    setActivePaymentStatusFilter(undefined);
    setActiveTicketTypeFilter(undefined);
    setActiveAgreementSignedFilter(undefined);
    setActiveHasSessionFilter(undefined);
    setActiveSessionRoleFilter(undefined);
    setActiveDefaultEmailType(undefined);
    setSelectByIdsOpen(false);
    setMatchResult(null);
    setEmailDialogOpen(true);
  }

  // One-click tiles for the event's active custom templates, scoped to an
  // audience. Rendered under the Registrations and Speakers cards.
  function renderSavedTemplates(audience: RecipientType) {
    if (customTemplates.length === 0) return null;
    return (
      <div className="space-y-2 border-t pt-3">
        <p className="text-xs font-medium text-muted-foreground">Your templates</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {customTemplates.map((t) => (
            <button
              key={t.slug}
              type="button"
              onClick={() => openTemplateDialog(audience, t.slug)}
              className="flex items-center gap-2 rounded-lg border p-3 text-left transition hover:border-primary hover:bg-muted/50"
            >
              <FileEdit className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
              <span className="truncate text-sm font-medium">{t.name}</span>
            </button>
          ))}
        </div>
      </div>
    );
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

            {/* Select by IDs — paste a spreadsheet column to email exactly
                those registrations. */}
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => { setPasteIds(""); setMatchResult(null); setSelectByIdsOpen(true); }}
              disabled={registrations.length === 0}
            >
              <ListChecks className="mr-2 h-4 w-4" />
              Select by IDs
            </Button>

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
                    {PAYMENT_STATUS_DISPLAY_ORDER.map((status) => (
                      <SelectItem key={status} value={status}>
                        {PAYMENT_STATUS_LABELS[status]} ({registrations.filter((r) => r.paymentStatus === status).length})
                      </SelectItem>
                    ))}
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
              {badgeTypes.length > 0 && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Badge Type</label>
                  <TagInput
                    value={regBadgeFilter}
                    onChange={setRegBadgeFilter}
                    suggestions={badgeTypes}
                    placeholder="Pick badge type(s)…"
                  />
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Tags (any of)</label>
              <TagInput
                value={regTagsFilter}
                onChange={setRegTagsFilter}
                suggestions={tagSuggestions}
                placeholder="Filter by tag(s)…"
              />
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

            {renderSavedTemplates("registrations")}
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

            {renderSavedTemplates("speakers")}
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
      {/* Select by IDs — paste a list, email exactly those registrations */}
      <Dialog open={selectByIdsOpen} onOpenChange={(o) => { setSelectByIdsOpen(o); if (!o) setMatchResult(null); }}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ListChecks className="h-5 w-5" />
              Select by IDs
            </DialogTitle>
            <DialogDescription>
              Paste registration numbers, full IDs, or emails — one per line or separated by commas.
              The matching registrations open in the email composer, ready to send.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-2">
              <Label htmlFor="comm-paste-ids">IDs / emails</Label>
              <Textarea
                id="comm-paste-ids"
                value={pasteIds}
                onChange={(e) => { setPasteIds(e.target.value); setMatchResult(null); }}
                placeholder={"002\n005\njane@example.com"}
                rows={7}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Matches a registration #, the full registration ID, or the attendee email.
              </p>
            </div>
            {matchResult && (
              <div className="rounded-md border bg-muted/40 p-3 text-sm">
                <p className="font-medium">
                  {matchResult.matched.length} matched
                  {matchResult.unmatched.length > 0 && ` · ${matchResult.unmatched.length} not found`}
                </p>
                {matchResult.unmatched.length > 0 && (
                  <p className="mt-1 break-words text-xs text-muted-foreground">
                    Not found: {matchResult.unmatched.slice(0, 30).join(", ")}
                    {matchResult.unmatched.length > 30 ? ` … (+${matchResult.unmatched.length - 30})` : ""}
                  </p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setSelectByIdsOpen(false); setMatchResult(null); }}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={handleMatchPastedIds} disabled={!pasteIds.trim()}>
              Match
            </Button>
            <Button
              onClick={applyPastedSelection}
              disabled={!pasteIds.trim() || (matchResult != null && matchResult.matched.length === 0)}
            >
              Email{matchResult ? ` ${matchResult.matched.length}` : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BulkEmailDialog
        open={emailDialogOpen}
        onOpenChange={setEmailDialogOpen}
        eventId={eventId}
        recipientType={activeAudience}
        recipientIds={activeRecipientIds}
        recipientCount={
          activeSelectionMode === "selected"
            ? activeRecipientIds.length
            : getAudienceCount(activeAudience)
        }
        selectionMode={activeSelectionMode}
        statusFilter={activeStatusFilter}
        paymentStatusFilter={activePaymentStatusFilter}
        ticketTypeFilter={activeTicketTypeFilter}
        badgeTypesFilter={activeBadgeTypesFilter}
        tagsFilter={activeTagsFilter}
        badgeOptions={badgeTypes}
        agreementSignedFilter={activeAgreementSignedFilter}
        hasSessionFilter={activeHasSessionFilter}
        sessionRoleFilter={activeSessionRoleFilter}
        defaultEmailType={activeDefaultEmailType}
        recipientCountFor={recipientCountFor}
      />
    </div>
  );
}
