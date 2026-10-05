"use client";

import { Loader2 } from "lucide-react";
import { useCan } from "@/hooks/use-can";
import type { PermissionKey } from "@/lib/permissions/catalogue";
import { NoAccess } from "./no-access";

/**
 * Mounts `children` only when the person holds `permission` (on the event,
 * when one is given). Refused, they see the shared panel and the page never
 * mounts, so its requests never fire. The route stays the authority.
 */
export function PermissionGate({
  permission,
  eventId,
  what,
  back,
  children,
}: {
  permission: PermissionKey;
  eventId?: string;
  what?: string;
  back?: { href: string; label: string };
  children: React.ReactNode;
}) {
  const status = useCan(permission, eventId);
  if (status === "loading") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    );
  }
  if (status === "denied") return <NoAccess what={what} back={back} />;
  return <>{children}</>;
}
