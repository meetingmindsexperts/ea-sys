"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
  { name: "Events", href: "/events", icon: Calendar },
  { name: "Settings", href: "/settings", icon: Settings },
];

const eventNavigation = [
  { name: "Overview", href: "", icon: LayoutDashboard },
  { name: "Registrations", href: "/registrations", icon: Ticket },
  { name: "Tickets", href: "/tickets", icon: Ticket },
  { name: "Speakers", href: "/speakers", icon: Mic },
  { name: "Schedule", href: "/schedule", icon: Clock },
  { name: "Accommodation", href: "/accommodation", icon: Building2 },
  { name: "Abstracts", href: "/abstracts", icon: FileText },
  { name: "Settings", href: "/settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const { isCollapsed, toggleSidebar } = useSidebar();

  // Check if we're on an event page
  const eventMatch = pathname.match(/^\/events\/([^/]+)/);
  const eventId = eventMatch ? eventMatch[1] : null;
  const isEventPage = eventId && eventId !== "new";

  const navItems = isEventPage
    ? eventNavigation.map((item) => ({
        ...item,
        href: `/events/${eventId}${item.href}`,
      }))
    : navigation;

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          "flex h-full flex-col border-r bg-background transition-all duration-300",
          isCollapsed ? "w-16" : "w-64"
        )}
      >
        {/* Logo */}
        <div className="flex h-16 items-center border-b px-3 bg-gradient-primary">
          <Link
            href="/dashboard"
            className={cn(
              "flex items-center gap-2",
              isCollapsed && "justify-center w-full"
            )}
          >
            <Calendar className="h-6 w-6 text-white flex-shrink-0" />
            {!isCollapsed && (
              <span className="text-xl font-bold text-white">MMGroup EventsHub</span>
            )}
          </Link>
        </div>
        {/* Collapse Toggle */}
        <div className="border-t p-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleSidebar}
            className={cn(
              "w-full justify-center",
              !isCollapsed && "justify-start"
            )}
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
        {/* Event indicator when on event page */}
        {isEventPage && !isCollapsed && (
          <div className="border-b px-3 py-2">
            <Link
              href="/events"
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
            >
              <ChevronLeft className="h-3 w-3" />
              Back to Events
            </Link>
          </div>
        )}

        {/* Navigation */}
        <nav className="flex-1 space-y-1 px-2 py-4">
          {navItems.map((item) => {
            const isActive = isEventPage
              ? item.href === `/events/${eventId}`
                ? pathname === `/events/${eventId}`
                : pathname.startsWith(item.href)
              : pathname.startsWith(item.href);

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
                <item.icon className="h-5 w-5 flex-shrink-0" />
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
          })}
        </nav>

        
      </aside>
    </TooltipProvider>
  );
}
