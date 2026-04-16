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
  Ticket,
  Mic,
  Building2,
  LayoutDashboard,
  ChevronLeft,
  ChevronRight,
  FileText,
  Clock,
  UserCheck,
  Users,
  BookUser,
  Calendar,
  ScrollText,
  ScanBarcode,
  Activity,
  Mail,
  Bot,
  PenLine,
  ChevronsUpDown,
  ImageIcon,
  Tag,
  Video,
  Award,
  ClipboardCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/contexts/sidebar-context";
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

const navigation: { name: string; href: string; icon: React.ComponentType<{ className?: string }>; superAdminOnly?: boolean; adminOnly?: boolean }[] = [
  { name: "Dashboard", href: "/dashboard", icon: Home },
  { name: "Events",    href: "/events",    icon: Calendar },
  { name: "Contacts",  href: "/contacts",  icon: BookUser },
  { name: "Media",     href: "/media",     icon: ImageIcon },
  { name: "Settings",  href: "/settings",  icon: Settings },
  { name: "Logs",      href: "/logs",      icon: ScrollText, superAdminOnly: true },
  { name: "Activity",  href: "/activity",  icon: Activity, superAdminOnly: true },
];

// Event nav split into sections for visual grouping
type EventNavItem = {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  webinarOnly?: boolean;
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
      { name: "Registrations",     href: "/registrations", icon: Users },
      { name: "Registration Types", href: "/tickets",       icon: Ticket },
      { name: "Promo Codes",        href: "/promo-codes",   icon: Tag },
      { name: "Check-In",          href: "/check-in",      icon: ScanBarcode },
      { name: "Speakers",          href: "/speakers",      icon: Mic },
      { name: "Agenda",            href: "/agenda",        icon: Clock },
      { name: "Accommodation",     href: "/accommodation", icon: Building2 },
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
      { name: "Communications", href: "/communications", icon: Mail },
      { name: "Media",          href: "/media",          icon: ImageIcon },
      { name: "Sponsors",       href: "/sponsors",       icon: Award },
      { name: "AI Agent",       href: "/agent",          icon: Bot },
    ],
  },
  {
    label: "Config",
    items: [
      { name: "Content",  href: "/content",  icon: PenLine },
      { name: "Settings", href: "/settings", icon: Settings },
    ],
  },
];

// Flat version used for restricted roles and tooltip matching
const eventNavigation = eventNavigationSections.flatMap((s) => s.items);

export function Sidebar() {
  const pathname = usePathname();
  const { isCollapsed, toggleSidebar } = useSidebar();
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
  const isRestricted  = isReviewer || isSubmitter;

  // Fetch all orgs for SUPER_ADMIN switcher
  const { data: allOrgs } = useOrganizations(isSuperAdmin);

  const eventMatch = pathname.match(/^\/events\/([^/]+)/);
  const eventId    = eventMatch ? eventMatch[1] : null;
  const isEventPage = Boolean(eventId && eventId !== "new");

  // Fetch event to know eventType (cached by React Query across navigation).
  // Skip fetch on non-event pages and for restricted roles whose sidebar doesn't branch.
  const { data: currentEvent } = useEvent(isEventPage && !isRestricted ? (eventId as string) : "");
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

  const isAdmin = session?.user?.role === "ADMIN" || isSuperAdmin;

  const baseNavigation = isRestricted
    ? restrictedNavigation
    : navigation.filter((item) => {
        if (item.superAdminOnly && !isSuperAdmin) return false;
        if (item.adminOnly && !isAdmin) return false;
        return true;
      });

  // Build sections for event nav
  const visibleEventSections = isRestricted
    ? [{ label: "Abstracts", items: restrictedEventItems }]
    : eventNavigationSections
        .map((section) => ({
          ...section,
          items: section.items.filter(webinarFilter),
        }))
        .filter((section) => section.items.length > 0);

  const flatEventItems = visibleEventSections.flatMap((s) =>
    s.items.map((item) => ({ ...item, href: `/events/${eventId}${item.href}` }))
  );

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          "flex h-full flex-col border-r bg-background transition-all duration-300",
          isCollapsed ? "w-16" : "w-64"
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
                <div key={section.label || "top"} className={cn(si > 0 && "pt-3")}>
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

        {/* ── Collapse Toggle ───────────────────────────────────────────────── */}
        <div className="border-t p-2 shrink-0">
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
