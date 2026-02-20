"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { format } from "date-fns";
import Link from "next/link";
import {
  Calendar,
  MapPin,
  Clock,
  ClipboardList,
  Loader2,
  CheckCircle2,
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CountrySelect } from "@/components/ui/country-select";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import { toast } from "sonner";

interface TicketType {
  id: string;
  name: string;
  description: string | null;
  price: string;
  currency: string;
  quantity: number;
  soldCount: number;
  available: number;
  soldOut: boolean;
  canPurchase: boolean;
  salesStarted: boolean;
  salesEnded: boolean;
}

interface Event {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  startDate: string;
  endDate: string;
  timezone: string;
  venue: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  bannerImage: string | null;
  footerHtml: string | null;
  organization: {
    name: string;
    logo: string | null;
  };
  ticketTypes: TicketType[];
  abstractSettings?: {
    allowAbstractSubmissions: boolean;
    abstractDeadline: string | null;
  };
}

const registrationSchema = z.object({
  ticketTypeId: z.string().min(1, "Please select a registration type"),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Valid email is required"),
  organization: z.string().optional(),
  jobTitle: z.string().optional(),
  phone: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  specialty: z.string().optional(),
  dietaryReqs: z.string().optional(),
});

type RegistrationForm = z.infer<typeof registrationSchema>;

export default function PublicEventPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;

  const [event, setEvent] = useState<Event | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<RegistrationForm>({
    resolver: zodResolver(registrationSchema),
    defaultValues: {
      ticketTypeId: "",
      firstName: "",
      lastName: "",
      email: "",
      organization: "",
      jobTitle: "",
      phone: "",
      city: "",
      country: "",
      specialty: "",
      dietaryReqs: "",
    },
  });

  useEffect(() => {
    async function fetchEvent() {
      try {
        const res = await fetch(`/api/public/events/${slug}`);
        if (!res.ok) {
          if (res.status === 404) {
            setError("Event not found");
          } else {
            setError("Failed to load event");
          }
          return;
        }
        const data = await res.json();
        setEvent(data);

        // Set default ticket if only one available
        const availableTickets = data.ticketTypes.filter(
          (t: TicketType) => t.canPurchase
        );
        if (availableTickets.length === 1) {
          form.setValue("ticketTypeId", availableTickets[0].id);
        }
      } catch {
        setError("Failed to load event");
      } finally {
        setLoading(false);
      }
    }

    if (slug) {
      fetchEvent();
    }
  }, [slug, form]);

  async function onSubmit(data: RegistrationForm) {
    setSubmitting(true);

    try {
      const res = await fetch(`/api/public/events/${slug}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      const result = await res.json();

      if (!res.ok) {
        toast.error(result.error || "Registration failed");
        setSubmitting(false);
        return;
      }

      // Redirect to confirmation page
      router.push(
        `/e/${slug}/confirmation?id=${result.registration.id}&name=${encodeURIComponent(data.firstName)}`
      );
    } catch {
      toast.error("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">{error || "Event not found"}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const availableTickets = event.ticketTypes.filter((t) => t.canPurchase);
  const selectedTicket = event.ticketTypes.find(
    (t) => t.id === form.watch("ticketTypeId")
  );

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Banner Image */}
      {event.bannerImage && (
        <div className="w-full">
          <Image
            src={event.bannerImage}
            alt={event.name}
            width={1200}
            height={400}
            className="w-full h-48 md:h-64 object-cover"
            unoptimized
          />
        </div>
      )}

      {/* Header */}
      <div className="bg-gradient-primary text-white">
        <div className="max-w-6xl mx-auto px-4 py-8">
          <p className="text-sm opacity-80 mb-2">{event.organization.name}</p>
          <h1 className="text-3xl font-bold mb-4">{event.name}</h1>

          <div className="flex flex-wrap gap-4 text-sm">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              <span>
                {format(new Date(event.startDate), "EEEE, MMMM d, yyyy")}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              <span>{format(new Date(event.startDate), "h:mm a")}</span>
            </div>
            {event.venue && (
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4" />
                <span>
                  {[event.venue, event.city, event.country]
                    .filter(Boolean)
                    .join(", ")}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-8 flex-1">
        <div className="grid md:grid-cols-5 gap-8">
          {/* Event Details & Tickets */}
          <div className="md:col-span-2 space-y-6">
            {event.description && (
              <Card>
                <CardHeader>
                  <CardTitle>About This Event</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground whitespace-pre-wrap">
                    {event.description}
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Registration Types */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ClipboardList className="h-5 w-5" />
                  Registration Types
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {event.ticketTypes.map((regType) => (
                  <div
                    key={regType.id}
                    className={`p-4 border rounded-lg ${
                      regType.canPurchase
                        ? "border-gray-200"
                        : "border-gray-100 bg-gray-50 opacity-60"
                    }`}
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <h4 className="font-medium">{regType.name}</h4>
                        {regType.description && (
                          <p className="text-sm text-muted-foreground">
                            {regType.description}
                          </p>
                        )}
                      </div>
                      <div className="text-right">
                        <p className="font-semibold">
                          {Number(regType.price) === 0
                            ? "Free"
                            : `${regType.currency} ${regType.price}`}
                        </p>
                        {regType.soldOut && (
                          <span className="text-xs text-red-500">Unavailable</span>
                        )}
                        {!regType.salesStarted && (
                          <span className="text-xs text-amber-500">
                            Not Yet Available
                          </span>
                        )}
                        {regType.salesEnded && (
                          <span className="text-xs text-red-500">
                            No Longer Available
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* Submit Abstract Link */}
            {event.abstractSettings?.allowAbstractSubmissions && (
              <Card>
                <CardContent className="py-6">
                  <div className="flex items-center gap-3">
                    <div className="rounded-full bg-primary/10 p-2">
                      <FileText className="h-5 w-5 text-primary" />
                    </div>
                    <div className="flex-1">
                      <h4 className="font-medium">Call for Abstracts</h4>
                      <p className="text-sm text-muted-foreground">
                        Submit your abstract for review
                      </p>
                    </div>
                    <Link href={`/e/${slug}/submitAbstract`}>
                      <Button variant="outline" size="sm">
                        Submit Abstract
                      </Button>
                    </Link>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Registration Form */}
          <div className="md:col-span-3">
            <Card className="sticky top-4">
              <CardHeader>
                <CardTitle>Register</CardTitle>
                <CardDescription>
                  Fill in your details to register for this event
                </CardDescription>
              </CardHeader>
              <CardContent>
                {availableTickets.length === 0 ? (
                  <div className="text-center py-8">
                    <CheckCircle2 className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                    <p className="text-muted-foreground">
                      Registration is currently closed
                    </p>
                  </div>
                ) : (
                  <Form {...form}>
                    <form
                      onSubmit={form.handleSubmit(onSubmit)}
                      className="space-y-4"
                    >
                      <FormField
                        control={form.control}
                        name="ticketTypeId"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Registration Type</FormLabel>
                            <Select
                              onValueChange={field.onChange}
                              value={field.value}
                            >
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue placeholder="Select a registration type" />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {availableTickets.map((regType) => (
                                  <SelectItem key={regType.id} value={regType.id}>
                                    {regType.name} -{" "}
                                    {Number(regType.price) === 0
                                      ? "Free"
                                      : `${regType.currency} ${regType.price}`}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <div className="grid grid-cols-2 gap-3">
                        <FormField
                          control={form.control}
                          name="firstName"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>First Name</FormLabel>
                              <FormControl>
                                <Input placeholder="John" {...field} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="lastName"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Last Name</FormLabel>
                              <FormControl>
                                <Input placeholder="Doe" {...field} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>

                      <FormField
                        control={form.control}
                        name="email"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Email</FormLabel>
                            <FormControl>
                              <Input
                                type="email"
                                placeholder="john@example.com"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="organization"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Organization (Optional)</FormLabel>
                            <FormControl>
                              <Input placeholder="Acme Inc." {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="phone"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Phone (Optional)</FormLabel>
                            <FormControl>
                              <Input placeholder="+1 234 567 8900" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <div className="grid grid-cols-2 gap-3">
                        <FormField
                          control={form.control}
                          name="city"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>City (Optional)</FormLabel>
                              <FormControl>
                                <Input placeholder="New York" {...field} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="country"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Country (Optional)</FormLabel>
                              <CountrySelect
                                value={field.value ?? ""}
                                onChange={field.onChange}
                              />
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>

                      <FormField
                        control={form.control}
                        name="specialty"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Specialty (Optional)</FormLabel>
                            <SpecialtySelect
                              value={field.value ?? ""}
                              onChange={field.onChange}
                            />
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="dietaryReqs"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Dietary Requirements (Optional)</FormLabel>
                            <FormControl>
                              <Input placeholder="e.g. Vegetarian, Halal, Gluten-free" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      {selectedTicket && (
                        <div className="pt-4 border-t">
                          <div className="flex justify-between text-sm mb-2">
                            <span className="text-muted-foreground">
                              {selectedTicket.name}
                            </span>
                            <span>
                              {Number(selectedTicket.price) === 0
                                ? "Free"
                                : `${selectedTicket.currency} ${selectedTicket.price}`}
                            </span>
                          </div>
                        </div>
                      )}

                      <Button
                        type="submit"
                        className="w-full btn-gradient"
                        disabled={submitting}
                      >
                        {submitting && (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        )}
                        {submitting ? "Registering..." : "Complete Registration"}
                      </Button>
                    </form>
                  </Form>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {/* Custom Footer */}
      {event.footerHtml && (
        <div
          className="w-full border-t bg-white"
          dangerouslySetInnerHTML={{ __html: event.footerHtml }}
        />
      )}
    </div>
  );
}
