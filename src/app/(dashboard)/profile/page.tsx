"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

const TiptapEditor = dynamic(
  () => import("@/components/ui/tiptap-editor").then((m) => m.TiptapEditor),
  { ssr: false, loading: () => <div className="h-40 rounded-md border bg-muted/30" /> },
);

interface ProfileUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
}

interface ProfileSignature {
  emailSignature: string | null;
}

export default function ProfilePage() {
  const { data: session, update: updateSession } = useSession();
  const [user, setUser] = useState<ProfileUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState({
    firstName: "",
    lastName: "",
  });
  const [signature, setSignature] = useState<string>("");
  const [savingSignature, setSavingSignature] = useState(false);

  useEffect(() => {
    if (!session?.user?.id) return;
    const fetchUser = async () => {
      try {
        const [userRes, profileRes] = await Promise.all([
          fetch(`/api/organization/users/${session.user.id}`),
          fetch(`/api/profile`),
        ]);
        if (!userRes.ok) {
          throw new Error("Failed to load profile");
        }
        const data = (await userRes.json()) as ProfileUser;
        setUser(data);
        setFormData({ firstName: data.firstName || "", lastName: data.lastName || "" });
        if (profileRes.ok) {
          const sig = (await profileRes.json()) as ProfileSignature;
          setSignature(sig.emailSignature ?? "");
        }
      } catch (error) {
        console.error(error);
        toast.error("Failed to load profile");
      } finally {
        setLoading(false);
      }
    };

    fetchUser();
  }, [session?.user?.id]);

  const handleSaveSignature = async () => {
    setSavingSignature(true);
    try {
      const res = await fetch(`/api/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailSignature: signature || null }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data?.error || "Failed to save signature");
      }
      toast.success("Email signature saved");
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : "Failed to save signature");
    } finally {
      setSavingSignature(false);
    }
  };

  const handleSave = async () => {
    if (!session?.user?.id) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/organization/users/${session.user.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: formData.firstName,
          lastName: formData.lastName,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data?.error || "Failed to update profile");
      }

      const updated = (await res.json()) as ProfileUser;
      setUser(updated);
      await updateSession();
      toast.success("Profile updated");
    } catch (error) {
      console.error(error);
      toast.error("Failed to update profile");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Profile</h1>
        <p className="text-muted-foreground">Manage your account details.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Personal Information</CardTitle>
          <CardDescription>Update your name and view your account details.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="firstName">First Name</Label>
            <Input
              id="firstName"
              value={formData.firstName}
              onChange={(event) =>
                setFormData((prev) => ({ ...prev, firstName: event.target.value }))
              }
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="lastName">Last Name</Label>
            <Input
              id="lastName"
              value={formData.lastName}
              onChange={(event) =>
                setFormData((prev) => ({ ...prev, lastName: event.target.value }))
              }
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" value={user?.email || ""} disabled />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="role">Role</Label>
            <Input id="role" value={user?.role || ""} disabled />
          </div>
          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save Changes
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Email Signature</CardTitle>
          <CardDescription>
            Appended to speaker emails you send (invitations and agreements). Each organizer has
            their own signature.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <TiptapEditor
            content={signature}
            onChange={setSignature}
            placeholder="e.g. Best regards, Dr. Jane Smith — Conference Chair"
          />
          <div className="flex justify-end">
            <Button onClick={handleSaveSignature} disabled={savingSignature}>
              {savingSignature ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save Signature
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
