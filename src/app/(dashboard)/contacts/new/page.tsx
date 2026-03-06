"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useCreateContact } from "@/hooks/use-api";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PhotoUpload } from "@/components/ui/photo-upload";
import { CountrySelect } from "@/components/ui/country-select";
import { TagInput } from "@/components/ui/tag-input";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import { TitleSelect } from "@/components/ui/title-select";
import { toast } from "sonner";

const emptyForm = {
  title: "",
  firstName: "",
  lastName: "",
  email: "",
  organization: "",
  jobTitle: "",
  specialty: "",
  registrationType: "",
  bio: "",
  phone: "",
  photo: null as string | null,
  city: "",
  country: "",
  tags: [] as string[],
  notes: "",
};

function SectionCard({
  accentColor,
  title,
  children,
}: {
  accentColor: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-5 py-3.5 border-b border-gray-100 flex items-center gap-2.5">
        <div className={`w-1 h-4 rounded-full ${accentColor}`} />
        <h2 className="text-sm font-semibold text-gray-700">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function FormField({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-gray-500">
        {label}
        {required && <span className="text-rose-400 ml-0.5">*</span>}
      </Label>
      {children}
    </div>
  );
}

const inputCls =
  "h-9 text-sm border-gray-200 focus-visible:ring-[#00aade]/20 focus-visible:border-[#00aade]";

export default function NewContactPage() {
  const router = useRouter();
  const [form, setForm] = useState(emptyForm);
  const createContact = useCreateContact();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createContact.mutateAsync({
        title: form.title || undefined,
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim().toLowerCase(),
        organization: form.organization.trim() || undefined,
        jobTitle: form.jobTitle.trim() || undefined,
        specialty: form.specialty || undefined,
        registrationType: form.registrationType.trim() || undefined,
        bio: form.bio.trim() || undefined,
        phone: form.phone.trim() || undefined,
        photo: form.photo || undefined,
        city: form.city.trim() || undefined,
        country: form.country || undefined,
        tags: form.tags,
        notes: form.notes.trim() || undefined,
      });
      toast.success("Contact added");
      router.push("/contacts");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to add contact");
    }
  };

  return (
    <div className="min-h-screen bg-gray-50/40">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center gap-3 max-w-2xl">
          <Link
            href="/contacts"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-gray-900">Add Contact</h1>
            <p className="text-xs text-gray-400 mt-0.5">
              <Link href="/contacts" className="hover:text-gray-600 transition-colors">Contacts</Link>
              <span className="mx-1.5 text-gray-300">/</span>
              New
            </p>
          </div>
        </div>
      </div>

      <div className="px-6 py-6 max-w-5xl">
        <form onSubmit={handleSubmit} className="space-y-4">

          {/* Identity — full width, photo left + fields right */}
          <SectionCard accentColor="bg-[#00aade]" title="Identity">
            <div className="flex gap-6 items-start">
              <div className="shrink-0">
                <PhotoUpload
                  value={form.photo}
                  onChange={(photo) => setForm((f) => ({ ...f, photo }))}
                />
              </div>
              <div className="flex-1 min-w-0 space-y-3">
                <div className="grid grid-cols-[100px_1fr_1fr] gap-3">
                  <FormField label="Title">
                    <TitleSelect
                      value={form.title}
                      onChange={(title) => setForm((f) => ({ ...f, title }))}
                    />
                  </FormField>
                  <FormField label="First Name" required>
                    <Input
                      value={form.firstName}
                      onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))}
                      className={inputCls}
                      required
                    />
                  </FormField>
                  <FormField label="Last Name" required>
                    <Input
                      value={form.lastName}
                      onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))}
                      className={inputCls}
                      required
                    />
                  </FormField>
                </div>
                <FormField label="Email Address" required>
                  <Input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                    className={inputCls}
                    required
                  />
                </FormField>
              </div>
            </div>
          </SectionCard>

          {/* Professional + Contact Info — side by side */}
          <div className="grid grid-cols-2 gap-4">
            <SectionCard accentColor="bg-violet-400" title="Professional">
              <div className="space-y-3">
                <FormField label="Organization">
                  <Input
                    value={form.organization}
                    onChange={(e) => setForm((f) => ({ ...f, organization: e.target.value }))}
                    className={inputCls}
                  />
                </FormField>
                <FormField label="Job Title">
                  <Input
                    value={form.jobTitle}
                    onChange={(e) => setForm((f) => ({ ...f, jobTitle: e.target.value }))}
                    className={inputCls}
                  />
                </FormField>
                <FormField label="Specialty">
                  <SpecialtySelect
                    value={form.specialty}
                    onChange={(specialty) => setForm((f) => ({ ...f, specialty }))}
                  />
                </FormField>
                <FormField label="Bio">
                  <textarea
                    placeholder="Short biography"
                    className={`${inputCls} min-h-[80px] w-full rounded-md border px-3 py-2`}
                    value={form.bio}
                    onChange={(e) => setForm((f) => ({ ...f, bio: e.target.value }))}
                  />
                </FormField>
              </div>
            </SectionCard>

            <SectionCard accentColor="bg-emerald-400" title="Contact Information">
              <div className="space-y-3">
                <FormField label="Phone">
                  <Input
                    value={form.phone}
                    onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                    className={inputCls}
                  />
                </FormField>
                <FormField label="City">
                  <Input
                    value={form.city}
                    onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
                    className={inputCls}
                  />
                </FormField>
                <FormField label="Country">
                  <CountrySelect
                    value={form.country}
                    onChange={(country) => setForm((f) => ({ ...f, country }))}
                  />
                </FormField>
              </div>
            </SectionCard>
          </div>

          {/* Tags & Notes — full width */}
          <SectionCard accentColor="bg-amber-400" title="Tags & Notes">
            <div className="grid grid-cols-2 gap-4">
              <FormField label="Tags">
                <TagInput
                  value={form.tags}
                  onChange={(tags) => setForm((f) => ({ ...f, tags }))}
                  placeholder="Type a tag and press Enter or comma"
                />
              </FormField>
              <FormField label="Notes">
                <textarea
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm min-h-[80px] resize-none focus:outline-none focus:ring-2 focus:ring-[#00aade]/20 focus:border-[#00aade] transition-colors"
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="Any additional notes…"
                />
              </FormField>
            </div>
          </SectionCard>

          {/* Actions */}
          <div className="flex gap-3 pt-1 max-w-sm">
            <Button
              type="button"
              variant="outline"
              className="flex-1 h-10 border-gray-200 text-gray-600"
              asChild
            >
              <Link href="/contacts">Cancel</Link>
            </Button>
            <Button
              type="submit"
              className="flex-1 h-10 btn-gradient"
              disabled={createContact.isPending}
            >
              {createContact.isPending ? "Adding…" : "Add Contact"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
