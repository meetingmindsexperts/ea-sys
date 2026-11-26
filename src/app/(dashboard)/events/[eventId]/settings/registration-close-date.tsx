"use client";

/**
 * Settings, Registration: "Close registration on" (owner, Nov 26, 2026). After this time the public
 * forms are closed exactly as if "Registration Open" were off (registration-closure.ts). Edited as a
 * wall-clock time in the event's timezone and stored as an instant, like the abstract deadline.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { tzLabel, wallTimeInTzToIso } from "@/lib/event-time";

export function RegistrationCloseDate({
  value,
  onChange,
  timezone,
  webinar,
}: {
  value: string;
  onChange: (value: string) => void;
  timezone: string;
  webinar: boolean;
}) {
  // When the page opened: enough to say whether the chosen time is already past.
  const [openedAt] = useState(() => Date.now());
  const iso = wallTimeInTzToIso(value, timezone);
  const passed = iso !== null && new Date(iso).getTime() <= openedAt;
  return (
    <div className="space-y-2">
      <Label htmlFor="registrationClosesAt">Close registration on</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="registrationClosesAt"
          type="datetime-local"
          className="w-auto"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {value ? (
          <Button type="button" variant="outline" size="sm" onClick={() => onChange("")}>
            Clear
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        Event time ({tzLabel(new Date(), timezone)}). From this time the registration forms are closed, as if
        Registration Open were off. Leave it empty to keep registration open until you switch it off.
        {webinar ? " A webinar's registration also closes on its own once the webinar is over." : ""}
      </p>
      {passed ? (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          This time has passed, so registration is closed. Clear it or choose a later time to reopen.
        </p>
      ) : null}
    </div>
  );
}
