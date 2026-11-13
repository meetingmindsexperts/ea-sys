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
import { DEFAULT_PERSON_FIELD_RULES, type PersonFieldRules } from "@/lib/person-fields";
import { personFieldProblems, type PersonFieldPath } from "@/lib/person-field-check";
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
import { isProfileIncomplete, missingProfileFields, rulesSentWith } from "@/lib/submitter-profile-completeness";
import { AbstractGuidelines } from "@/components/abstracts/abstract-guidelines";
import { abstractStatusColor, abstractStatusLabel, PRESENTATION_TYPE_LABELS } from "../abstracts/abstract-enums";
import { isSafeInternalPath } from "@/lib/safe-redirect";

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
  /**
   * Details the person gave elsewhere (their account, an earlier event) for
   * the fields that are empty here. Only on the GET of an incomplete profile;
   * they fill the form and are saved by the person's own Save, never before.
   */
  suggested?: Partial<Record<SuggestedField, string>>;
  /** What the event's organisation asks and demands of Title, Role and Specialty. Only on the GET. */
  fieldRules?: PersonFieldRules;
}

/** How this form names a field the organisation's rule finds missing. */
const RULE_FIELD_LABELS: Record<PersonFieldPath, string> = {
  title: "Title",
  role: "Role",
  specialty: "Specialty",
  customSpecialty: "Custom specialty",
};

type SuggestedField =
  | "title" | "role" | "specialty" | "customSpecialty" | "organization" | "jobTitle"
  | "phone" | "city" | "state" | "zipCode" | "country" | "bio";

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
  // The person's own value, else what they gave elsewhere, else blank.
  const value = (field: SuggestedField) => p[field]?.trim() || p.suggested?.[field] || "";
  return {
    title: value("title"),
    firstName: p.firstName,
    lastName: p.lastName,
    role: value("role"),
    specialty: value("specialty"),
    customSpecialty: value("customSpecialty"),
    organization: value("organization"),
    jobTitle: value("jobTitle"),
    phone: value("phone"),
    additionalEmail: p.additionalEmail ?? "",
    city: value("city"),
    state: value("state"),
    zipCode: value("zipCode"),
    country: value("country"),
    bio: value("bio"),
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
  // What the EVENT's organisation does with Title, Role and Specialty
  // (Settings, Form fields). It arrives with the profile, from the same read
  // the submit gates use, so this page, those gates and the submit routes
  // cannot disagree, and there is no moment when the profile is here and the
  // rules are not (review of f0899baf: the rules used to come from a second
  // read that could land after the profile).
  const [fieldRules, setFieldRules] = useState<PersonFieldRules>(DEFAULT_PERSON_FIELD_RULES);
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
    // Mandatory set (Aug 5, 2026, owner rule) — same fields the public signup
    // form requires. Submission of abstracts/proposals is hard-gated on them.
    const missing = [
      [form.firstName.trim(), "First name"],
      [form.lastName.trim(), "Last name"],
      [form.phone.trim(), "Mobile"],
      [form.jobTitle.trim(), "Job title"],
      [form.organization.trim(), "Organization"],
      [form.city.trim(), "City"],
      [form.country, "Country"],
      // Owner, Aug 7 2026: the bio is printed in the programme and read out at
      // the introduction, so it is mandatory rather than a nicety.
      [form.bio.trim(), "Bio"],
    ]
      .filter(([value]) => !value)
      .map(([, label]) => label);
    // Role, Specialty and the typed specialty beside "Others": demanded as the
    // organisation says, by the one rule the routes apply (person-field-check.ts).
    missing.push(...personFieldProblems(form, fieldRules).map((problem) => RULE_FIELD_LABELS[problem.path]));
    if (missing.length > 0) {
      toast.error(`Please fill in: ${missing.join(", ")}`);
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
      const saved = data as MyProfile;
      setProfile(saved);
      setEditing(false);
      toast.success("Your details were updated");
      // Hard-gate return flow: if the person was bounced here from a submit
      // page (?next=…), completing the profile sends them straight back.
      // Same-origin relative paths only — never an absolute/protocol-relative
      // URL (open-redirect guard).
      // Same-origin only, via the shared guard (Sep 21, 2026) — the
      // hand-rolled version here let "/\t/evil.example" through, because the
      // browser strips the tab AFTER the "//" check has passed it.
      const next = new URLSearchParams(window.location.search).get("next");
      if (isSafeInternalPath(next) && !isProfileIncomplete(saved, fieldRules)) {
        router.push(next);
      }
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
          const rules = rulesSentWith(data);
          setFieldRules(rules);
          setProfile(data);
          // Encourage completion (Aug 4, 2026): a sparse profile (sign-in
          // shortcut mint) opens straight into edit mode so the person fills
          // in the details the signup form would have required.
          if (isProfileIncomplete(data, rules)) {
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

  const missingFields = missingProfileFields(profile, fieldRules);
  // The form opens filled with what the person gave elsewhere; say so, and
  // name what they still have to type themselves (a bio, usually).
  const prefilled = Object.keys(profile.suggested ?? {}).length > 0;
  const stillMissing = missingProfileFields({ ...profile, ...profile.suggested }, fieldRules);
  // Name lock (owner rule, Aug 5, 2026): a name that's already on file —
  // including anyone with an existing registration — is greyed out like the
  // email; changes go through the organizing team. A blank name (rare) can
  // still be filled in once. Server enforces the same rule (NAME_IMMUTABLE).
  const firstNameLocked = !!profile.firstName?.trim();
  const lastNameLocked = !!profile.lastName?.trim();
  const nameLocked = firstNameLocked || lastNameLocked;
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
          <h1 className="text-2xl font-semibold tracking-tight">
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
          <strong>Please complete your details</strong>
          {prefilled && (
            <p className="mt-1">
              We filled in the details you gave us before. Check them
              {stillMissing.length > 0 ? `, add what is missing (${stillMissing.join(", ")})` : ""} and press Save.
            </p>
          )}
        </div>
      )}

      {/* Was a 2-col grid beside a Registration card — that card was removed
          (owner request Aug 5, 2026: the comp/Faculty registration facet is
          organizer bookkeeping, not for the submitter's My Details); the
          profile card now takes the full width. */}
      <div className="grid gap-6">
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
                  <p className="text-sm whitespace-pre-wrap wrap-anywhere">{profile.bio}</p>
                </div>
              )}
              <div className="text-xs text-muted-foreground pt-1">
                Your email is your sign-in and can&apos;t be changed here — contact the event
                organizer for that.
              </div>
            </CardContent>
          ) : null}
          {editing && (form ? (
            <CardContent className="space-y-4">
              {/* Mandatory fields, in the owner-specified order (Aug 5, 2026):
                  Title | First | Last → Email (locked) | Mobile → Job title |
                  Organization → Role | Specialty → City | Country. Names lock
                  once set (registration identity) — like email, changes go
                  through the organizing team. */}
              <div className="grid sm:grid-cols-3 gap-3">
                {fieldRules.title.shown && (
                  <div>
                    <Label className="text-xs">Title</Label>
                    <TitleSelect value={form.title} onChange={(v) => setForm({ ...form, title: v })} />
                  </div>
                )}
                <div>
                  <Label className="text-xs">First name *</Label>
                  <Input
                    value={form.firstName}
                    disabled={firstNameLocked}
                    className={firstNameLocked ? "bg-muted" : undefined}
                    onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                  />
                </div>
                <div>
                  <Label className="text-xs">Last name *</Label>
                  <Input
                    value={form.lastName}
                    disabled={lastNameLocked}
                    className={lastNameLocked ? "bg-muted" : undefined}
                    onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Email</Label>
                  <Input value={profile.email} disabled className="bg-muted" />
                </div>
                <div>
                  <Label className="text-xs">Mobile *</Label>
                  <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                </div>
                <div>
                  <Label className="text-xs">Job title *</Label>
                  <Input value={form.jobTitle} onChange={(e) => setForm({ ...form, jobTitle: e.target.value })} />
                </div>
                <div>
                  <Label className="text-xs">Organization *</Label>
                  <Input value={form.organization} onChange={(e) => setForm({ ...form, organization: e.target.value })} />
                </div>
                {fieldRules.role.shown && (
                  <div>
                    <Label className="text-xs">Role{fieldRules.role.required ? " *" : ""}</Label>
                    <RoleSelect value={form.role} onChange={(v) => setForm({ ...form, role: v })} placeholder="Select a role" />
                  </div>
                )}
                {fieldRules.specialty.shown && (
                  <div>
                    <Label className="text-xs">Specialty{fieldRules.specialty.required ? " *" : ""}</Label>
                    <SpecialtySelect value={form.specialty} onChange={(v) => setForm({ ...form, specialty: v })} />
                  </div>
                )}
                {fieldRules.specialty.shown && form.specialty === "Others" && (
                  <div>
                    <Label className="text-xs">Custom specialty *</Label>
                    <Input value={form.customSpecialty} onChange={(e) => setForm({ ...form, customSpecialty: e.target.value })} />
                  </div>
                )}
                <div>
                  <Label className="text-xs">City *</Label>
                  <Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
                </div>
                <div>
                  <Label className="text-xs">Country *</Label>
                  <CountrySelect value={form.country} onChange={(v) => setForm({ ...form, country: v })} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Your email{nameLocked ? " and name " : " "}can&apos;t be changed here — contact the
                organizing team for that.
              </p>
              <div>
                <Label className="text-xs">Bio <span className="text-red-500">*</span></Label>
                <Textarea rows={4} maxLength={5000} value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} placeholder="A short professional biography — this is what gets printed in the programme." />
              </div>
              <div className="pt-1 border-t">
                <p className="text-xs font-medium text-muted-foreground mt-3 mb-2">Optional</p>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Additional email</Label>
                    <Input type="email" value={form.additionalEmail} onChange={(e) => setForm({ ...form, additionalEmail: e.target.value })} />
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
                    <Label className="text-xs">Photo</Label>
                    <PhotoUpload value={form.photo} onChange={(url) => setForm({ ...form, photo: url })} disabled={saving} />
                  </div>
                </div>
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
          ) : null)}
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
