/**
 * What the sidebar shows, as a pure function of who is signed in and where
 * they are: extracted from sidebar.tsx verbatim (custom roles Phase 3, Oct 5,
 * 2026) so it can be snapshotted for every role and context
 * (__tests__/components/sidebar-nav.test.ts) and then moved onto `can()`
 * without changing a single entry. Client-safe: no Node imports.
 */
import type React from "react";
import {
  Activity,
  BarChart3,
  BookUser,
  Bot,
  Building2,
  Calendar,
  CalendarClock,
  ClipboardCheck,
  Clock,
  Cpu,
  DatabaseBackup,
  FileCode2,
  FileText,
  Handshake,
  Home,
  ImageIcon,
  LayoutDashboard,
  LayoutGrid,
  Lightbulb,
  Mail,
  MessageCircleQuestion,
  MessagesSquare,
  Mic,
  Receipt,
  ScanBarcode,
  ScanSearch,
  ScrollText,
  Settings,
  UserCheck,
  Users,
  Video,
  Wallet,
} from "lucide-react";
import { webinarModuleFilter, WEBINARS_ROLE_HIDDEN_MODULES } from "@/lib/webinar";
import { submitterSeesAbstracts, submitterSeesProposals } from "@/lib/submitter-surfaces";
import { canViewFinance } from "@/lib/finance-visibility";
import { canViewCrm } from "@/crm/lib/crm-roles";
import { canUseAgent } from "@/lib/agent/agent-roles";
import { canViewHr } from "@/lib/hr-visibility";
import { canViewProcurement, hasAnyProcurementGrant } from "@/lib/procurement-visibility";
import { isOrgAdmin } from "@/lib/team-roles";

// Surface the CRM entry in the normal staff sidebar (for roles with `canCrm`).
// Flip to `false` to hide it again (a one-line reversal). A dedicated CRM_USER
// is unaffected either way — they're confined to the CRM and always get the CRM
// entry (see crmOnlyNavigation below).
const CRM_IN_SIDEBAR = true;

export const navigation: { name: string; href: string; icon: React.ComponentType<{ className?: string }>; superAdminOnly?: boolean; adminOnly?: boolean; financeOnly?: boolean; crmOnly?: boolean; agentOnly?: boolean; hrOnly?: boolean; procurementOnly?: boolean; external?: boolean }[] = [
  { name: "Dashboard", href: "/dashboard", icon: Home },
  { name: "Events",    href: "/events",    icon: Calendar },
  // App-wide public-site traffic (Sep 25, 2026). No flag: the data is scoped
  // by buildEventAccessWhere on the server, and the confined roles never get
  // this list (they have their own sidebars).
  { name: "Analytics", href: "/analytics", icon: BarChart3 },
  { name: "Contacts",  href: "/contacts",  icon: BookUser },
  // CRM (docs/CRM_MODULE_PLAN.md). One of the three permitted core-side touch
  // points for the module (§7.0) — hence the @/crm import below, which the
  // ESLint import-boundary rule exempts this file for, deliberately.
  // Gated on canViewCrm, NOT on an existing predicate: MEMBER may see the board
  // (leadership) but ONSITE may not (a desk temp must not hold the sponsorship
  // pipeline), which matches no other role set in the app.
  { name: "CRM",       href: "/crm",       icon: Handshake, crmOnly: true },
  // HR is gated on BOTH the role and the deployment flag. The role check alone
  // would show an ADMIN on the platform instance a link that 404s, because the
  // module is master-silo only.
  { name: "HR",        href: "/hr",        icon: CalendarClock, hrOnly: true },
  // Budget & Procurement: the deployment flag AND the same predicate the API
  // guard asks (org staff read; a grant alone also reads), never a role list.
  { name: "Budgets",   href: "/procurement", icon: Wallet, procurementOnly: true },
  { name: "Invoices",  href: "/invoices",  icon: Receipt, financeOnly: true },
  { name: "Media",     href: "/media",     icon: ImageIcon },
  // The org-level door of the Event Agent (Sep 21, 2026): the same four
  // roles the per-event entry admits; canUseAgent is the one list.
  { name: "AI Agent",  href: "/agent",     icon: Bot, agentOnly: true },
  { name: "Settings",  href: "/settings",  icon: Settings },
  { name: "Logs",      href: "/logs",      icon: ScrollText, superAdminOnly: true },
  // Sits under Logs because that is where the need arises: log lines name
  // rows by id, so the operator reading them is the one who needs an id
  // resolved. It reads across every tenant, hence superAdminOnly like Logs.
  { name: "ID Lookup", href: "/admin/lookup", icon: ScanSearch, superAdminOnly: true },
  // The DR bucket holds every uploaded file, private documents included:
  // superAdminOnly, and the API re-checks the platform-operator boundary.
  { name: "Backups", href: "/admin/backups", icon: DatabaseBackup, superAdminOnly: true },
  { name: "Help Queries", href: "/admin/help-queries", icon: MessageCircleQuestion, superAdminOnly: true },
  // The Event Agent's stored conversations (message, reply, each tool's
  // input): attendee data, so operator-only like Help Queries.
  { name: "Agent Messages", href: "/admin/agent-messages", icon: MessagesSquare, superAdminOnly: true },
  // adminOnly, NOT superAdminOnly: the /activity page itself has always allowed
  // ADMIN, so a SUPER_ADMIN-only link left org admins reaching it by URL alone.
  // It also now hosts the Sign-in Activity tab, whose own gate
  // (canViewLoginActivity) is exactly ADMIN + SUPER_ADMIN.
  { name: "Activity",  href: "/activity",  icon: Activity, adminOnly: true },
  // The user guide (public/user-guide.html) is reached through the help chat,
  // which answers from it; its sidebar link was removed on Sep 14 2026 at the
  // owner's request. `external` stays on the nav item type for the next
  // static-file link.
  // Docs viewer: PLATFORM OPERATOR only since Aug 21 2026, narrowed from ADMIN.
  // It serves every .md and .html in the repository — incident log, AWS runbook
  // with instance ids, the rebuild-production procedure, our security posture
  // and multi-tenancy strategy. The old comment justified ADMIN access because
  // it "contains no secrets", which held while every ADMIN was an MMG employee
  // and stops holding the moment ADMIN can mean a customer.
  { name: "Docs",      href: "/admin/docs", icon: FileCode2, superAdminOnly: true },
  // Infra / Ops stays adminOnly: a tenant ADMIN reaching it now gets a SERVICE
  // HEALTH view of their own queues, failed emails and live events. Every host,
  // AWS, DR, deploy and alarm panel is operator-only and is not even fetched
  // for a tenant, so their page view raises no CloudWatch or SES calls.
  { name: "Infra / Ops", href: "/admin/infra", icon: Cpu, adminOnly: true },
];

// Event nav split into sections for visual grouping
export type EventNavItem = {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  webinarOnly?: boolean;
  /** Only shown to finance-capable roles (canViewFinance). */
  financeOnly?: boolean;
};

export const eventNavigationSections: { label: string; items: EventNavItem[] }[] = [
  {
    label: "",
    items: [
      { name: "Overview", href: "", icon: LayoutDashboard },
      { name: "Webinar Console", href: "/webinar", icon: Video, webinarOnly: true },
    ],
  },
  {
    label: "Manage",
    items: [
      // Daily-use items only. Registration Types moved to Setup hub
      // (see /events/[id]/setup) since it's a configure-once flow that
      // operators rarely revisit after registration opens. Analytics
      // moved to its own bottom-of-sidebar Insights section since
      // it's a different persona (reports viewers / MEMBER role)
      // than the daily registration/program teams using this section.
      { name: "Registrations", href: "/registrations", icon: Users },
      { name: "Check-In",      href: "/check-in",      icon: ScanBarcode },
      { name: "Speakers",      href: "/speakers",      icon: Mic },
      { name: "Agenda",        href: "/agenda",        icon: Clock },
      { name: "Accommodation", href: "/accommodation", icon: Building2 },
    ],
  },
  {
    label: "Abstracts",
    items: [
      { name: "Abstracts", href: "/abstracts", icon: FileText },
      { name: "Session Proposals", href: "/session-proposals", icon: Lightbulb },
      { name: "Reviewers", href: "/reviewers", icon: UserCheck },
    ],
  },
  {
    label: "Tools",
    items: [
      // Communications stays here — operational, used daily for
      // sending registration confirmations, scheduled reminders, etc.
      // AI Agent stays here — power tool, occasionally used but
      // high-value showcase feature.
      // Survey + Certificates + Media + Sponsors moved to Setup hub
      // (see /events/[id]/setup) — configure-once or
      // post-event-only workflows that don't belong in a daily sidebar.
      { name: "Communications", href: "/communications", icon: Mail },
      { name: "AI Agent",       href: "/agent",          icon: Bot },
    ],
  },
  {
    label: "Setup",
    items: [
      // Single hub entry for non-daily items. Lands on
      // /events/[id]/setup which renders a 6-card grid (Registration
      // Types, Content, Sponsors, Survey, Certificates, Media) with
      // status pills. Settings keeps its direct sidebar link below
      // because admin daily-use overlaps but doesn't equal "event
      // configuration" — they're different audiences.
      { name: "Event Setup", href: "/setup",    icon: LayoutGrid },
      { name: "Settings",    href: "/settings",  icon: Settings },
    ],
  },
  {
    // Bottom-of-sidebar standalone. Analytics has a different persona
    // (reports viewers / MEMBER role) than the daily operational
    // sections above. Empty label = no section header rendered (see
    // the `{section.label && ...}` guard in the render below), so
    // Analytics sits visually separate without needing its own
    // "Insights"/"Reports" group title — single item doesn't justify
    // the header weight.
    label: "",
    items: [
      { name: "Analytics", href: "/analytics", icon: BarChart3 },
    ],
  },
];

// Flat version used for restricted roles and tooltip matching
export const eventNavigation = eventNavigationSections.flatMap((s) => s.items);

/** Module names the WEBINARS role never sees, whatever the event type.
 *  Module-level so the Set is allocated once, not on every render. */
const webinarsRoleHidden = new Set<string>(WEBINARS_ROLE_HIDDEN_MODULES);

export interface SidebarNavInput {
  /** The signed-in user as the session carries it (role, organisation, grants, custom keys). */
  user: (Record<string, unknown> & { role?: string | null }) | null | undefined;
  hrEnabled: boolean;
  procurementEnabled: boolean;
  /** On an event page: the event once loaded, `undefined` while loading. */
  isEventPage: boolean;
  currentEvent: { eventType?: string | null } | null | undefined;
  /** The SUBMITTER's surface context, `undefined` while loading. */
  submitterCtx: Parameters<typeof submitterSeesAbstracts>[0] | null | undefined;
}

export interface SidebarNav {
  baseNavigation: typeof navigation;
  visibleEventSections: { label: string; items: EventNavItem[] }[];
  /** No sidebar at all (REGISTRANT). */
  hidden: boolean;
}

/** Roles whose sidebar never branches on the event, so the event is not fetched. */
export function sidebarSkipsEventFetch(role: string | null | undefined): boolean {
  const isReviewer = role === "REVIEWER";
  const isSubmitter = role === "SUBMITTER";
  const isOnsite = role === "ONSITE";
  const isCrmUser = role === "CRM_USER";
  const isRestricted = isReviewer || isSubmitter;
  return isRestricted || isOnsite || isCrmUser;
}

export function computeSidebarNav(input: SidebarNavInput): SidebarNav {
  const { user, hrEnabled, procurementEnabled, currentEvent, submitterCtx } = input;
  const role = user?.role;
  const isSuperAdmin  = role === "SUPER_ADMIN";
  const isReviewer    = role === "REVIEWER";
  const isSubmitter   = role === "SUBMITTER";
  const isRegistrant  = role === "REGISTRANT";
  const isOnsite      = role === "ONSITE";
  const isCrmUser     = role === "CRM_USER";
  const isWebinars    = role === "WEBINARS";
  const isOrganizer   = role === "ORGANIZER";
  const isRestricted  = isReviewer || isSubmitter;
  const canFinance    = canViewFinance(role);
  const canCrm        = canViewCrm(role);
  const canAgent      = canUseAgent(role);
  const canHr         = hrEnabled && canViewHr(user as Parameters<typeof canViewHr>[0]);
  const canProcurement = procurementEnabled && canViewProcurement(user as Parameters<typeof canViewProcurement>[0]);
  const isHrUser      = role === "HR_USER";
  const webinarFilter = webinarModuleFilter(currentEvent?.eventType ?? null);

  // REGISTRANT sees no sidebar — only the portal page
  if (isRegistrant) return { baseNavigation: [], visibleEventSections: [], hidden: true };

  const restrictedNavigation: typeof navigation = isReviewer
    ? [
        { name: "My Reviews", href: "/my-reviews", icon: ClipboardCheck },
        ...navigation.filter((item) => ["Events"].includes(item.name)),
      ]
    : navigation.filter((item) => ["Events"].includes(item.name));
  // Submitter surface separation (July 30, 2026): a SUBMITTER sees only the
  // surface their signup flow covers (abstracts vs session proposals), plus
  // any surface where they actually have content — one truth table shared
  // with the page redirect guard (src/lib/submitter-surfaces.ts). While the
  // context is loading we show NEITHER (a brief blank beats flashing the
  // surface the person must not see). Reviewers keep the static pair.
  const restrictedEventItems = eventNavigation
    .filter((item) => ["Abstracts", "Session Proposals"].includes(item.name))
    .filter((item) => {
      if (!isSubmitter) return true;
      if (!submitterCtx) return false;
      return item.name === "Abstracts"
        ? submitterSeesAbstracts(submitterCtx)
        : submitterSeesProposals(submitterCtx);
    });
  // ONSITE (registration-desk) sees only the events list + a chosen event's
  // Registrations + Check-In. Everything else is hidden here and redirected by
  // the middleware.
  const onsiteEventItems = eventNavigation.filter((item) =>
    ["Registrations", "Check-In"].includes(item.name)
  );
  const eventsOnlyNavigation = navigation.filter((item) => ["Events"].includes(item.name));

  const isAdmin = isOrgAdmin(role);

  // CRM_USER is confined to the CRM — the sidebar shows only that entry.
  const crmOnlyNavigation = navigation.filter((item) => ["CRM"].includes(item.name));
  // HR_USER is confined to the HR module — the sidebar shows only that entry.
  const hrOnlyNavigation = navigation.filter((item) => ["HR"].includes(item.name));

  const baseNavigation = isHrUser
    ? hrOnlyNavigation
    : isCrmUser
    ? crmOnlyNavigation
    : isWebinars
    ? // Events, plus Budgets for a webinars user given procurement access (owner, Sep 15 2026).
      [...eventsOnlyNavigation, ...navigation.filter((item) => item.procurementOnly && canProcurement)]
    : isOnsite
    ? eventsOnlyNavigation
    : isRestricted
      ? restrictedNavigation
      : navigation.filter((item) => {
          if (item.superAdminOnly && !isSuperAdmin) return false;
          if (item.adminOnly && !isAdmin) return false;
          if (item.financeOnly && !canFinance) return false;
          if (item.crmOnly && (!canCrm || !CRM_IN_SIDEBAR)) return false;
          if (item.agentOnly && !canAgent) return false;
          // Organizers run events, not the sales pipeline or budgets (owner, Sep 15 2026).
          // SIDEBAR ONLY, by owner decision: the pages and APIs still answer an organizer
          // as before. An organizer holding a procurement grant still sees Budgets.
          if (item.crmOnly && isOrganizer) return false;
          if (item.procurementOnly && isOrganizer && !hasAnyProcurementGrant(user as Parameters<typeof hasAnyProcurementGrant>[0])) return false;
          if (item.hrOnly && !canHr) return false;
          if (item.procurementOnly && !canProcurement) return false;
          return true;
        });

  // Build sections for event nav.
  // WEBINARS (webinar team, Aug 3 2026) is TWO-TIER: on a WEBINAR event it
  // gets the full organizer-style module set (the webinarFilter hides the
  // conference-only modules anyway); on a conference it gets the ONSITE desk
  // pair. While the event is still loading, show NOTHING — a brief blank
  // beats flashing modules the role may not have (the submitter pattern).
  const visibleEventSections = isWebinars
    ? currentEvent === undefined
      ? []
      : currentEvent?.eventType === "WEBINAR"
        ? eventNavigationSections
            .map((section) => ({
              ...section,
              items: section.items
                .filter(webinarFilter)
                // Then drop what the ROLE may not use regardless of event type
                // — today just the AI Agent, whose API refuses this role.
                .filter((item) => !webinarsRoleHidden.has(item.name)),
            }))
            .filter((section) => section.items.length > 0)
        : [{ label: "Manage", items: onsiteEventItems }]
    : isOnsite
    ? [{ label: "Manage", items: onsiteEventItems }]
    : isRestricted
      ? [{ label: "Abstracts", items: restrictedEventItems }]
      : eventNavigationSections
          .map((section) => ({
            ...section,
            items: section.items
              .filter(webinarFilter)
              .filter((item) => !item.financeOnly || canFinance),
          }))
          .filter((section) => section.items.length > 0);

  return { baseNavigation, visibleEventSections, hidden: false };
}
