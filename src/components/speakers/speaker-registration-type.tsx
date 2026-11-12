"use client";

import { Briefcase, ExternalLink } from "lucide-react";
import { Label } from "@/components/ui/label";
import { RegistrationTypeSelect } from "@/components/ui/registration-type-select";
import { speakerRegistrationTypeView, type SpeakerLinkedRegistration } from "@/lib/speaker-registration-type";

/**
 * "Registration Type" on the two speaker screens. A speaker who has a live
 * registration shows that registration's type, read-only: the type is changed
 * on the registration, never here. See src/lib/speaker-registration-type.ts
 * for why the dropdown that used to be here misled.
 */

interface Props {
  eventId: string;
  /** The speaker's own text (`Speaker.registrationType`). */
  ownType: string | null | undefined;
  registration: SpeakerLinkedRegistration | null | undefined;
}

function RegistrationLink({ eventId, serial }: { eventId: string; serial: string | null }) {
  return (
    <a href={`/events/${eventId}/registrations`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
      <ExternalLink className="h-3 w-3" />
      {serial ? `Find registration #${serial} in Registrations` : "View in Registrations"}
    </a>
  );
}

/** The row in a speaker's details. Renders nothing when there is nothing to say. */
export function SpeakerRegistrationTypeRow({ eventId, ownType, registration }: Props) {
  const view = speakerRegistrationTypeView(ownType, registration);
  if (!view.typeName) return null;
  return (
    <div className="flex items-start gap-3">
      <Briefcase className="mt-0.5 h-4 w-4 text-muted-foreground shrink-0" />
      <div>
        <div className="text-xs text-muted-foreground">Registration Type</div>
        <div className="text-sm">
          {view.typeName}
          {view.kind === "registration" && view.facultyTypeName && (
            <span className="text-muted-foreground"> · on the {view.facultyTypeName} type</span>
          )}
        </div>
        {view.kind === "registration" && (
          <div className="mt-0.5 space-y-0.5">
            {view.note && <p className="text-xs text-amber-700">{view.note}</p>}
            <RegistrationLink eventId={eventId} serial={view.serial} />
          </div>
        )}
      </div>
    </div>
  );
}

/** The field in a speaker's edit form: read-only when a registration decides the type. */
export function SpeakerRegistrationTypeField({
  eventId,
  ownType,
  registration,
  onChange,
}: Props & { onChange: (registrationType: string) => void }) {
  const view = speakerRegistrationTypeView(ownType, registration);
  if (view.kind === "own") {
    return (
      <div className="space-y-2">
        <Label>Registration Type</Label>
        <RegistrationTypeSelect value={ownType} onChange={onChange} eventId={eventId} />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <Label>Registration Type</Label>
      <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
        {view.typeName}
        {view.facultyTypeName && <span className="text-muted-foreground"> · on the {view.facultyTypeName} type</span>}
        {view.serial && <span className="text-muted-foreground"> · registration #{view.serial}</span>}
      </div>
      <p className="text-xs text-muted-foreground">
        This is the type on the person&apos;s registration. It is changed on the registration, not here.
      </p>
      {view.note && <p className="text-xs text-amber-700">{view.note}</p>}
      <RegistrationLink eventId={eventId} serial={view.serial} />
    </div>
  );
}
