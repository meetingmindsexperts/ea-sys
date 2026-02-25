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
import { toast } from "sonner";

const emptyForm = {
  firstName: "",
  lastName: "",
  email: "",
  organization: "",
  jobTitle: "",
  specialty: "",
  phone: "",
  photo: null as string | null,
  city: "",
  country: "",
  tags: [] as string[],
  notes: "",
};

export default function NewContactPage() {
  const router = useRouter();
  const [form, setForm] = useState(emptyForm);
  const createContact = useCreateContact();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createContact.mutateAsync({
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim().toLowerCase(),
        organization: form.organization.trim() || undefined,
        jobTitle: form.jobTitle.trim() || undefined,
        specialty: form.specialty || undefined,
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
    <div className="p-6 max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/contacts" className="text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Add Contact</h1>
          <p className="text-muted-foreground text-sm">Add a new contact to your org repository.</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5 rounded-lg border bg-card p-6">
        {/* Photo */}
        <div className="flex justify-center pb-2">
          <PhotoUpload value={form.photo} onChange={(photo) => setForm((f) => ({ ...f, photo }))} />
        </div>

        {/* Name */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>First Name *</Label>
            <Input
              value={form.firstName}
              onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label>Last Name *</Label>
            <Input
              value={form.lastName}
              onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))}
              required
            />
          </div>
        </div>

        {/* Email */}
        <div className="space-y-1.5">
          <Label>Email *</Label>
          <Input
            type="email"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            required
          />
        </div>

        {/* Organization & Job Title */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Organization</Label>
            <Input
              value={form.organization}
              onChange={(e) => setForm((f) => ({ ...f, organization: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Job Title</Label>
            <Input
              value={form.jobTitle}
              onChange={(e) => setForm((f) => ({ ...f, jobTitle: e.target.value }))}
            />
          </div>
        </div>

        {/* Specialty */}
        <div className="space-y-1.5">
          <Label>Specialty</Label>
          <SpecialtySelect
            value={form.specialty}
            onChange={(specialty) => setForm((f) => ({ ...f, specialty }))}
          />
        </div>

        {/* Phone */}
        <div className="space-y-1.5">
          <Label>Phone</Label>
          <Input
            value={form.phone}
            onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
          />
        </div>

        {/* City & Country */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>City</Label>
            <Input
              value={form.city}
              onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Country</Label>
            <CountrySelect
              value={form.country}
              onChange={(country) => setForm((f) => ({ ...f, country }))}
            />
          </div>
        </div>

        {/* Tags */}
        <div className="space-y-1.5">
          <Label>Tags</Label>
          <TagInput
            value={form.tags}
            onChange={(tags) => setForm((f) => ({ ...f, tags }))}
            placeholder="Type a tag and press Enter or comma"
          />
        </div>

        {/* Notes */}
        <div className="space-y-1.5">
          <Label>Notes</Label>
          <textarea
            className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-[80px] resize-none focus:outline-none focus:ring-2 focus:ring-ring"
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          />
        </div>

        {/* Actions */}
        <div className="flex gap-3 pt-2">
          <Button type="button" variant="outline" className="flex-1" asChild>
            <Link href="/contacts">Cancel</Link>
          </Button>
          <Button
            type="submit"
            className="flex-1 btn-gradient"
            disabled={createContact.isPending}
          >
            {createContact.isPending ? "Adding…" : "Add Contact"}
          </Button>
        </div>
      </form>
    </div>
  );
}
