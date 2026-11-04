"use client";

/**
 * The ID and document request page (Nov 4, 2026; src/lib/evidence-request.ts).
 * Opened from a personal emailed link. Asks only for what the person's
 * registration type requires and their registration does not hold yet; the
 * server decides both and is the authority on every rule.
 */
import { Suspense, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { format } from "date-fns";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { EventBannerBand } from "@/components/public/event-banner";
import { SupportingDocumentField, type UploadedDocument } from "@/components/public/registration-form-extras";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { scrollToFirstFormError } from "@/lib/form-error-scroll";
import type { TypeEvidenceField } from "@/lib/type-evidence";

interface Details {
  event: {
    name: string;
    slug: string;
    startDate: string;
    bannerImage: string | null;
    bannerImageMobile: string | null;
    organizationName: string;
  };
  firstName: string;
  lastName: string;
  ticketTypeName: string | null;
  missing: TypeEvidenceField[];
  document: { label: string; instructions: string | null; required: boolean } | null;
}

type TextField = "memberId" | "studentId" | "studentIdExpiry";

const TEXT_FIELDS: { field: TextField; label: string; placeholder?: string; type?: string }[] = [
  { field: "memberId", label: "Member ID", placeholder: "e.g. MEM-12345" },
  { field: "studentId", label: "Student ID", placeholder: "e.g. STU-2024-001" },
  { field: "studentIdExpiry", label: "Student ID Expiry Date", type: "date" },
];

const FIELD_ERROR: Record<TextField, string> = {
  memberId: "Member ID is required",
  studentId: "Student ID is required",
  studentIdExpiry: "A valid student ID expiry date is required",
};

function Shell({ details, children }: { details: Details | null; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#f8f9fb]">
      {details && (
        <EventBannerBand
          banner={details.event.bannerImage}
          bannerMobile={details.event.bannerImageMobile}
          name={details.event.name}
        />
      )}
      <div className="mx-auto w-full max-w-xl px-4 py-8">{children}</div>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm sm:p-8">{children}</div>;
}

function VerifyDetails() {
  const { slug } = useParams<{ slug: string }>();
  const token = useSearchParams().get("token") ?? "";
  const [details, setDetails] = useState<Details | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<TextField, string>>({ memberId: "", studentId: "", studentIdExpiry: "" });
  const [errors, setErrors] = useState<Partial<Record<TextField, string>>>({});
  const [document, setDocument] = useState<UploadedDocument | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) {
      setLoadError("This link is incomplete. Please use the link from your email.");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/public/events/${encodeURIComponent(slug)}/verify-details?token=${encodeURIComponent(token)}`);
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(data?.error ?? "This link could not be opened.");
          return;
        }
        setDetails(data as Details);
        if ((data as Details).missing.length === 0) setDone(true);
      } catch (err) {
        console.error("verify-details: load failed", err);
        if (!cancelled) setLoadError("Could not load this page. Please check your connection and try again.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, token]);

  function showRefusal(fields: string[] | undefined, message: string) {
    if (!fields?.length) {
      setNotice(message);
      return;
    }
    const next: Partial<Record<TextField, string>> = {};
    for (const f of fields) {
      if (f === "supportingDocument") setDocError(`Please attach your ${details?.document?.label ?? "document"} to continue.`);
      else if (f in FIELD_ERROR) next[f as TextField] = FIELD_ERROR[f as TextField];
    }
    setErrors(next);
    setTimeout(() => setNotice(scrollToFirstFormError()), 50);
  }

  async function submit() {
    setNotice(null);
    setErrors({});
    setDocError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/public/events/${encodeURIComponent(slug)}/verify-details`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          memberId: values.memberId || undefined,
          studentId: values.studentId || undefined,
          studentIdExpiry: values.studentIdExpiry || undefined,
          supportingDocumentUrl: document?.url,
          supportingDocumentFilename: document?.filename,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        console.warn("verify-details: refused", res.status, data?.code);
        showRefusal(data?.fields, data?.error ?? "Could not save. Please try again.");
        return;
      }
      setDone(true);
    } catch (err) {
      console.error("verify-details: save failed", err);
      setNotice("Could not save. Please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) {
    return (
      <Shell details={null}>
        <Card>
          <div className="text-center">
            <AlertCircle className="mx-auto mb-3 h-10 w-10 text-red-500" />
            <p className="text-base text-slate-700">{loadError}</p>
          </div>
        </Card>
      </Shell>
    );
  }

  if (!details) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f8f9fb]">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (done) {
    return (
      <Shell details={details}>
        <Card>
          <div className="text-center">
            <CheckCircle2 className="mx-auto mb-3 h-12 w-12 text-emerald-500" />
            <h1 className="mb-2 text-xl font-bold text-slate-900">Thank you, {details.firstName}</h1>
            <p className="text-base text-slate-600">
              We have everything we need for your registration for {details.event.name}. You can close this page.
            </p>
          </div>
        </Card>
      </Shell>
    );
  }

  const textFields = TEXT_FIELDS.filter((f) => details.missing.includes(f.field));

  return (
    <Shell details={details}>
      <Card>
        <h1 className="mb-1 text-xl font-bold text-slate-900">Add your details</h1>
        <p className="mb-6 text-base text-slate-600">
          {details.firstName} {details.lastName}, your registration for <strong>{details.event.name}</strong>
          {details.ticketTypeName ? <> as <strong>{details.ticketTypeName}</strong></> : null}
          {" "}({format(new Date(details.event.startDate), "d MMM yyyy")}) needs the following.
        </p>

        <div className="space-y-5">
          {textFields.length > 0 && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {textFields.map(({ field, label, placeholder, type }) => (
                <div key={field} className="space-y-1.5" data-slot="form-item">
                  <Label htmlFor={field} className="text-sm font-medium text-slate-600">
                    {label} <span className="text-red-400">*</span>
                  </Label>
                  <Input
                    id={field}
                    type={type ?? "text"}
                    placeholder={placeholder}
                    className="rounded-lg border-slate-200 text-base"
                    value={values[field]}
                    aria-invalid={Boolean(errors[field])}
                    onChange={(e) => {
                      setValues((v) => ({ ...v, [field]: e.target.value }));
                      setErrors((er) => ({ ...er, [field]: undefined }));
                      setNotice(null);
                    }}
                  />
                  {errors[field] && (
                    <p data-slot="form-message" className="text-sm text-red-600">{errors[field]}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          {details.document && (
            <SupportingDocumentField
              slug={slug}
              label={details.document.label}
              required={details.document.required}
              instructions={details.document.instructions}
              value={document}
              onChange={setDocument}
              error={docError}
              onError={setDocError}
              onBeforeUpload={() => setNotice(null)}
            />
          )}
        </div>

        <div className="mt-8 flex flex-col items-end gap-2">
          {notice && <p className="text-sm text-red-600">{notice}</p>}
          <Button className="btn-gradient w-full rounded-lg font-semibold sm:w-auto" onClick={submit} disabled={submitting}>
            {submitting ? "Saving..." : "Save my details"}
          </Button>
        </div>
      </Card>
    </Shell>
  );
}

export default function VerifyDetailsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#f8f9fb]">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      }
    >
      <VerifyDetails />
    </Suspense>
  );
}
