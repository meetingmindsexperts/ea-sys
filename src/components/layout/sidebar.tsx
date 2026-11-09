"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import { useOrgBranding, useOrganizations, useEvent, useMyPortalSummary, useSubmitterContext } from "@/hooks/use-api";

import { useActiveOrg } from "@/contexts/active-org-context";

import {
  Building2,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  HelpCircle,
  Menu,
} from "lucide-react";
import { cn } from "@/lib/utils";

import { useRuntimeFlags } from "@/components/runtime-flags";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/contexts/sidebar-context";
import { useHelpChatLauncher } from "@/components/help-chat/help-chat-provider";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
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

import { activeNavHref, computeSidebarNav, sidebarSkipsEventFetch } from "./sidebar-nav";

/**
 * The navigation column. Two placements of the one component, so a phone and a
 * desktop can never list different pages: the fixed column from `md` up, and
 * (`mobile`) the body of the slide-out menu below it, where it is never
 * collapsed and `onNavigate` closes the menu once a link is followed.
 */
export function Sidebar({ mobile = false, onNavigate }: { mobile?: boolean; onNavigate?: () => void } = {}) {
  const pathname = usePathname();
  const { isCollapsed: collapsedSetting, toggleSidebar } = useSidebar();
  // The collapse setting belongs to the desktop column: a phone menu that
  // opened as a strip of bare icons would be the worst of both.
  const isCollapsed = !mobile && collapsedSetting;
  const helpChat = useHelpChatLauncher();
  const { data: session } = useSession();
  const { data: branding } = useOrgBranding();
  const qc = useQueryClient();
  const { activeOrgId, setActiveOrgId, isOrgOverride } = useActiveOrg();
  const orgLogo = branding?.logo ?? null;
  const orgName = branding?.name ?? session?.user?.organizationName ?? null;
  const isSuperAdmin  = session?.user?.role === "SUPER_ADMIN";
  // Read at request time on the server and handed down, because a NEXT_PUBLIC_
  // constant is baked at build and master and the platform share one image.
  const { hrEnabled, procurementEnabled, blueprintEnabled, crmEnabled } = useRuntimeFlags();
  const role = session?.user?.role;
  const isSubmitter = role === "SUBMITTER";

  // Fetch all orgs for SUPER_ADMIN switcher
  const { data: allOrgs } = useOrganizations(isSuperAdmin);

  const eventMatch = pathname.match(/^\/events\/([^/]+)/);
  const eventId    = eventMatch ? eventMatch[1] : null;
  const isEventPage = Boolean(eventId && eventId !== "new");

  // Fetch event to know eventType (cached by React Query across navigation).
  // Skip fetch on non-event pages and for restricted roles whose sidebar doesn't branch.
  const { data: currentEvent } = useEvent(isEventPage && !sidebarSkipsEventFetch(role, session?.user?.extraAreas) ? (eventId as string) : "");
  // Submitter surface separation — which of Abstracts / Session Proposals this
  // submitter's signup flow covers (null while loading → show neither).
  const { data: submitterCtx } = useSubmitterContext(
    isSubmitter && isEventPage ? (eventId as string) : "",
  );

  const { data: portalSummary } = useMyPortalSummary(!!role);

  const handleOrgSwitch = (orgId: string | null) => {
    setActiveOrgId(orgId);
    // Invalidate all cached queries so they refetch with the new org header
    setTimeout(() => qc.invalidateQueries(), 50);
  };

  // What the sidebar shows: one pure function (sidebar-nav.ts), snapshotted
  // for every role and context.
  const { baseNavigation, visibleEventSections } = computeSidebarNav({
    user: session?.user as Parameters<typeof computeSidebarNav>[0]["user"],
    hrEnabled,
    procurementEnabled,
    crmEnabled,
    blueprintEnabled,
    isEventPage,
    currentEvent,
    submitterCtx,
    hasReviewWork: portalSummary?.hasReviewWork,
    hasAbstracts: portalSummary?.hasAbstracts,
  });
  const activeHref = activeNavHref(pathname, baseNavigation);

  const flatEventItems = visibleEventSections.flatMap((s) =>
    s.items.map((item) => ({ ...item, href: `/events/${eventId}${item.href}` }))
  );

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          "h-full flex-col bg-background",
          mobile ? "flex w-full" : "hidden border-r transition-all duration-300 md:flex",
          !mobile && (isCollapsed ? "w-16" : "w-56")
        )}
      >
        {/* ── Logo ─────────────────────────────────────────────────────────── */}
        <div className="flex h-16 items-center border-b px-4 bg-white shrink-0">
          <Link
            href="/dashboard"
            onClick={onNavigate}
            className={cn("flex items-center gap-3 min-w-0", isCollapsed && "justify-center w-full")}
          >
            {orgLogo ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={orgLogo}
                alt={orgName || "Organization"}
                className={cn("object-contain shrink-0", isCollapsed ? "h-8 w-8" : "h-9 max-w-[60px]")}
              />
            ) : null}
            {!orgLogo && isCollapsed && (
              <span className="text-sm font-bold text-primary">
                {(orgName || "E")[0]}
              </span>
            )}
            {!isCollapsed && (
              <span className={cn(
                "text-[11px] font-semibold text-primary/80 tracking-wide uppercase shrink-0 leading-tight line-clamp-2",
                orgLogo && "border-l border-border pl-3"
              )}>
                {orgName || "MM Group Events"}
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
              onClick={onNavigate}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
            >
              <ChevronLeft className="h-3 w-3" />
              Back to Events
            </Link>
          </div>
        )}

        {/* ── Navigation ───────────────────────────────────────────────────── */}
        <nav
          className="flex-1 overflow-y-auto px-2 py-3 space-y-0.5"
          // Following any link closes the phone menu.
          onClickCapture={(e) => {
            if ((e.target as HTMLElement).closest("a")) onNavigate?.();
          }}
        >
          {/* Event-scoped sections */}
          {isEventPage && isCollapsed && (
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
          )}
          {isEventPage && !isCollapsed && (
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
          )}
          {!isEventPage && (
            /* Top-level nav */
            baseNavigation.map((item) => {
            // An external item is a static file, not an app route: it must
            // not be prefetched or client-navigated, and it never matches
            // the active-highlight (pathname never equals it).
            const isActive = item.href === activeHref;
            const navLink = (
              <Link
                key={item.name}
                href={item.href}
                {...(item.external ? { target: "_blank", rel: "noopener noreferrer", prefetch: false } : {})}
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
              onClick={() => {
                onNavigate?.();
                helpChat.open();
              }}
              className="w-full justify-start text-muted-foreground hover:text-foreground"
            >
              <HelpCircle className="h-4 w-4 mr-2" />
              Help
            </Button>
          )}

          {!mobile && (
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
          )}
        </div>
      </aside>
    </TooltipProvider>
  );
}

/**
 * The phone menu (below `md`): a button in the header opening the sidebar from
 * the left. Before this the fixed 224px column stayed on a 390px phone and
 * squeezed every page into what was left (Nov 9, 2026).
 */
export function MobileSidebar() {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="-ml-2 shrink-0 md:hidden" aria-label="Open menu">
          <Menu className="h-5 w-5" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" aria-describedby={undefined} className="w-72 max-w-[85vw] gap-0 p-0 sm:max-w-[85vw]">
        <SheetTitle className="sr-only">Menu</SheetTitle>
        <Sidebar mobile onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
