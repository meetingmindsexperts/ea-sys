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
  ClipboardList,
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
import { webinarModuleFilter } from "@/lib/webinar";
import { submitterSeesAbstracts, submitterSeesProposals } from "@/lib/submitter-surfaces";
import { holdsCustomProcurementKey } from "@/lib/procurement-visibility";
import { can, inArea, principalFromUser, type EventFacts } from "@/lib/permissions/can";
import type { PermissionKey } from "@/lib/permissions/catalogue";
import type { Area } from "@/lib/permissions/system-roles";

// Surface the CRM entry in the normal staff sidebar (for roles with `canCrm`).
// Flip to `false` to hide it again (a one-line reversal). A dedicated CRM_USER
// is unaffected either way — they're confined to the CRM and always get the CRM
// entry (see crmOnlyNavigation below).
const CRM_IN_SIDEBAR = true;

export interface NavItem {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  /** The area(s) of the app it belongs to: shown only to a principal working in one. */
  areas: readonly Area[];
  /** Shown only when one of these keys is held (none: the area is enough). */
  keys?: readonly PermissionKey[];
  /** The module behind a deployment flag. */
  crmOnly?: boolean;
  hrOnly?: boolean;
  procurementOnly?: boolean;
  blueprintOnly?: boolean;
  external?: boolean;
}

const PROCUREMENT_VIEW_KEYS: readonly PermissionKey[] = ["procurement.budgets.view", "procurement.requests.view", "procurement.orders.view", "procurement.suppliers.view"];

export const navigation: NavItem[] = [
  { name: "Dashboard", href: "/dashboard", icon: Home, areas: ["dashboard"] },
  { name: "Events",    href: "/events",    icon: Calendar, areas: ["events", "desk"] },
  // App-wide public-site traffic (Sep 25, 2026). No flag: the data is scoped
  // by buildEventAccessWhere on the server, and the confined roles never get
  // this list (they have their own sidebars).
  { name: "Analytics", href: "/analytics", icon: BarChart3, areas: ["org"], keys: ["analytics.read"] },
  { name: "Contacts",  href: "/contacts",  icon: BookUser, areas: ["org"], keys: ["contacts.read"] },
  // CRM (docs/CRM_MODULE_PLAN.md). One of the three permitted core-side touch
  // points for the module (§7.0) — hence the @/crm import below, which the
  // ESLint import-boundary rule exempts this file for, deliberately.
  // Gated on canViewCrm, NOT on an existing predicate: MEMBER may see the board
  // (leadership) but ONSITE may not (a desk temp must not hold the sponsorship
  // pipeline), which matches no other role set in the app.
  { name: "CRM",       href: "/crm",       icon: Handshake, areas: ["crm"], keys: ["crm.read"], crmOnly: true },
  // HR is gated on BOTH the role and the deployment flag. The role check alone
  // would show an ADMIN on the platform instance a link that 404s, because the
  // module is master-silo only.
  { name: "HR",        href: "/hr",        icon: CalendarClock, areas: ["hr"], keys: ["hr.read"], hrOnly: true },
  // Budget & Procurement: the deployment flag AND the same predicate the API
  // guard asks (org staff read; a grant alone also reads), never a role list.
  { name: "Budgets",   href: "/procurement", icon: Wallet, areas: ["procurement"], keys: PROCUREMENT_VIEW_KEYS, procurementOnly: true },
  // Event Blueprint (docs/EVENT_BLUEPRINT_PLAN.md): the deployment flag AND
  // `blueprints.view`, the key every /api/blueprint read asks. The page lives
  // outside the dashboard shell, so the link leaves it.
  { name: "Blueprints", href: "/blueprint", icon: ClipboardList, areas: ["org"], keys: ["blueprints.view"], blueprintOnly: true },
  { name: "Invoices",  href: "/invoices",  icon: Receipt, areas: ["org"], keys: ["invoices.ledger"] },
  { name: "Media",     href: "/media",     icon: ImageIcon, areas: ["org"], keys: ["media.library.manage"] },
  // The org-level door of the Event Agent (Sep 21, 2026): the same four
  // roles the per-event entry admits; canUseAgent is the one list.
  { name: "AI Agent",  href: "/agent",     icon: Bot, areas: ["org"], keys: ["agent.use"] },
  { name: "Settings",  href: "/settings",  icon: Settings, areas: ["org"] },
  { name: "Logs",      href: "/logs",      icon: ScrollText, areas: ["operator"] },
  // Sits under Logs because that is where the need arises: log lines name
  // rows by id, so the operator reading them is the one who needs an id
  // resolved. It reads across every tenant, hence superAdminOnly like Logs.
  { name: "ID Lookup", href: "/admin/lookup", icon: ScanSearch, areas: ["operator"] },
  // The DR bucket holds every uploaded file, private documents included:
  // superAdminOnly, and the API re-checks the platform-operator boundary.
  { name: "Backups", href: "/admin/backups", icon: DatabaseBackup, areas: ["operator"] },
  { name: "Help Queries", href: "/admin/help-queries", icon: MessageCircleQuestion, areas: ["operator"] },
  // The Event Agent's stored conversations (message, reply, each tool's
  // input): attendee data, so operator-only like Help Queries.
  { name: "Agent Messages", href: "/admin/agent-messages", icon: MessagesSquare, areas: ["operator"] },
  // adminOnly, NOT superAdminOnly: the /activity page itself has always allowed
  // ADMIN, so a SUPER_ADMIN-only link left org admins reaching it by URL alone.
  // It also now hosts the Sign-in Activity tab, whose own gate
  // (canViewLoginActivity) is exactly ADMIN + SUPER_ADMIN.
  { name: "Activity",  href: "/activity",  icon: Activity, areas: ["org"], keys: ["activity.org.read"] },
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
  { name: "Docs",      href: "/admin/docs", icon: FileCode2, areas: ["operator"] },
  // Infra / Ops stays adminOnly: a tenant ADMIN reaching it now gets a SERVICE
  // HEALTH view of their own queues, failed emails and live events. Every host,
  // AWS, DR, deploy and alarm panel is operator-only and is not even fetched
  // for a tenant, so their page view raises no CloudWatch or SES calls.
  { name: "Infra / Ops", href: "/admin/infra", icon: Cpu, areas: ["org"], keys: ["org.settings"] },
];

// Event nav split into sections for visual grouping
export type EventNavItem = {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  webinarOnly?: boolean;
  /** Shown in the event workspace only when this key is held for the event. */
  key: PermissionKey;
};

export const eventNavigationSections: { label: string; items: EventNavItem[] }[] = [
  {
    label: "",
    items: [
      { name: "Overview", href: "", icon: LayoutDashboard, key: "events.read" },
      { name: "Webinar Console", href: "/webinar", icon: Video, webinarOnly: true, key: "webinar.analytics.read" },
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
      { name: "Registrations", href: "/registrations", icon: Users, key: "registrations.read" },
      { name: "Check-In",      href: "/check-in",      icon: ScanBarcode, key: "registrations.checkin" },
      { name: "Speakers",      href: "/speakers",      icon: Mic, key: "speakers.read" },
      { name: "Agenda",        href: "/agenda",        icon: Clock, key: "sessions.read" },
      { name: "Accommodation", href: "/accommodation", icon: Building2, key: "accommodation.read" },
    ],
  },
  {
    label: "Abstracts",
    items: [
      { name: "Abstracts", href: "/abstracts", icon: FileText, key: "abstracts.read" },
      { name: "Session Proposals", href: "/session-proposals", icon: Lightbulb, key: "proposals.read" },
      { name: "Reviewers", href: "/reviewers", icon: UserCheck, key: "reviewers.pool.manage" },
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
      { name: "Communications", href: "/communications", icon: Mail, key: "templates.read" },
      { name: "AI Agent",       href: "/agent",          icon: Bot, key: "agent.use" },
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
      { name: "Event Setup", href: "/setup",    icon: LayoutGrid, key: "events.read" },
      { name: "Settings",    href: "/settings",  icon: Settings, key: "events.read" },
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
      { name: "Analytics", href: "/analytics", icon: BarChart3, key: "analytics.read" },
    ],
  },
];

// Flat version used for restricted roles and tooltip matching
export const eventNavigation = eventNavigationSections.flatMap((s) => s.items);


export interface SidebarNavInput {
  /** The signed-in user as the session carries it (role, organisation, grants, custom keys). */
  user: (Record<string, unknown> & { role?: string | null }) | null | undefined;
  hrEnabled: boolean;
  procurementEnabled: boolean;
  /** BLUEPRINT_MODULE_ENABLED; absent means off. */
  blueprintEnabled?: boolean;
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
  const blueprintEnabled = input.blueprintEnabled === true;
  const role = user?.role;

  // ── The outside identities: not catalogue roles (plan §1), own branches ──
  const isRegistrant = role === "REGISTRANT";
  const isReviewer = role === "REVIEWER";
  const isSubmitter = role === "SUBMITTER";
  // REGISTRANT sees no sidebar — only the portal page
  if (isRegistrant) return { baseNavigation: [], visibleEventSections: [], hidden: true };
  if (isReviewer || isSubmitter) {
    const restrictedNavigation: NavItem[] = isReviewer
      ? [
          { name: "My Reviews", href: "/my-reviews", icon: ClipboardCheck, areas: [] },
          ...navigation.filter((item) => item.name === "Events"),
        ]
      : navigation.filter((item) => item.name === "Events");
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
        return item.name === "Abstracts" ? submitterSeesAbstracts(submitterCtx) : submitterSeesProposals(submitterCtx);
      });
    return { baseNavigation: restrictedNavigation, visibleEventSections: [{ label: "Abstracts", items: restrictedEventItems }], hidden: false };
  }

  // ── Staff: the AREAS a role works in, then the KEYS it holds (custom roles
  // Phase 3, Oct 5, 2026). Same answers as the role branches this replaced,
  // pinned for every role and context by __tests__/components/sidebar-nav.test.ts.
  const p = principalFromUser((user ?? {}) as Parameters<typeof principalFromUser>[0]);
  const customKeys = (user as { procurementPermissions?: string[] } | null | undefined)?.procurementPermissions;
  const holdsAnyCustomKey = holdsCustomProcurementKey(customKeys);
  // CRM and Budgets follow the keys alone since Oct 7, 2026, when ORGANIZER
  // and MEMBER lost both as base access: an organiser's old display rule
  // would now hide a CRM a custom role gave them.

  const baseNavigation = navigation.filter((item) => {
    if (!item.areas.some((area) => inArea(p, area))) return false;
    if (item.crmOnly && !CRM_IN_SIDEBAR) return false;
    if (item.hrOnly && !hrEnabled) return false;
    if (item.blueprintOnly && !blueprintEnabled) return false;
    if (item.procurementOnly) {
      if (!procurementEnabled) return false;
      // Any custom procurement key enters the module (as canViewProcurement).
      if (holdsAnyCustomKey) return true;
    }
    return !item.keys || item.keys.some((key) => can(p, key));
  });

  // The event: its full workspace where the role works events, else the desk
  // pair. A workspace scoped by event type (WEBINARS: webinars only) waits for
  // the event to load, so the sidebar never flashes modules the role may not have.
  const eventsScoped = p.areas.some((a) => a.area === "events" && a.scope !== undefined && a.scope !== "ALL");
  const facts: EventFacts = { organizationId: p.organizationId ?? "", eventType: currentEvent?.eventType ?? "", staffUserIds: [] };
  const deskPair = eventNavigation.filter((item) => ["Registrations", "Check-In"].includes(item.name));
  const webinarFilter = webinarModuleFilter(currentEvent?.eventType ?? null);

  let visibleEventSections: { label: string; items: EventNavItem[] }[];
  if (inArea(p, "events") && currentEvent === undefined && eventsScoped) {
    visibleEventSections = [];
  } else if (inArea(p, "events", facts)) {
    visibleEventSections = eventNavigationSections
      .map((section) => ({
        ...section,
        items: section.items.filter(webinarFilter).filter((item) => can(p, item.key, { event: facts })),
      }))
      .filter((section) => section.items.length > 0);
  } else if (inArea(p, "desk")) {
    visibleEventSections = [{ label: "Manage", items: deskPair }];
  } else {
    visibleEventSections = [];
  }

  return { baseNavigation, visibleEventSections, hidden: false };
}
