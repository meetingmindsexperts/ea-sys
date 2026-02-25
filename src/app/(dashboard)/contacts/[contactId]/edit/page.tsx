"use client";

import { useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { useContact, useUpdateContact } from "@/hooks/use-api";
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function EditContactForm({ contactId, contact }: { contactId: string; contact: any }) {
  const router = useRouter();
  const updateContact = useUpdateContact(contactId);

  // Initialized directly from props — no useEffect needed.
  // This component is only rendered once the contact is loaded.
  const [form, setForm] = useState({
    firstName: contact.firstName ?? "",
    lastName: contact.lastName ?? "",
    email: contact.email ?? "",
    organization: contact.organization ?? "",
    jobTitle: contact.jobTitle ?? "",
    specialty: contact.specialty ?? "",
    phone: contact.phone ?? "",
    photo: (contact.photo ?? null) as string | null,
    city: contact.city ?? "",
    country: contact.country ?? "",
    tags: (contact.tags ?? []) as string[],
    notes: contact.notes ?? "",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await updateContact.mutateAsync({
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim().toLowerCase(),
        organization: form.organization.trim() || null,
        jobTitle: form.jobTitle.trim() || null,
        specialty: form.specialty || null,
        phone: form.phone.trim() || null,
        photo: form.photo || null,
        city: form.city.trim() || null,
        country: form.country || null,
        tags: form.tags,
        notes: form.notes.trim() || null,
      });
      toast.success("Contact updated");
      router.push(`/contacts/${contactId}`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update contact");
    }
  };

  return (
    <div className="p-6 max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <Link
          href={`/contacts/${contactId}`}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Edit Contact</h1>
          <p className="text-muted-foreground text-sm">
            {contact.firstName} {contact.lastName}
          </p>
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
          <Label htmlFor="edit-notes">Notes</Label>
          <textarea
            id="edit-notes"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-[80px] resize-none focus:outline-none focus:ring-2 focus:ring-ring"
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          />
        </div>

        {/* Actions */}
        <div className="flex gap-3 pt-2">
          <Button type="button" variant="outline" className="flex-1" asChild>
            <Link href={`/contacts/${contactId}`}>Cancel</Link>
          </Button>
          <Button
            type="submit"
            className="flex-1 btn-gradient"
            disabled={updateContact.isPending}
          >
            {updateContact.isPending ? "Saving…" : "Save Changes"}
          </Button>
        </div>
      </form>
    </div>
  );
}

export default function EditContactPage() {
  const { contactId } = useParams<{ contactId: string }>();
  const { data, isLoading } = useContact(contactId);

  const contact = data?.contact ?? null;

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  if (!contact) {
    return <div className="p-6 text-sm text-muted-foreground">Contact not found.</div>;
  }

  return <EditContactForm contactId={contactId} contact={contact} />;
}
