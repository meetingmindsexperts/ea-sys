"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Calendar,
  Home,
  Settings,
  Users,
  Ticket,
  Mic,
  Building2,
  LayoutDashboard,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navigation = [
  { name: "Dashboard", href: "/dashboard", icon: Home },
  { name: "Events", href: "/events", icon: Calendar },
  { name: "Settings", href: "/settings", icon: Settings },
];

const eventNavigation = [
  { name: "Overview", href: "", icon: LayoutDashboard },
  { name: "Registrations", href: "/registrations", icon: Ticket },
  { name: "Speakers", href: "/speakers", icon: Mic },
  { name: "Attendees", href: "/attendees", icon: Users },
  { name: "Accommodation", href: "/accommodation", icon: Building2 },
  { name: "Settings", href: "/settings", icon: Settings },
];

interface SidebarProps {
  eventId?: string;
}

export function Sidebar({ eventId }: SidebarProps) {
  const pathname = usePathname();

  const navItems = eventId
    ? eventNavigation.map((item) => ({
        ...item,
        href: `/events/${eventId}${item.href}`,
      }))
    : navigation;

  return (
    <aside className="flex h-full w-64 flex-col border-r bg-background">
      <div className="flex h-16 items-center border-b px-6">
        <Link href="/dashboard" className="flex items-center gap-2">
          <Calendar className="h-6 w-6 text-primary" />
          <span className="text-xl font-bold">EventsHub</span>
        </Link>
      </div>
      <nav className="flex-1 space-y-1 px-3 py-4">
        {navItems.map((item) => {
          const isActive = eventId
            ? pathname === item.href
            : pathname.startsWith(item.href);
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <item.icon className="h-5 w-5" />
              {item.name}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
