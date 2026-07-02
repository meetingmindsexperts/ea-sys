"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  User,
  Mail,
  Building2,
  Briefcase,
  Phone,
  MapPin,
  Stethoscope,
  BadgeCheck,
  FileText,
  Plus,
  AlertCircle,
} from "lucide-react";
import { formatPersonName } from "@/lib/utils";
import { formatAttendeeRole } from "@/lib/schemas";
import { useEvent } from "@/hooks/use-api";
import { AbstractGuidelines } from "@/components/abstracts/abstract-guidelines";
import { abstractStatusColor, abstractStatusLabel, PRESENTATION_TYPE_LABELS } from "../abstract-enums";
import {
  PAYMENT_STATUS_COLORS,
  PAYMENT_STATUS_LABELS,
  REGISTRATION_STATUS_COLORS,
} from "../../registrations/registration-enums";

interface AbstractRow {
  id: string;
  title: string;
  status: string;
  presentationType: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
}

interface SourceRegistration {
  id: string;
  serialId: number | null;
  status: string;
  paymentStatus: string;
  attendanceMode: string | null;
  badgeType: string | null;
  qrCode: string | null;
  checkedInAt: string | null;
  surveyCompletedAt: string | null;
  createdSource: string | null;
  ticketType: { name: string; isFaculty: boolean } | null;
}

interface MyProfile {
  id: string;
  title: string | null;
  role: string | null;
  firstName: string;
  lastName: string;
  email: string;
  additionalEmail: string | null;
  organization: string | null;
  jobTitle: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  country: string | null;
  specialty: string | null;
  customSpecialty: string | null;
  status: string;
  agreementAcceptedAt: string | null;
  sourceRegistration: SourceRegistration | null;
  abstracts: AbstractRow[];
}

function Field({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-3">
      <Icon className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-sm break-words">{value}</div>
      </div>
    </div>
  );
}

export default function SubmitterProfilePage() {
  const params = useParams();
  const router = useRouter();
  const eventId = params.eventId as string;

  const { data: event } = useEvent(eventId);
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/events/${eventId}/abstracts/my-profile`);
        if (res.status === 404) {
          // Not a submitter on this event — send them to the abstracts area.
          router.replace(`/events/${eventId}/abstracts`);
          return;
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `Failed to load (HTTP ${res.status})`);
        }
        const data = (await res.json()) as MyProfile;
        if (!cancelled) setProfile(data);
      } catch (err) {
        console.error("[submitter-profile] load failed", err);
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load your profile");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [eventId, router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-md mx-auto mt-16 rounded-xl border bg-card p-6 text-center">
        <AlertCircle className="h-8 w-8 text-red-500 mx-auto mb-3" />
        <h2 className="font-medium mb-1">Couldn&apos;t load your profile</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Your account is safe — please try again.
        </p>
        <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </div>
    );
  }

  if (!profile) return null;

  const reg = profile.sourceRegistration;
  const specialty =
    profile.specialty === "Others" && profile.customSpecialty
      ? profile.customSpecialty
      : profile.specialty;
  const location = [profile.city, profile.state, profile.country].filter(Boolean).join(", ") || null;

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-10">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">
            {formatPersonName(profile.title, profile.firstName, profile.lastName)}
          </h1>
          <p className="text-sm text-muted-foreground">Your submission profile for this event</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href={`/events/${eventId}/abstracts`}>
              <FileText className="h-4 w-4 mr-1.5" /> My Abstracts
            </Link>
          </Button>
          <Button asChild className="btn-gradient">
            <Link href={`/events/${eventId}/abstracts/new`}>
              <Plus className="h-4 w-4 mr-1.5" /> Submit Abstract
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Profile details */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <User className="h-4 w-4 text-primary" /> Your details
            </CardTitle>
          </CardHeader>
          <CardContent className="grid sm:grid-cols-2 gap-4">
            <Field icon={Mail} label="Email" value={profile.email} />
            <Field icon={Mail} label="Additional email" value={profile.additionalEmail} />
            <Field icon={Briefcase} label="Role" value={profile.role ? formatAttendeeRole(profile.role) : null} />
            <Field icon={Stethoscope} label="Specialty" value={specialty} />
            <Field icon={Building2} label="Organization" value={profile.organization} />
            <Field icon={Briefcase} label="Job title" value={profile.jobTitle} />
            <Field icon={Phone} label="Phone" value={profile.phone} />
            <Field icon={MapPin} label="Location" value={location} />
            <div className="sm:col-span-2 text-xs text-muted-foreground pt-1">
              Need a change? Contact the event organizer — your email is your sign-in and can&apos;t be changed here.
            </div>
          </CardContent>
        </Card>

        {/* Registration / attendee facet */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <BadgeCheck className="h-4 w-4 text-primary" /> Registration
            </CardTitle>
          </CardHeader>
          <CardContent>
            {reg ? (
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <div className="text-xs text-muted-foreground">Registration #</div>
                  <div className="text-sm font-mono">
                    {reg.serialId != null ? String(reg.serialId).padStart(3, "0") : "—"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Status</div>
                  <Badge className={`${REGISTRATION_STATUS_COLORS[reg.status as keyof typeof REGISTRATION_STATUS_COLORS] ?? "bg-gray-100 text-gray-700"} border-0`}>
                    {reg.status}
                  </Badge>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Payment</div>
                  <Badge className={`${PAYMENT_STATUS_COLORS[reg.paymentStatus as keyof typeof PAYMENT_STATUS_COLORS] ?? "bg-gray-100 text-gray-700"} border-0`}>
                    {PAYMENT_STATUS_LABELS[reg.paymentStatus as keyof typeof PAYMENT_STATUS_LABELS] ?? reg.paymentStatus}
                  </Badge>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Ticket type</div>
                  <div className="text-sm">
                    {reg.ticketType?.name ?? "—"}
                    {reg.ticketType?.isFaculty && (
                      <Badge variant="secondary" className="ml-1.5 text-[10px]">Faculty</Badge>
                    )}
                  </div>
                </div>
                {reg.badgeType && (
                  <div>
                    <div className="text-xs text-muted-foreground">Badge</div>
                    <div className="text-sm">{reg.badgeType}</div>
                  </div>
                )}
                {reg.attendanceMode && (
                  <div>
                    <div className="text-xs text-muted-foreground">Attendance</div>
                    <div className="text-sm">{reg.attendanceMode === "VIRTUAL" ? "Virtual" : "In-person"}</div>
                  </div>
                )}
                <div>
                  <div className="text-xs text-muted-foreground">Checked in</div>
                  <div className="text-sm">
                    {reg.checkedInAt ? new Date(reg.checkedInAt).toLocaleString() : "Not yet"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Survey</div>
                  <div className="text-sm">{reg.surveyCompletedAt ? "Completed" : "Not completed"}</div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No event registration is linked to your profile yet. The organizer will confirm your
                registration; your entry badge and details will appear here once it&apos;s set up.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Abstracts summary */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" /> Your abstracts ({profile.abstracts.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {profile.abstracts.length === 0 ? (
            <div className="text-center py-6">
              <p className="text-sm text-muted-foreground mb-3">You haven&apos;t submitted any abstracts yet.</p>
              <Button asChild className="btn-gradient" size="sm">
                <Link href={`/events/${eventId}/abstracts/new`}>
                  <Plus className="h-4 w-4 mr-1.5" /> Submit your first abstract
                </Link>
              </Button>
            </div>
          ) : (
            <div className="divide-y">
              {profile.abstracts.map((a) => (
                <Link
                  key={a.id}
                  href={`/events/${eventId}/abstracts/${a.id}/edit`}
                  className="flex items-center justify-between gap-3 py-3 hover:bg-muted/30 -mx-2 px-2 rounded transition-colors"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium line-clamp-1">{a.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {a.presentationType
                        ? PRESENTATION_TYPE_LABELS[a.presentationType as keyof typeof PRESENTATION_TYPE_LABELS] ?? a.presentationType
                        : "—"}
                      {a.submittedAt && ` · Submitted ${new Date(a.submittedAt).toLocaleDateString()}`}
                    </div>
                  </div>
                  <Badge className={`${abstractStatusColor(a.status)} border-0 shrink-0`}>
                    {abstractStatusLabel(a.status)}
                  </Badge>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Submission guidelines (per-event editable; default fallback) */}
      <AbstractGuidelines
        html={event?.abstractGuidelinesHtml}
        contactEmail={event?.emailFromAddress}
      />
    </div>
  );
}
