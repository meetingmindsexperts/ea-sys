"use client";

import Image from "next/image";
import { Users } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatPersonName } from "@/lib/utils";
import { formatSessionRole } from "@/lib/session-enums";

export interface Panelist {
  id: string;
  title?: string | null;
  firstName: string;
  lastName: string;
  jobTitle?: string | null;
  organization?: string | null;
  photo?: string | null;
  role?: string;
}

/**
 * Everyone on the webinar's panel: the session's own speakers first (with
 * their role), then anyone presenting a topic who is not already listed.
 * One row per person, keyed by speaker id.
 */
export function collectPanelists(session: {
  speakers: Panelist[];
  topics: Array<{ speakers: Panelist[] }>;
}): Panelist[] {
  const seen = new Set<string>();
  const out: Panelist[] = [];
  for (const sp of [...session.speakers, ...session.topics.flatMap((t) => t.speakers)]) {
    if (seen.has(sp.id)) continue;
    seen.add(sp.id);
    out.push(sp);
  }
  return out;
}

/** Compact panel list beside the webinar video: capped height, scrolls inside. */
export function PanelistsCard({ panelists }: { panelists: Panelist[] }) {
  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-primary" />
          <p className="font-medium">Panelists</p>
          <span className="text-xs text-muted-foreground">({panelists.length})</span>
        </div>
        <ul className="max-h-[440px] space-y-3 overflow-y-auto pr-1">
          {panelists.map((p) => {
            const name = formatPersonName(p.title, p.firstName, p.lastName);
            const subtitle = [p.jobTitle, p.organization].filter(Boolean).join(" · ");
            return (
              <li key={p.id} className="flex items-center gap-3">
                {p.photo ? (
                  <Image
                    src={p.photo}
                    alt={name}
                    width={40}
                    height={40}
                    className="h-10 w-10 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-400 to-blue-600 text-sm font-medium text-white">
                    {p.firstName[0]}
                    {p.lastName[0]}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={name}>{name}</p>
                  {p.role && p.role !== "SPEAKER" && (
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-primary">
                      {formatSessionRole(p.role)}
                    </p>
                  )}
                  {subtitle && (
                    <p className="line-clamp-2 text-xs text-muted-foreground">{subtitle}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
