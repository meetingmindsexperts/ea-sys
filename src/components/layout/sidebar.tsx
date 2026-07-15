"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import { useOrgBranding, useOrganizations, useEvent } from "@/hooks/use-api";
import { useActiveOrg } from "@/contexts/active-org-context";
import { webinarModuleFilter } from "@/lib/webinar";
import {
  Home,
  Settings,
  Mic,
  Building2,
  LayoutDashboard,
  LayoutGrid,
  ChevronLeft,
  ChevronRight,
  FileText,
  Clock,
  UserCheck,
  Users,
  BookUser,
  Receipt,
  Calendar,
  ScrollText,
  ScanBarcode,
  Activity,
  Mail,
  Bot,
  ChevronsUpDown,
  ImageIcon,
  Video,
  ClipboardCheck,
  HelpCircle,
  BarChart3,
  BookOpen,
  Cpu,
  Handshake,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { canViewFinance } from "@/lib/finance-visibility";
import { canViewCrm } from "@/crm/lib/crm-roles";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/contexts/sidebar-context";
import { useHelpChatLauncher } from "@/components/help-chat/help-chat-provider";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const navigation: { name: string; href: string; icon: React.ComponentType<{ className?: string }>; superAdminOnly?: boolean; adminOnly?: boolean; financeOnly?: boolean; crmOnly?: boolean }[] = [
  { name: "Dashboard", href: "/dashboard", icon: Home },
  { name: "Events",    href: "/events",    icon: Calendar },
  { name: "Contacts",  href: "/contacts",  icon: BookUser },
  // CRM (docs/CRM_MODULE_PLAN.md). One of the three permitted core-side touch
  // points for the module (§7.0) — hence the @/crm import below, which the
  // ESLint import-boundary rule exempts this file for, deliberately.
  // Gated on canViewCrm, NOT on an existing predicate: MEMBER may see the board
  // (leadership) but ONSITE may not (a desk temp must not hold the sponsorship
  // pipeline), which matches no other role set in the app.
  { name: "CRM",       href: "/crm",       icon: Handshake, crmOnly: true },
  { name: "Invoices",  href: "/invoices",  icon: Receipt, financeOnly: true },
  { name: "Media",     href: "/media",     icon: ImageIcon },
  { name: "Settings",  href: "/settings",  icon: Settings },
  { name: "Logs",      href: "/logs",      icon: ScrollText, superAdminOnly: true },
  { name: "Activity",  href: "/activity",  icon: Activity, superAdminOnly: true },
  // Docs viewer is open to ADMIN + SUPER_ADMIN (not just SUPER_ADMIN
  // like Logs + Activity). Operationally useful for org admins to
  // self-serve on architecture / runbook / handover material;
  // contains no secrets (gitignore excludes .env files + screenshots
  // + the interview-prep file).
  { name: "Docs",      href: "/admin/docs", icon: BookOpen, adminOnly: true },
  { name: "Infra / Ops", href: "/admin/infra", icon: Cpu, adminOnly: true },
];

// Event nav split into sections for visual grouping
type EventNavItem = {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  webinarOnly?: boolean;
  /** Only shown to finance-capable roles (canViewFinance). */
  financeOnly?: boolean;
};

const eventNavigationSections: { label: string; items: EventNavItem[] }[] = [
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
const eventNavigation = eventNavigationSections.flatMap((s) => s.items);

export function Sidebar() {
  const pathname = usePathname();
  const { isCollapsed, toggleSidebar } = useSidebar();
  const helpChat = useHelpChatLauncher();
  const { data: session } = useSession();
  const { data: branding } = useOrgBranding();
  const qc = useQueryClient();
  const { activeOrgId, setActiveOrgId, isOrgOverride } = useActiveOrg();
  const orgLogo = branding?.logo ?? null;
  const orgName = branding?.name ?? session?.user?.organizationName ?? null;
  const isSuperAdmin  = session?.user?.role === "SUPER_ADMIN";
  const isReviewer    = session?.user?.role === "REVIEWER";
  const isSubmitter   = session?.user?.role === "SUBMITTER";
  const isRegistrant  = session?.user?.role === "REGISTRANT";
  const isOnsite      = session?.user?.role === "ONSITE";
  const isCrmUser     = session?.user?.role === "CRM_USER";
  const isRestricted  = isReviewer || isSubmitter;
  const canFinance    = canViewFinance(session?.user?.role);
  const canCrm        = canViewCrm(session?.user?.role);

  // Fetch all orgs for SUPER_ADMIN switcher
  const { data: allOrgs } = useOrganizations(isSuperAdmin);

  const eventMatch = pathname.match(/^\/events\/([^/]+)/);
  const eventId    = eventMatch ? eventMatch[1] : null;
  const isEventPage = Boolean(eventId && eventId !== "new");

  // Fetch event to know eventType (cached by React Query across navigation).
  // Skip fetch on non-event pages and for restricted roles whose sidebar doesn't branch.
  const { data: currentEvent } = useEvent(isEventPage && !isRestricted && !isOnsite && !isCrmUser ? (eventId as string) : "");
  const webinarFilter = webinarModuleFilter(currentEvent?.eventType ?? null);

  const handleOrgSwitch = (orgId: string | null) => {
    setActiveOrgId(orgId);
    // Invalidate all cached queries so they refetch with the new org header
    setTimeout(() => qc.invalidateQueries(), 50);
  };

  // REGISTRANT sees no sidebar — only the portal page
  if (isRegistrant) return null;

  const restrictedNavigation: typeof navigation = isReviewer
    ? [
        { name: "My Reviews", href: "/my-reviews", icon: ClipboardCheck },
        ...navigation.filter((item) => ["Events"].includes(item.name)),
      ]
    : navigation.filter((item) => ["Events"].includes(item.name));
  const restrictedEventItems = eventNavigation.filter((item) => ["Abstracts"].includes(item.name));
  // ONSITE (registration-desk) sees only the events list + a chosen event's
  // Registrations + Check-In. Everything else is hidden here and redirected by
  // the middleware.
  const onsiteEventItems = eventNavigation.filter((item) =>
    ["Registrations", "Check-In"].includes(item.name)
  );
  const eventsOnlyNavigation = navigation.filter((item) => ["Events"].includes(item.name));

  const isAdmin = session?.user?.role === "ADMIN" || isSuperAdmin;

  // CRM_USER is confined to the CRM — the sidebar shows only that entry.
  const crmOnlyNavigation = navigation.filter((item) => ["CRM"].includes(item.name));
//this section to be reviewed, to much nesting, maybe can be simplified start
  const baseNavigation = isCrmUser
    ? crmOnlyNavigation
    : isOnsite
    ? eventsOnlyNavigation
    : isRestricted
      ? restrictedNavigation
      : navigation.filter((item) => {
          if (item.superAdminOnly && !isSuperAdmin) return false;
          if (item.adminOnly && !isAdmin) return false;
          if (item.financeOnly && !canFinance) return false;
          if (item.crmOnly && !canCrm) return false;
          return true;
        });

  // Build sections for event nav
  const visibleEventSections = isOnsite
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

  const flatEventItems = visibleEventSections.flatMap((s) =>
    s.items.map((item) => ({ ...item, href: `/events/${eventId}${item.href}` }))
  );
//this section to be reviewed, to much nesting, maybe can be simplified end

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          "flex h-full flex-col border-r bg-background transition-all duration-300",
          isCollapsed ? "w-16" : "w-56"
        )}
      >
        {/* ── Logo ─────────────────────────────────────────────────────────── */}
        <div className="flex h-16 items-center border-b px-4 bg-white shrink-0">
          <Link
            href="/dashboard"
            className={cn("flex items-center gap-3 min-w-0", isCollapsed && "justify-center w-full")}
          >
            {orgLogo ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={orgLogo}
                alt={orgName || "Organization"}
                className={cn("object-contain shrink-0", isCollapsed ? "h-8 w-8" : "h-9 max-w-[60px]")}
              />
            ) : isCollapsed ? (
              <span className="text-sm font-bold text-primary">
                {(orgName || "E")[0]}
              </span>
            ) : null}
            {!isCollapsed && (
              <span className={cn(
                "text-[11px] font-semibold text-primary/80 tracking-wide uppercase shrink-0 leading-tight line-clamp-2",
                orgLogo && "border-l border-border pl-3"
              )}>
                {orgName || "EventsHub"}
              </span>
            )}
          </Link>
        </div>

        {/* ── Org Switcher (SUPER_ADMIN only) ──────────────────────────────── */}
        {isSuperAdmin && allOrgs && allOrgs.length > 1 && !isCollapsed && (
          <div className="border-b px-3 py-2 shrink-0">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className={cn(
                  "flex items-center justify-between w-full rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted",
                  isOrgOverride && "bg-amber-50 text-amber-700 border border-amber-200"
                )}>
                  <div className="flex items-center gap-2 min-w-0">
                    <Building2 className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate font-medium">{orgName || "Select Org"}</span>
                  </div>
                  <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel className="text-xs">Switch Organization</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => handleOrgSwitch(null)}
                  className={!activeOrgId ? "bg-muted" : ""}
                >
                  <Building2 className="mr-2 h-4 w-4" />
                  <div>
                    <div className="font-medium">My Organization</div>
                    <div className="text-xs text-muted-foreground">
                      {session?.user?.organizationName}
                    </div>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {allOrgs.map((org) => (
                  <DropdownMenuItem
                    key={org.id}
                    onClick={() => handleOrgSwitch(
                      org.id === session?.user?.organizationId ? null : org.id
                    )}
                    className={activeOrgId === org.id ? "bg-muted" : ""}
                  >
                    {org.logo ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={org.logo} alt="" className="mr-2 h-4 w-4 object-contain" />
                    ) : (
                      <Building2 className="mr-2 h-4 w-4" />
                    )}
                    <div className="min-w-0">
                      <div className="font-medium truncate">{org.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {org._count.events} events · {org._count.users} users
                      </div>
                    </div>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        {isSuperAdmin && allOrgs && allOrgs.length > 1 && isCollapsed && (
          <div className="border-b px-2 py-2 shrink-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Switch organization"
                  onClick={() => handleOrgSwitch(null)}
                  className={cn(
                    "flex items-center justify-center w-full rounded-md p-1.5 transition-colors hover:bg-muted",
                    isOrgOverride && "bg-amber-50 text-amber-700"
                  )}
                >
                  <Building2 className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                {isOrgOverride ? `Viewing: ${orgName}` : "My Organization"}
              </TooltipContent>
            </Tooltip>
          </div>
        )}

        {/* ── Back link (event context) ─────────────────────────────────────── */}
        {isEventPage && !isCollapsed && (
          <div className="border-b px-3 py-2 bg-muted/30 shrink-0">
            <Link
              href="/events"
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
            >
              <ChevronLeft className="h-3 w-3" />
              Back to Events
            </Link>
          </div>
        )}

        {/* ── Navigation ───────────────────────────────────────────────────── */}
        <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-0.5">
          {isEventPage ? (
            /* Event-scoped sections */
            isCollapsed ? (
              // Collapsed: flat list with tooltips
              flatEventItems.map((item) => {
                const isActive =
                  item.href === `/events/${eventId}`
                    ? pathname === `/events/${eventId}`
                    : pathname.startsWith(item.href);
                return (
                  <Tooltip key={item.name}>
                    <TooltipTrigger asChild>
                      <Link
                        href={item.href}
                        className={cn(
                          "flex items-center justify-center rounded-lg p-2 transition-colors",
                          isActive
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground"
                        )}
                      >
                        <item.icon className="h-5 w-5" />
                      </Link>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="font-medium">
                      {item.name}
                    </TooltipContent>
                  </Tooltip>
                );
              })
            ) : (
              // Expanded: sectioned with labels
              visibleEventSections.map((section, si) => (
                // Key by index, not label — TWO sections have an empty label
                // (Overview at top, Analytics at bottom). Keying both as "top"
                // collided, breaking React reconciliation so the Overview row
                // leaked a duplicate on every client-side navigation.
                <div key={`section-${si}`} className={cn(si > 0 && "pt-3")}>
                  {section.label && (
                    <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                      {section.label}
                    </p>
                  )}
                  {section.items.map((item) => {
                    const href = `/events/${eventId}${item.href}`;
                    const isActive =
                      href === `/events/${eventId}`
                        ? pathname === `/events/${eventId}`
                        : pathname.startsWith(href);
                    return (
                      <Link
                        key={item.name}
                        href={href}
                        className={cn(
                          "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                          isActive
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground"
                        )}
                      >
                        <item.icon className="h-4 w-4 shrink-0" />
                        {item.name}
                      </Link>
                    );
                  })}
                </div>
              ))
            )
          ) : (
            /* Top-level nav */
            baseNavigation.map((item) => {
              const isActive = pathname.startsWith(item.href);
              const navLink = (
                <Link
                  key={item.name}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                    isCollapsed && "justify-center px-2",
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  <item.icon className="h-5 w-5 shrink-0" />
                  {!isCollapsed && item.name}
                </Link>
              );

              if (isCollapsed) {
                return (
                  <Tooltip key={item.name}>
                    <TooltipTrigger asChild>{navLink}</TooltipTrigger>
                    <TooltipContent side="right" className="font-medium">
                      {item.name}
                    </TooltipContent>
                  </Tooltip>
                );
              }
              return navLink;
            })
          )}
        </nav>

        {/* ── Footer: Help + Collapse ─────────────────────────────────────── */}
        <div className="border-t p-2 shrink-0 space-y-1">
          {/* Help — opens the help-chat drawer (NOT a route).
              Available to every authenticated role; reviewers /
              submitters / registrants need help too. Visually a peer
              of Collapse so it's always reachable regardless of which
              nav mode (top-level vs event) is active. */}
          {isCollapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={helpChat.open}
                  className="w-full justify-center text-muted-foreground hover:text-foreground"
                  aria-label="Help"
                >
                  <HelpCircle className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" className="font-medium">
                Help
              </TooltipContent>
            </Tooltip>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={helpChat.open}
              className="w-full justify-start text-muted-foreground hover:text-foreground"
            >
              <HelpCircle className="h-4 w-4 mr-2" />
              Help
            </Button>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={toggleSidebar}
            className={cn("w-full justify-center text-muted-foreground hover:text-foreground", !isCollapsed && "justify-start")}
          >
            {isCollapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <>
                <ChevronLeft className="h-4 w-4 mr-2" />
                Collapse
              </>
            )}
          </Button>
        </div>
      </aside>
    </TooltipProvider>
  );
}
