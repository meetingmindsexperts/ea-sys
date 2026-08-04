"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { TitleSelect } from "@/components/ui/title-select";
import { RoleSelect } from "@/components/ui/role-select";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import { CountrySelect } from "@/components/ui/country-select";
import { PhotoUpload } from "@/components/ui/photo-upload";
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
  Lightbulb,
  Plus,
  Pencil,
  Save,
  X,
  AlertCircle,
} from "lucide-react";
import { formatPersonName } from "@/lib/utils";
import { formatAttendeeRole } from "@/lib/schemas";
import { useEvent, useSubmitterContext } from "@/hooks/use-api";
import { submitterSeesAbstracts, submitterSeesProposals } from "@/lib/submitter-surfaces";
import { isProfileIncomplete, missingProfileFields } from "@/lib/submitter-profile-completeness";
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
  bio: string | null;
  photo: string | null;
  status: string;
  agreementAcceptedAt: string | null;
  sourceRegistration: SourceRegistration | null;
  abstracts: AbstractRow[];
}

/** Editable subset of MyProfile (email stays immutable — sign-in identity). */
interface ProfileForm {
  title: string;
  firstName: string;
  lastName: string;
  role: string;
  specialty: string;
  customSpecialty: string;
  organization: string;
  jobTitle: string;
  phone: string;
  additionalEmail: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
  bio: string;
  photo: string | null;
}

function toProfileForm(p: MyProfile): ProfileForm {
  return {
    title: p.title ?? "",
    firstName: p.firstName,
    lastName: p.lastName,
    role: p.role ?? "",
    specialty: p.specialty ?? "",
    customSpecialty: p.customSpecialty ?? "",
    organization: p.organization ?? "",
    jobTitle: p.jobTitle ?? "",
    phone: p.phone ?? "",
    additionalEmail: p.additionalEmail ?? "",
    city: p.city ?? "",
    state: p.state ?? "",
    zipCode: p.zipCode ?? "",
    country: p.country ?? "",
    bio: p.bio ?? "",
    photo: p.photo,
  };
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
  // My Details is SURFACE-NEUTRAL (Aug 4, 2026 — organizer-reported: proposal
  // submitters had no My Details at all). No surface guard here; instead the
  // abstract-specific blocks below gate on the submitter's surfaces, and a
  // proposal person gets a "My Session Proposals" button.
  const { data: session } = useSession();
  const isSubmitter = session?.user?.role === "SUBMITTER";
  const { data: surfaceCtx } = useSubmitterContext(isSubmitter ? eventId : "");
  const seesAbstracts = surfaceCtx ? submitterSeesAbstracts(surfaceCtx) : true;
  const seesProposals = surfaceCtx ? submitterSeesProposals(surfaceCtx) : false;

  const { data: event } = useEvent(eventId);
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Self-edit (Aug 4, 2026): sparse profiles (minted via the sign-in
  // shortcut) were un-fixable by the person — My Details is now editable.
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<ProfileForm | null>(null);

  const startEditing = () => {
    if (!profile) return;
    setForm(toProfileForm(profile));
    setEditing(true);
  };

  const handleSave = async () => {
    if (!form) return;
    if (!form.firstName.trim() || !form.lastName.trim()) {
      toast.error("First and last name are required");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/events/${eventId}/abstracts/my-profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title || null,
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          role: form.role || null,
          specialty: form.specialty || null,
          customSpecialty: form.specialty === "Others" ? form.customSpecialty.trim() || null : null,
          organization: form.organization.trim() || null,
          jobTitle: form.jobTitle.trim() || null,
          phone: form.phone.trim() || null,
          additionalEmail: form.additionalEmail.trim() || null,
          city: form.city.trim() || null,
          state: form.state.trim() || null,
          zipCode: form.zipCode.trim() || null,
          country: form.country || null,
          bio: form.bio.trim() || null,
          photo: form.photo ?? null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Failed to save your details");
        return;
      }
      setProfile(data as MyProfile);
      setEditing(false);
      toast.success("Your details were updated");
    } catch (err) {
      console.error("[submitter-profile] save failed", err);
      toast.error("Failed to save your details");
    } finally {
      setSaving(false);
    }
  };

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
        if (!cancelled) {
          setProfile(data);
          // Encourage completion (Aug 4, 2026): a sparse profile (sign-in
          // shortcut mint) opens straight into edit mode so the person fills
          // in the details the signup form would have required.
          if (isProfileIncomplete(data)) {
            setForm(toProfileForm(data));
            setEditing(true);
          }
        }
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
  const missingFields = missingProfileFields(profile);
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
        <div className="flex flex-wrap gap-2">
          {seesProposals && (
            <Button asChild variant="outline">
              <Link href={`/events/${eventId}/session-proposals`}>
                <Lightbulb className="h-4 w-4 mr-1.5" /> My Session Proposals
              </Link>
            </Button>
          )}
          {seesAbstracts && (
            <>
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
            </>
          )}
        </div>
      </div>

      {missingFields.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          <strong>Please complete your details</strong> — the organizing team needs them for the
          programme. Missing: {missingFields.join(", ")}.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Profile details — view + self-edit (Aug 4, 2026) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <User className="h-4 w-4 text-primary" /> Your details
              </span>
              {!editing && (
                <Button variant="outline" size="sm" onClick={startEditing}>
                  <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                </Button>
              )}
            </CardTitle>
          </CardHeader>
          {!editing ? (
            <CardContent className="space-y-4">
              <div className="flex items-center gap-4">
                {profile.photo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={profile.photo} alt="" className="w-16 h-16 rounded-full object-cover ring-2 ring-slate-200" />
                ) : (
                  <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
                    <User className="h-6 w-6 text-muted-foreground" />
                  </div>
                )}
                {!profile.photo && (
                  <p className="text-xs text-muted-foreground">No photo yet — click Edit to add one.</p>
                )}
              </div>
              <div className="grid sm:grid-cols-2 gap-4">
                <Field icon={Mail} label="Email" value={profile.email} />
                <Field icon={Mail} label="Additional email" value={profile.additionalEmail} />
                <Field icon={Briefcase} label="Role" value={profile.role ? formatAttendeeRole(profile.role) : null} />
                <Field icon={Stethoscope} label="Specialty" value={specialty} />
                <Field icon={Building2} label="Organization" value={profile.organization} />
                <Field icon={Briefcase} label="Job title" value={profile.jobTitle} />
                <Field icon={Phone} label="Phone" value={profile.phone} />
                <Field icon={MapPin} label="Location" value={location} />
              </div>
              {profile.bio && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Bio</div>
                  <p className="text-sm whitespace-pre-wrap">{profile.bio}</p>
                </div>
              )}
              <div className="text-xs text-muted-foreground pt-1">
                Your email is your sign-in and can&apos;t be changed here — contact the event
                organizer for that.
              </div>
            </CardContent>
          ) : form ? (
            <CardContent className="space-y-4">
              <div>
                <Label className="text-xs">Photo</Label>
                <PhotoUpload value={form.photo} onChange={(url) => setForm({ ...form, photo: url })} disabled={saving} />
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Title</Label>
                  <TitleSelect value={form.title} onChange={(v) => setForm({ ...form, title: v })} />
                </div>
                <div>
                  <Label className="text-xs">Role</Label>
                  <RoleSelect value={form.role} onChange={(v) => setForm({ ...form, role: v })} placeholder="Select a role" />
                </div>
                <div>
                  <Label className="text-xs">First name *</Label>
                  <Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
                </div>
                <div>
                  <Label className="text-xs">Last name *</Label>
                  <Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
                </div>
                <div>
                  <Label className="text-xs">Specialty</Label>
                  <SpecialtySelect value={form.specialty} onChange={(v) => setForm({ ...form, specialty: v })} />
                </div>
                {form.specialty === "Others" && (
                  <div>
                    <Label className="text-xs">Custom specialty</Label>
                    <Input value={form.customSpecialty} onChange={(e) => setForm({ ...form, customSpecialty: e.target.value })} />
                  </div>
                )}
                <div>
                  <Label className="text-xs">Organization</Label>
                  <Input value={form.organization} onChange={(e) => setForm({ ...form, organization: e.target.value })} />
                </div>
                <div>
                  <Label className="text-xs">Job title</Label>
                  <Input value={form.jobTitle} onChange={(e) => setForm({ ...form, jobTitle: e.target.value })} />
                </div>
                <div>
                  <Label className="text-xs">Phone</Label>
                  <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                </div>
                <div>
                  <Label className="text-xs">Additional email</Label>
                  <Input type="email" value={form.additionalEmail} onChange={(e) => setForm({ ...form, additionalEmail: e.target.value })} />
                </div>
                <div>
                  <Label className="text-xs">City</Label>
                  <Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
                </div>
                <div>
                  <Label className="text-xs">State</Label>
                  <Input value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} />
                </div>
                <div>
                  <Label className="text-xs">Zip code</Label>
                  <Input value={form.zipCode} onChange={(e) => setForm({ ...form, zipCode: e.target.value })} />
                </div>
                <div>
                  <Label className="text-xs">Country</Label>
                  <CountrySelect value={form.country} onChange={(v) => setForm({ ...form, country: v })} />
                </div>
              </div>
              <div>
                <Label className="text-xs">Bio</Label>
                <Textarea rows={4} maxLength={5000} value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} placeholder="A short professional biography…" />
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" size="sm" onClick={() => setEditing(false)} disabled={saving}>
                  <X className="h-4 w-4 mr-1" /> Cancel
                </Button>
                <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
                  {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
                  Save
                </Button>
              </div>
            </CardContent>
          ) : null}
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

      {/* Abstracts summary — hidden for proposal-surface submitters (their
          submissions live on the Session Proposals page). */}
      {seesAbstracts && (
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
      )}

      {/* Submission guidelines (per-event editable; default fallback) —
          abstract-surface only. */}
      {seesAbstracts && (
        <AbstractGuidelines
          html={event?.abstractGuidelinesHtml}
          contactEmail={event?.emailFromAddress}
        />
      )}
    </div>
  );
}
