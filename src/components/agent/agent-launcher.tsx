"use client";

// The floating AI Agent button (owner request, Sep 21, 2026): a round
// brand-coloured button at the bottom right of every dashboard page that
// opens the AI Agent page, with the current event carried along. Where it
// shows and where it goes is one pure rule in src/lib/agent/launcher.ts;
// this component only renders it.
//
// Mounted once in the dashboard layout. It is a link, not a drawer, so a
// click is an ordinary navigation the browser's back button undoes.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { Bot } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { agentLauncherHref } from "@/lib/agent/launcher";

export function AgentLauncher() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const href = agentLauncherHref(pathname, session?.user?.role);
  if (!href) return null;

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            href={href}
            aria-label="Open the AI Agent"
            data-testid="agent-launcher"
            className="fixed bottom-4 right-4 z-40 flex size-12 items-center justify-center rounded-full bg-gradient-primary text-primary-foreground shadow-lg shadow-primary/30 outline-none transition-transform focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-safe:hover:scale-105 print:hidden sm:bottom-6 sm:right-6 sm:size-14"
          >
            <Bot className="size-6" aria-hidden="true" />
          </Link>
        </TooltipTrigger>
        <TooltipContent side="left">AI Agent</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
