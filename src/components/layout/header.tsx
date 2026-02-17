"use client";

import { signOut } from "next-auth/react";
import { useSession } from "next-auth/react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Bell,
  LogOut,
  User,
  ChevronDown,
  Calendar,
  LayoutDashboard,
  ChevronRight,
  Shield,
  ShieldCheck,
  Eye,
  FileText,
  Check,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatDate } from "@/lib/utils";
import { useEvents, useEvent } from "@/hooks/use-api";

// ── Role metadata ─────────────────────────────────────────────────────────────

type RoleMeta = {
  label: string;
  description: string;
  color: string; // bg + text classes
  icon: React.ElementType;
  permissions: { label: string; allowed: boolean }[];
};

const ROLE_META: Record<string, RoleMeta> = {
  SUPER_ADMIN: {
    label: "Super Admin",
    description: "Full platform access",
    color: "bg-violet-100 text-violet-700",
    icon: ShieldCheck,
    permissions: [
      { label: "Manage events & team",     allowed: true },
      { label: "Review & approve abstracts", allowed: true },
      { label: "Delete abstracts",          allowed: true },
      { label: "Organisation settings",    allowed: true },
    ],
  },
  ADMIN: {
    label: "Admin",
    description: "Event management & reviews",
    color: "bg-blue-100 text-blue-700",
    icon: Shield,
    permissions: [
      { label: "Manage events & team",     allowed: true },
      { label: "Review & approve abstracts", allowed: true },
      { label: "Delete abstracts",          allowed: false },
      { label: "Organisation settings",    allowed: true },
    ],
  },
  ORGANIZER: {
    label: "Organizer",
    description: "Event operations",
    color: "bg-emerald-100 text-emerald-700",
    icon: Calendar,
    permissions: [
      { label: "Manage events",            allowed: true },
      { label: "Review & approve abstracts", allowed: false },
      { label: "Delete abstracts",          allowed: false },
      { label: "Organisation settings",    allowed: false },
    ],
  },
  REVIEWER: {
    label: "Reviewer",
    description: "Abstract review only",
    color: "bg-amber-100 text-amber-700",
    icon: Eye,
    permissions: [
      { label: "View assigned events",     allowed: true },
      { label: "Read abstracts",           allowed: true },
      { label: "Review & approve abstracts", allowed: false },
      { label: "Delete abstracts",          allowed: false },
    ],
  },
  SUBMITTER: {
    label: "Submitter",
    description: "Abstract submissions",
    color: "bg-gray-100 text-gray-700",
    icon: FileText,
    permissions: [
      { label: "Submit abstracts",         allowed: true },
      { label: "Edit own abstracts",       allowed: true },
      { label: "Review & approve abstracts", allowed: false },
      { label: "Delete abstracts",          allowed: false },
    ],
  },
};

// ── Component ─────────────────────────────────────────────────────────────────

export function Header() {
  const { data: session } = useSession();
  const pathname = usePathname();
  const router = useRouter();

  const eventMatch = pathname.match(/^\/events\/([^/]+)/);
  const eventId = eventMatch ? eventMatch[1] : null;
  const isEventPage = eventId && eventId !== "new";

  const subPageMatch = pathname.match(/^\/events\/[^/]+\/(.+)/);
  const currentSubPage = subPageMatch ? subPageMatch[1] : null;

  const { data: events = [] } = useEvents();
  const { data: currentEvent } = useEvent(isEventPage ? eventId! : "");

  const handleEventChange = (newEventId: string) => {
    if (currentSubPage) {
      router.push(`/events/${newEventId}/${currentSubPage}`);
    } else {
      router.push(`/events/${newEventId}`);
    }
  };

  const initials = session?.user
    ? `${session.user.firstName?.[0] || ""}${session.user.lastName?.[0] || ""}`
    : "U";

  const role = session?.user?.role ?? "ORGANIZER";
  const roleMeta = ROLE_META[role] ?? ROLE_META.ORGANIZER;
  const RoleIcon = roleMeta.icon;

  return (
    <header className="flex h-16 items-center justify-between border-b bg-background px-6 relative">
      <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-primary-horizontal opacity-50" />

      {/* ── Left: Event selector / breadcrumb ─────────────────────────────── */}
      <div className="flex items-center gap-4">
        {isEventPage && currentEvent ? (
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="flex items-center gap-2 h-auto py-1">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <span className="font-semibold">{currentEvent.name}</span>
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel>Switch Event</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {events.map((event) => (
                  <DropdownMenuItem
                    key={event.id}
                    onClick={() => handleEventChange(event.id)}
                    className={event.id === eventId ? "bg-muted" : ""}
                  >
                    <Calendar className="mr-2 h-4 w-4" />
                    <div className="flex flex-col">
                      <span className="font-medium">{event.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatDate(event.startDate)}
                      </span>
                    </div>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/events">View All Events</Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {currentSubPage && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <ChevronRight className="h-4 w-4" />
                <Link
                  href={`/events/${eventId}`}
                  className="hover:text-foreground flex items-center gap-1"
                >
                  <LayoutDashboard className="h-4 w-4" />
                  Overview
                </Link>
                <ChevronRight className="h-4 w-4" />
                <span className="text-foreground capitalize">
                  {currentSubPage.split("/")[0].replace(/-/g, " ")}
                </span>
              </div>
            )}
          </div>
        ) : (
          <h1 className="text-lg font-semibold">
            {session?.user?.organizationName ||
              (role === "REVIEWER"
                ? "Reviewer Portal"
                : role === "SUBMITTER"
                  ? "Submitter Portal"
                  : "Dashboard")}
          </h1>
        )}
      </div>

      {/* ── Right: Notifications + Profile ────────────────────────────────── */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-5 w-5" />
          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-accent-yellow" />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="flex items-center gap-2">
              <Avatar className="h-8 w-8">
                <AvatarImage src={session?.user?.image || undefined} />
                <AvatarFallback className="bg-primary text-primary-foreground text-sm font-semibold">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <span className="hidden md:block">
                {session?.user?.firstName} {session?.user?.lastName}
              </span>
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" className="w-72">
            {/* ── User info ───────────────────────────────────────────────── */}
            <div className="px-3 py-3 space-y-2">
              <div className="flex items-center gap-3">
                <Avatar className="h-10 w-10">
                  <AvatarImage src={session?.user?.image || undefined} />
                  <AvatarFallback className="bg-primary text-primary-foreground font-semibold">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="font-semibold text-sm leading-tight">
                    {session?.user?.firstName} {session?.user?.lastName}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {session?.user?.email}
                  </p>
                </div>
              </div>

              {/* Role badge */}
              <div className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full ${roleMeta.color}`}>
                <RoleIcon className="h-3 w-3" />
                {roleMeta.label}
              </div>
            </div>

            <DropdownMenuSeparator />

            {/* ── Permissions ─────────────────────────────────────────────── */}
            <div className="px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-2">
                Permissions
              </p>
              <div className="space-y-1.5">
                {roleMeta.permissions.map((p) => (
                  <div key={p.label} className="flex items-center gap-2">
                    {p.allowed ? (
                      <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                    ) : (
                      <X className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
                    )}
                    <span className={`text-xs ${p.allowed ? "text-foreground" : "text-muted-foreground/60"}`}>
                      {p.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <DropdownMenuSeparator />

            {/* ── Actions ─────────────────────────────────────────────────── */}
            <DropdownMenuItem asChild>
              <Link href="/profile" className="flex items-center">
                <User className="mr-2 h-4 w-4" />
                Profile
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-red-600 focus:text-red-600"
              onClick={() => signOut({ callbackUrl: "/login" })}
            >
              <LogOut className="mr-2 h-4 w-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
