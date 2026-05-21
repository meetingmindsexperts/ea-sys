import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { SidebarProvider } from "@/contexts/sidebar-context";
import { HelpChatProvider } from "@/components/help-chat/help-chat-provider";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  return (
    <SidebarProvider>
      {/* HelpChatProvider mounts the drawer once at the dashboard root
          and exposes useHelpChatLauncher() so the sidebar Help button
          can open it without prop-drilling. */}
      <HelpChatProvider>
        <div className="flex h-screen">
          <Sidebar />
          <div className="flex flex-1 flex-col overflow-hidden">
            <Header />
            <main className="flex-1 overflow-auto bg-muted/30 p-6">{children}</main>
          </div>
        </div>
      </HelpChatProvider>
    </SidebarProvider>
  );
}
