"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  Calendar,
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

const navigation = [
  { name: "Dashboard", href: "/dashboard", icon: Home },
  { name: "Events",    href: "/events",    icon: Calendar },
  { name: "Contacts",  href: "/contacts",  icon: BookUser },
  { name: "Settings",  href: "/settings",  icon: Settings },
];

// Event nav split into sections for visual grouping
const eventNavigationSections = [
  {
    label: "Overview",
    items: [
      { name: "Overview", href: "", icon: LayoutDashboard },
    ],
  },
  {
    label: "Manage",
    items: [
      { name: "Registrations", href: "/registrations", icon: Users },
      { name: "Reg. Types",    href: "/tickets",       icon: Ticket },
      { name: "Speakers",      href: "/speakers",      icon: Mic },
      { name: "Schedule",      href: "/schedule",      icon: Clock },
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
    label: "Config",
    items: [
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
  const isReviewer  = session?.user?.role === "REVIEWER";
  const isSubmitter = session?.user?.role === "SUBMITTER";
  const isRestricted = isReviewer || isSubmitter;

  const eventMatch = pathname.match(/^\/events\/([^/]+)/);
  const eventId    = eventMatch ? eventMatch[1] : null;
  const isEventPage = eventId && eventId !== "new";

  const restrictedNavigation = navigation.filter((item) => ["Events"].includes(item.name));
  const restrictedEventItems = eventNavigation.filter((item) => ["Abstracts"].includes(item.name));

  const baseNavigation = isRestricted ? restrictedNavigation : navigation;

  // Build sections for event nav
  const visibleEventSections = isRestricted
    ? [{ label: "Abstracts", items: restrictedEventItems }]
    : eventNavigationSections;

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
        <div className="flex h-16 items-center border-b px-3 bg-gradient-primary shrink-0">
          <Link
            href="/dashboard"
            className={cn("flex items-center gap-2.5", isCollapsed && "justify-center w-full")}
          >
            <div className="w-7 h-7 rounded-lg bg-white/20 flex items-center justify-center shrink-0">
              <Calendar className="h-4 w-4 text-white" />
            </div>
            {!isCollapsed && (
              <span className="text-base font-bold text-white leading-tight">
                MMGroup EventsHub
              </span>
            )}
          </Link>
        </div>

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
                <div key={section.label} className={cn(si > 0 && "pt-3")}>
                  <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                    {section.label}
                  </p>
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
