"use client";

/**
 * Public speaker profile form (token link, Aug 4 2026).
 *
 * The speaker uploads their headshot PHOTO (required — lands on their speaker
 * profile immediately), a PASSPORT photocopy (required) + COVER LETTER
 * (optional; both stored on their Documents card), and reviews their BIO.
 * Uploads commit as they happen; Submit finalizes (locks the form; the
 * organizer can reopen from the speaker page).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { EventBanner } from "@/components/public/event-banner";
import { Camera, Check, FileText, Loader2, Upload, UserRound } from "lucide-react";
import {
  MAX_PROFILE_BIO_LENGTH,
  missingProfileDocSlots,
  PROFILE_DOC_ACCEPT,
  PROFILE_DOC_LABELS,
  PROFILE_DOC_MAX_SIZE,
  PROFILE_DOC_SLOT_TITLES,
  PROFILE_PHOTO_ACCEPT,
  PROFILE_PHOTO_MAX_SIZE,
  profileSlotForLabel,
  REQUIRED_PROFILE_DOC_SLOTS,
  type ProfileDocSlot,
} from "@/lib/speaker-profile/constants";

interface DocumentRow {
  id: string;
  label: string | null;
  filename: string;
  size: number;
  createdAt: string;
}

interface FormData {
  status: "PENDING" | "SUBMITTED";
  submittedAt: string | null;
  event: {
    name: string;
    bannerImage: string | null;
    bannerImageMobile: string | null;
    startDate: string;
    endDate: string;
    venue: string | null;
    city: string | null;
    organizationName: string | null;
  };
  speaker: {
    name: string;
    email: string;
    photo: string | null;
    bio: string | null;
    organization: string | null;
    jobTitle: string | null;
  };
  documents: DocumentRow[];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function SpeakerProfileFormPage() {
  const params = useParams<{ slug: string; token: string }>();
  const slug = params?.slug ?? "";
  const token = params?.token ?? "";
  const base = `/api/public/events/${slug}/speaker-form/${token}`;

  const [data, setData] = useState<FormData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bio, setBio] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [uploadingSlot, setUploadingSlot] = useState<ProfileDocSlot | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(base);
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setLoadError(json?.error ?? "This link is invalid.");
        return;
      }
      setData(json as FormData);
      setBio((json as FormData).speaker.bio ?? "");
      setPhoto((json as FormData).speaker.photo);
      setDocuments((json as FormData).documents);
    } catch (err) {
      console.error("speaker-form load failed", err);
      setLoadError("Couldn't load the form. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    if (slug && token) void load();
  }, [slug, token, load]);

  const uploadPhoto = async (file: File) => {
    setFormError(null);
    if (file.size > PROFILE_PHOTO_MAX_SIZE) {
      setFormError("Photo must be under 500KB.");
      return;
    }
    setUploadingPhoto(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${base}/photo`, { method: "POST", body: fd });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setFormError(json?.error ?? "Failed to upload the photo.");
        return;
      }
      setPhoto(json.photo as string);
    } catch (err) {
      console.error("speaker-form photo upload failed", err);
      setFormError("Failed to upload the photo. Please try again.");
    } finally {
      setUploadingPhoto(false);
    }
  };

  const uploadDocument = async (slot: ProfileDocSlot, file: File) => {
    setFormError(null);
    if (file.size > PROFILE_DOC_MAX_SIZE) {
      setFormError("File must be under 10MB.");
      return;
    }
    setUploadingSlot(slot);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("slot", slot);
      const res = await fetch(`${base}/documents`, { method: "POST", body: fd });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setFormError(json?.error ?? "Failed to upload the document.");
        return;
      }
      const doc = json.document as DocumentRow;
      setDocuments((prev) => [...prev.filter((d) => profileSlotForLabel(d.label) !== slot), doc]);
    } catch (err) {
      console.error("speaker-form document upload failed", err);
      setFormError("Failed to upload the document. Please try again.");
    } finally {
      setUploadingSlot(null);
    }
  };

  const handleSubmit = async () => {
    setFormError(null);
    if (!photo) {
      setFormError("Please upload your photo before submitting.");
      return;
    }
    const missing = missingProfileDocSlots(documents.map((d) => d.label ?? ""));
    if (missing.length > 0) {
      setFormError(`Please upload: ${missing.map((s) => PROFILE_DOC_LABELS[s]).join(", ")}.`);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bio: bio.trim() || undefined }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        if (json?.code === "ALREADY_SUBMITTED") {
          setDone(true);
          return;
        }
        setFormError(json?.error ?? "Failed to submit the form.");
        return;
      }
      setDone(true);
      window.scrollTo({ top: 0 });
    } catch (err) {
      console.error("speaker-form submit failed", err);
      setFormError("Failed to submit the form. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center [color-scheme:light]">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    );
  }
  if (loadError || !data) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center px-4 [color-scheme:light]">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 max-w-md text-center">
          <p className="text-slate-700">{loadError ?? "This link is invalid."}</p>
        </div>
      </div>
    );
  }

  const alreadySubmitted = data.status === "SUBMITTED" && !done;
  const docFor = (slot: ProfileDocSlot) =>
    documents.find((d) => profileSlotForLabel(d.label) === slot) ?? null;

  return (
    <div className="min-h-screen bg-slate-100 pb-16 [color-scheme:light]">
      <div className="bg-white border-b border-slate-200">
        <div className="max-w-[1120px] mx-auto">
          <EventBanner
            banner={data.event.bannerImage}
            bannerMobile={data.event.bannerImageMobile}
            name={data.event.name}
            className="block w-full h-auto"
            priority
          />
        </div>
        <div className="h-1 bg-gradient-primary" />
      </div>
      <div className="max-w-3xl mx-auto px-4">
        <div className="bg-white rounded-2xl mt-8 overflow-hidden ring-1 ring-slate-900/10 shadow-[0_1px_2px_rgb(15_23_42/0.06),0_12px_24px_-8px_rgb(15_23_42/0.10)]">
          <div className="px-6 sm:px-10 pt-8 pb-6 border-b border-slate-200 bg-gradient-to-b from-slate-50 to-white">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary mb-1.5">
              Speaker profile
              {data.event.organizationName ? ` · ${data.event.organizationName}` : ""}
            </p>
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2.5">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-white shadow-sm">
                <UserRound className="h-5 w-5" />
              </span>
              Photo &amp; documents — {data.event.name}
            </h1>
            <p className="text-sm text-slate-600 mt-2">
              {data.speaker.name} ({data.speaker.email})
            </p>
          </div>

          <div className="p-6 sm:p-10">
            {done || alreadySubmitted ? (
              <div className="text-center py-10">
                <div className="mx-auto w-16 h-16 rounded-full bg-emerald-100 ring-8 ring-emerald-50 flex items-center justify-center mb-5">
                  <Check className="h-8 w-8 text-emerald-600" />
                </div>
                <h2 className="text-xl font-semibold text-slate-900 mb-2">
                  {done ? "Thank you — your profile was submitted!" : "This form has already been submitted."}
                </h2>
                <p className="text-sm text-slate-600 max-w-md mx-auto">
                  The organizing team has received your photo and documents. If anything needs
                  changing, contact them and they can reopen the form for you.
                </p>
              </div>
            ) : (
              <div className="space-y-8">
                {/* Photo */}
                <div>
                  <Label className="text-base font-semibold text-slate-900">
                    Your photo <span className="text-red-500">*</span>
                  </Label>
                  <p className="text-xs text-slate-500 mb-3">
                    A recent headshot — JPG, PNG or WebP, under 500KB. It appears next to your
                    name in the event programme.
                  </p>
                  <div className="flex items-center gap-4">
                    {photo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={photo} alt="Your photo" className="w-24 h-24 rounded-full object-cover ring-2 ring-slate-200" />
                    ) : (
                      <div className="w-24 h-24 rounded-full bg-slate-100 ring-2 ring-slate-200 flex items-center justify-center">
                        <Camera className="h-8 w-8 text-slate-400" />
                      </div>
                    )}
                    <div>
                      <input
                        ref={photoInputRef}
                        type="file"
                        accept={PROFILE_PHOTO_ACCEPT}
                        className="hidden"
                        aria-label="Upload photo"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void uploadPhoto(f);
                          e.target.value = "";
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={uploadingPhoto || submitting}
                        onClick={() => photoInputRef.current?.click()}
                      >
                        {uploadingPhoto ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
                        {photo ? "Replace photo" : "Upload photo"}
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Documents */}
                {(["passport", "cover_letter"] as ProfileDocSlot[]).map((slot) => {
                  const doc = docFor(slot);
                  const required = REQUIRED_PROFILE_DOC_SLOTS.includes(slot);
                  const inputId = `speaker-form-doc-${slot}`;
                  return (
                    <div key={slot}>
                      <Label className="text-base font-semibold text-slate-900" htmlFor={inputId}>
                        {PROFILE_DOC_SLOT_TITLES[slot]}{" "}
                        {required ? (
                          <span className="text-red-500">*</span>
                        ) : (
                          <span className="text-slate-400 font-normal text-sm">(optional)</span>
                        )}
                      </Label>
                      <p className="text-xs text-slate-500 mb-3">
                        {slot === "passport"
                          ? "A scan or clear phone photo of your passport photo page — PDF, JPG or PNG, under 10MB."
                          : "PDF, JPG or PNG, under 10MB."}
                      </p>
                      {doc && (
                        <div className="flex items-center gap-2 text-sm text-slate-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 mb-2">
                          <FileText className="h-4 w-4 text-emerald-600 shrink-0" />
                          <span className="truncate">{doc.filename}</span>
                          <span className="text-slate-400 shrink-0">({formatSize(doc.size)})</span>
                          <Check className="h-4 w-4 text-emerald-600 ml-auto shrink-0" />
                        </div>
                      )}
                      <input
                        id={inputId}
                        type="file"
                        accept={PROFILE_DOC_ACCEPT}
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void uploadDocument(slot, f);
                          e.target.value = "";
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={uploadingSlot === slot || submitting}
                        onClick={() => document.getElementById(inputId)?.click()}
                      >
                        {uploadingSlot === slot ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Upload className="h-4 w-4 mr-2" />
                        )}
                        {doc ? "Replace file" : "Upload file"}
                      </Button>
                    </div>
                  );
                })}

                {/* Bio */}
                <div>
                  <Label className="text-base font-semibold text-slate-900" htmlFor="speaker-form-bio">
                    Your bio <span className="text-slate-400 font-normal text-sm">(optional)</span>
                  </Label>
                  <p className="text-xs text-slate-500 mb-3">
                    A short professional biography for the event programme. Review and update if
                    needed.
                  </p>
                  <Textarea
                    id="speaker-form-bio"
                    rows={6}
                    maxLength={MAX_PROFILE_BIO_LENGTH}
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    placeholder="Write a short bio…"
                    disabled={submitting}
                  />
                </div>

                {formError && (
                  <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    {formError}
                  </p>
                )}

                <div className="pt-2">
                  <Button
                    type="button"
                    size="lg"
                    className="w-full sm:w-auto"
                    disabled={submitting || uploadingPhoto || uploadingSlot !== null}
                    onClick={handleSubmit}
                  >
                    {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Submit my profile
                  </Button>
                  <p className="text-xs text-slate-500 mt-2">
                    After you submit, the form locks — contact the organizing team if anything
                    needs changing.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
