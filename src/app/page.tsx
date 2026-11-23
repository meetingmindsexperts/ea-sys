import Link from "next/link";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { loadPublicBrandForHost } from "@/lib/public-brand-server";
import { Button } from "@/components/ui/button";
import { Award, Calendar, CheckCircle, Mic, Users } from "lucide-react";

/**
 * The home page. Rewritten Nov 23, 2026 (owner: "we never edited the index
 * page"; same layout, true words). Until then it was the starter template of
 * January 2026: "Event Management Made Simple", "Start Free Trial", "Create
 * Free Account", none of it true of a platform whose staff accounts are made
 * by invitation and whose visitors are attendees.
 *
 * It says what an attendee can do here and offers the two doors the owner
 * asked for: the public catalogue and sign-in. No sign-up button here: most
 * accounts are made as a person registers for an event, and /signup stays
 * reachable from the sign-in page and the catalogue (the old buttons led
 * there through /register). The brand is the attendee-facing one
 * (public-brand.ts), never a name written here. A signed-in person never sees
 * this page: they go to their own home.
 */
const FEATURES = [
  {
    icon: Calendar,
    title: "Find and register",
    description: "Browse the upcoming conferences and webinars and register online in a few minutes.",
  },
  {
    icon: Users,
    title: "Your registrations",
    description: "See every event you registered for, update your details and check your payment from My events.",
  },
  {
    icon: Mic,
    title: "Abstracts and speakers",
    description: "Submit an abstract and follow its review. Invited speakers complete their details online.",
  },
  {
    icon: Award,
    title: "Certificates and replays",
    description: "Download your certificates after the event, and watch a webinar again when a replay is offered.",
  },
];

const WITH_AN_ACCOUNT = [
  "Register for an event and get your confirmation by email",
  "Pay online where a fee applies, and see your payment status",
  "Join a webinar live from its own page",
  "Submit abstracts and follow the decision on each one",
  "Answer the event survey and download your certificate",
  "Find every event you registered for under My events",
];

export default async function Home() {
  const session = await auth();

  if (session?.user) {
    redirect("/dashboard");
  }
  const brand = await loadPublicBrandForHost((await headers()).get("host"));

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            {brand.logo ? (
              // Tall enough for a stacked logo (a mark above its wordmark) to be
              // read, as on the catalogue; a wide one is held by the width and
              // gives way to the two buttons on a narrow phone (it may shrink).
              // eslint-disable-next-line @next/next/no-img-element -- an uploaded logo of unknown size
              <img src={brand.logo} alt={brand.name} className="h-12 w-auto min-w-0 max-w-[150px] shrink object-contain object-left sm:h-14 sm:max-w-[220px]" />
            ) : (
              <>
                <Calendar className="h-6 w-6 shrink-0 text-primary" />
                <span className="truncate text-xl font-bold">{brand.name}</span>
              </>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-4">
            <Button variant="ghost" asChild>
              <Link href="/login">Sign in</Link>
            </Button>
            <Button asChild>
              <Link href="/catalogue">Browse events</Link>
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="py-20 px-4">
        <div className="container mx-auto max-w-4xl text-center">
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-6">
            Conferences and webinars
            <br />
            <span className="text-primary">in one place</span>
          </h1>
          <p className="text-xl text-muted-foreground mb-8 max-w-2xl mx-auto">
            Find an event, register online and follow everything from your own account:
            your registration, your abstracts and your certificates.
          </p>
          <div className="flex flex-wrap gap-4 justify-center">
            <Button size="lg" asChild>
              <Link href="/catalogue">Browse events</Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link href="/login">Sign in</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-20 bg-muted/30">
        <div className="container mx-auto px-4">
          <h2 className="text-3xl font-bold text-center mb-12">
            What you can do here
          </h2>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
            {FEATURES.map((feature) => (
              <div
                key={feature.title}
                className="bg-background rounded-lg p-6 border"
              >
                <feature.icon className="h-10 w-10 text-primary mb-4" />
                <h3 className="text-lg font-semibold mb-2">{feature.title}</h3>
                <p className="text-muted-foreground">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* With an account */}
      <section className="py-20 px-4">
        <div className="container mx-auto max-w-4xl">
          <h2 className="text-3xl font-bold text-center mb-4">
            One account for all of it
          </h2>
          <p className="text-center text-lg text-muted-foreground mb-12">
            Your account is made as you register for an event. You can also create one from the sign-in page.
          </p>
          <div className="space-y-6">
            {WITH_AN_ACCOUNT.map((line) => (
              <div key={line} className="flex items-center gap-3">
                <CheckCircle className="h-6 w-6 text-green-500 flex-shrink-0" />
                <span className="text-lg">{line}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 bg-primary text-primary-foreground">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-3xl font-bold mb-4">Looking for an event?</h2>
          <p className="text-lg opacity-90 mb-8">
            See what is coming up and register in a few minutes.
          </p>
          <Button size="lg" variant="secondary" asChild>
            <Link href="/catalogue">Browse events</Link>
          </Button>
          <p className="mt-6 text-sm opacity-90">
            Already registered?{" "}
            <Link href="/login" className="font-medium underline underline-offset-4">
              Sign in
            </Link>
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t py-8">
        <div className="container mx-auto px-4 text-center text-muted-foreground">
          <p>&copy; {new Date().getFullYear()} {brand.name}. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
