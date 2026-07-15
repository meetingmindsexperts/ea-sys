"use client";

/**
 * CRM shell — one section, three tabs.
 *
 * The sidebar carries a single "CRM" entry; Deals / Companies / Tasks are tabs in
 * the right pane rather than three top-level sidebar links. The module is one place
 * to look, not three — which is the whole point of the bounded-namespace design
 * (§7.0), and matters more than usual here because the owner's stated constraint is
 * mental-context load.
 *
 * The tabs are LINKS, not local state: each tab is a real route, so a deep link to
 * /crm/companies still works, the back button behaves, and a bookmarked board
 * survives. Tab state that lives only in React would break all three.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Building2, CheckSquare, FileText, Handshake, Package, Users } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/crm/deals", label: "Deals", icon: Handshake },
  { href: "/crm/companies", label: "Companies", icon: Building2 },
  // Business contacts — reps, exhibitor sales, procurement. NOT the event HCP store.
  { href: "/crm/contacts", label: "Contacts", icon: Users },
  { href: "/crm/tasks", label: "Tasks", icon: CheckSquare },
  { href: "/crm/reports", label: "Reports", icon: BarChart3 },
  { href: "/crm/products", label: "Products", icon: Package },
  { href: "/crm/templates", label: "Templates", icon: FileText },
];

export default function CrmLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex flex-col">
      <div className="border-b px-6 pt-6">
        <h1 className="text-2xl font-bold">CRM</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Sponsorship pipeline, accounts and follow-ups
        </p>

        <nav className="-mb-px mt-4 flex gap-1" aria-label="CRM sections">
          {TABS.map((tab) => {
            const active = pathname.startsWith(tab.href);
            const Icon = tab.icon;
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
                  active
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="flex-1">{children}</div>
    </div>
  );
}
