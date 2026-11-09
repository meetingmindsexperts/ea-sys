import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { SidebarProvider } from "@/contexts/sidebar-context";
import { HelpChatProvider } from "@/components/help-chat/help-chat-provider";
import { AgentLauncher } from "@/components/agent/agent-launcher";
import { RuntimeFlagsProvider } from "@/components/runtime-flags";
import { isHrModuleEnabled, isProcurementModuleEnabled, isCustomRolesEnabled, isBlueprintModuleEnabled } from "@/lib/module-flags";
import { senderDomain } from "@/lib/sender-domain";
import { orgHasModule } from "@/lib/module-entitlements";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }
  const crmEnabled = session.user.organizationId ? await orgHasModule(session.user.organizationId, "crm") : false;

  // Per-deployment flags are read HERE, on the server, at request time. They
  // cannot be NEXT_PUBLIC_ constants: master and the platform are built from one
  // image and differ only in their environment, so a build-time value would be
  // identical on both. See src/components/runtime-flags.tsx.
  return (
    <RuntimeFlagsProvider
      flags={{ hrEnabled: isHrModuleEnabled(), procurementEnabled: isProcurementModuleEnabled(), blueprintEnabled: isBlueprintModuleEnabled(), customRolesEnabled: isCustomRolesEnabled(), senderDomain: senderDomain(), crmEnabled }}
    >
      <SidebarProvider>
      {/* HelpChatProvider mounts the drawer once at the dashboard root
          and exposes useHelpChatLauncher() so the sidebar Help button
          can open it without prop-drilling. */}
      <HelpChatProvider>
        <div className="flex h-screen">
          <Sidebar />
          <div className="flex flex-1 flex-col overflow-hidden">
            <Header />
            {/* `relative` keeps absolute children inside this scroll area. Radix renders a
                hidden absolute input beside every checkbox and switch; without a positioned
                ancestor one below the fold stretched the document, so the whole shell
                scrolled up and left a blank strip under it (Nov 9, 2026). */}
            <main className="relative flex-1 overflow-auto bg-muted/30 p-4 md:p-6">{children}</main>
          </div>
        </div>
        {/* The floating AI Agent button: fixed bottom right, role-gated and
            absent on the agent, check-in and log pages (src/lib/agent/launcher.ts). */}
        <AgentLauncher />
      </HelpChatProvider>
      </SidebarProvider>
    </RuntimeFlagsProvider>
  );
}
