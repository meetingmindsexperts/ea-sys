"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import dynamic from "next/dynamic";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PenLine, Save } from "lucide-react";
import { toast } from "sonner";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

const TiptapEditor = dynamic(
  () => import("@/components/ui/tiptap-editor").then((m) => ({ default: m.TiptapEditor })),
  { ssr: false, loading: () => <div className="h-[300px] border rounded-md animate-pulse bg-muted" /> }
);

export default function ContentPage() {
  const params = useParams();
  const eventId = params.eventId as string;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const showDelayedLoader = useDelayedLoading(loading, 1000);

  const [content, setContent] = useState({
    registrationWelcomeHtml: "",
    registrationTermsHtml: "",
    registrationConfirmationHtml: "",
    abstractWelcomeHtml: "",
    abstractTermsHtml: "",
    abstractConfirmationHtml: "",
  });

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/events/${eventId}`);
        if (res.ok) {
          const data = await res.json();
          setContent({
            registrationWelcomeHtml: data.registrationWelcomeHtml || "",
            registrationTermsHtml: data.registrationTermsHtml || "",
            registrationConfirmationHtml: data.registrationConfirmationHtml || "",
            abstractWelcomeHtml: data.abstractWelcomeHtml || "",
            abstractTermsHtml: data.abstractTermsHtml || "",
            abstractConfirmationHtml: data.abstractConfirmationHtml || "",
          });
        }
      } catch {
        toast.error("Failed to load content");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [eventId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/events/${eventId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          registrationWelcomeHtml: content.registrationWelcomeHtml || null,
          registrationTermsHtml: content.registrationTermsHtml || null,
          registrationConfirmationHtml: content.registrationConfirmationHtml || null,
          abstractWelcomeHtml: content.abstractWelcomeHtml || null,
          abstractTermsHtml: content.abstractTermsHtml || null,
          abstractConfirmationHtml: content.abstractConfirmationHtml || null,
        }),
      });
      if (res.ok) toast.success("Content saved");
      else toast.error("Failed to save");
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        {showDelayedLoader ? <ReloadingSpinner /> : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <PenLine className="h-8 w-8" />
          Content
        </h1>
        <p className="text-muted-foreground mt-1">
          Manage welcome texts, terms & conditions, and confirmation messages
        </p>
      </div>

      <Tabs defaultValue="registration" className="space-y-6">
        <TabsList>
          <TabsTrigger value="registration">Registration</TabsTrigger>
          <TabsTrigger value="abstracts">Abstracts</TabsTrigger>
        </TabsList>

        {/* Registration Content */}
        <TabsContent value="registration">
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Welcome Text</CardTitle>
                <CardDescription>
                  Shown on step 1 of the public registration form, above the personal details fields.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TiptapEditor
                  content={content.registrationWelcomeHtml}
                  onChange={(html) => setContent({ ...content, registrationWelcomeHtml: html })}
                  placeholder="Welcome to our event! Please fill in your details below to register..."
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Terms & Conditions</CardTitle>
                <CardDescription>
                  Displayed in the terms checkbox area. Registrants must agree before submitting.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TiptapEditor
                  content={content.registrationTermsHtml}
                  onChange={(html) => setContent({ ...content, registrationTermsHtml: html })}
                  placeholder="By registering, you agree to the following terms and conditions..."
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Post-Registration Confirmation</CardTitle>
                <CardDescription>
                  Shown on the confirmation page after a successful registration.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TiptapEditor
                  content={content.registrationConfirmationHtml}
                  onChange={(html) => setContent({ ...content, registrationConfirmationHtml: html })}
                  placeholder="Thank you for registering! We look forward to seeing you..."
                />
              </CardContent>
            </Card>

            <div className="flex justify-end">
              <Button onClick={handleSave} disabled={saving}>
                <Save className="mr-2 h-4 w-4" />
                {saving ? "Saving..." : "Save Registration Content"}
              </Button>
            </div>
          </div>
        </TabsContent>

        {/* Abstract Content */}
        <TabsContent value="abstracts">
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Welcome Text</CardTitle>
                <CardDescription>
                  Shown on the abstract submission registration form at /e/[slug]/abstract/register.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TiptapEditor
                  content={content.abstractWelcomeHtml}
                  onChange={(html) => setContent({ ...content, abstractWelcomeHtml: html })}
                  placeholder="Welcome to abstract submissions! Please register to submit your research..."
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Terms & Conditions</CardTitle>
                <CardDescription>
                  Submitters must agree to these terms before submitting an abstract.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TiptapEditor
                  content={content.abstractTermsHtml}
                  onChange={(html) => setContent({ ...content, abstractTermsHtml: html })}
                  placeholder="By submitting an abstract, you agree to the following..."
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Post-Submission Confirmation</CardTitle>
                <CardDescription>
                  Shown after a successful abstract submission.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TiptapEditor
                  content={content.abstractConfirmationHtml}
                  onChange={(html) => setContent({ ...content, abstractConfirmationHtml: html })}
                  placeholder="Thank you for submitting your abstract! We will review it shortly..."
                />
              </CardContent>
            </Card>

            <div className="flex justify-end">
              <Button onClick={handleSave} disabled={saving}>
                <Save className="mr-2 h-4 w-4" />
                {saving ? "Saving..." : "Save Abstract Content"}
              </Button>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
