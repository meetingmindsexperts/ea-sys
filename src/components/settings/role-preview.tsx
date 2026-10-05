"use client";

/**
 * "View as role" (custom roles plan §6 Phase 5): before a role is handed out,
 * what holding it ADDS for a person of a given base role, in the menu and in
 * the event pages they can open. Computed with the same functions as the
 * real sidebar (`computeSidebarNav`), the middleware (`confinementRedirect`)
 * and the page gate (`EVENT_PAGE_KEYS` and `can()`), so the preview cannot disagree with what the person will see.
 * An "assigned events" grant is shown as if the person were assigned.
 */

import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { computeSidebarNav } from "@/components/layout/sidebar-nav";
import { roleLabelOf } from "@/components/layout/header";
import { useRuntimeFlags } from "@/components/runtime-flags";
import { can, principalFromUser } from "@/lib/permissions/can";
import { encodeSessionGrant } from "@/lib/permissions/catalogue";
import { EVENT_PAGE_KEYS } from "@/lib/permissions/event-page-keys";
import { confinementRedirect } from "@/lib/route-confinement";
import type { DraftGrant } from "@/lib/permissions/role-warnings";
import { TEAM_ROLES } from "@/lib/team-roles";

/** The base roles a custom role can sit on: the team roles below the top administrator. */
const PREVIEW_BASE_ROLES = TEAM_ROLES.filter((r) => r !== "SUPER_ADMIN");

const PREVIEW_USER = "preview-user";
const EVENTS = {
  conference: { organizationId: "preview-org", eventType: "CONFERENCE", staffUserIds: [PREVIEW_USER] },
  webinar: { organizationId: "preview-org", eventType: "WEBINAR", staffUserIds: [PREVIEW_USER] },
};

/** A readable page name from its path segment: `session-proposals` → `Session proposals`. */
const pageName = (segment: string) => segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, " ");

export function RolePreview({ grants }: { grants: readonly DraftGrant[] }) {
  const [base, setBase] = useState<string>("MEMBER");
  const { hrEnabled, procurementEnabled } = useRuntimeFlags();

  const userWith = (withRole: boolean) => ({
    id: PREVIEW_USER,
    role: base,
    organizationId: "preview-org",
    procurementPermissions: withRole ? grants.map((g) => encodeSessionGrant(g.permission, g.scope)) : [],
  });
  const menu = (withRole: boolean) =>
    computeSidebarNav({ user: userWith(withRole), hrEnabled, procurementEnabled, isEventPage: false, currentEvent: undefined, submitterCtx: undefined })
      .baseNavigation.map((i) => i.name);
  const pages = (withRole: boolean, event: (typeof EVENTS)[keyof typeof EVENTS]) => {
    const p = principalFromUser(userWith(withRole));
    // Openable: the middleware lets the base role reach the path AND the page's key is held.
    return Object.entries(EVENT_PAGE_KEYS)
      .filter(([segment, key]) => confinementRedirect(base, `/events/preview/${segment}`) === null && can(p, key, { event }))
      .map(([segment]) => segment);
  };
  const added = (before: string[], after: string[]) => after.filter((x) => !before.includes(x));

  const menuAdded = added(menu(false), menu(true));
  const conferenceAdded = added(pages(false, EVENTS.conference), pages(true, EVENTS.conference));
  const webinarAdded = added(pages(false, EVENTS.webinar), pages(true, EVENTS.webinar));
  const nothing = menuAdded.length + conferenceAdded.length + webinarAdded.length === 0;

  return (
    <div className="rounded-lg border p-3 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm font-medium">Preview: what this role adds</p>
        <div className="flex items-center gap-2">
          <Label htmlFor="preview-base" className="text-xs text-muted-foreground">
            For someone whose base role is
          </Label>
          <Select value={base} onValueChange={setBase}>
            <SelectTrigger id="preview-base" className="h-8 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PREVIEW_BASE_ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {roleLabelOf(r) ?? r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {nothing ? (
        <p className="text-xs text-muted-foreground">
          Nothing new to open for this base role. The role may still add actions on pages they already open, or it
          may grant permissions outside the parts of the app this base role works in.
        </p>
      ) : (
        <dl className="grid gap-2 text-sm sm:grid-cols-3">
          <PreviewList title="New in the menu" items={menuAdded} />
          <PreviewList title="New pages on a conference" items={conferenceAdded.map(pageName)} />
          <PreviewList title="New pages on a webinar" items={webinarAdded.map(pageName)} />
        </dl>
      )}
      <p className="text-xs text-muted-foreground">
        Pages are shown as if the person were assigned to the event. Actions inside a page follow the same permissions.
      </p>
    </div>
  );
}

function PreviewList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{title}</dt>
      <dd className="mt-1">{items.length > 0 ? items.join(", ") : <span className="text-muted-foreground">None</span>}</dd>
    </div>
  );
}
