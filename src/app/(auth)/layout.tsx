import Image from "next/image";
import { Users, MapPin, Ticket } from "lucide-react";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex">
      {/* ── Left: form panel ───────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-background">
        {/* Logo above the form */}
        <div className="mb-8">
          <Image
            src="/mmg-logo.png"
            alt="Meeting Minds Group"
            width={140}
            height={50}
            className="object-contain"
            priority
          />
        </div>
        {children}
      </div>

      {/* ── Right: brand panel ─────────────────────────────────────────────── */}
      <div className="hidden lg:flex lg:flex-1 bg-gradient-primary items-center justify-center p-8 relative overflow-hidden">
        {/* Decorative circles */}
        <div className="absolute top-20 right-20 w-64 h-64 rounded-full bg-white/5" />
        <div className="absolute bottom-20 left-20 w-48 h-48 rounded-full bg-white/5" />
        <div className="absolute top-1/2 left-1/4 w-32 h-32 rounded-full bg-white/5" />

        <div className="max-w-md text-center text-white relative z-10">
          {/* Logo on white pill */}
          <div className="inline-flex items-center justify-center bg-white rounded-2xl px-8 py-5 mb-8 shadow-lg">
            <Image
              src="/mmg-logo.png"
              alt="Meeting Minds Group"
              width={140}
              height={50}
              className="object-contain"
            />
          </div>
          <p className="text-[11px] font-semibold uppercase tracking-widest text-white/60 mb-3">
            EventsHub
          </p>
          <p className="text-lg opacity-90 mb-8">
            The complete event management platform for conferences, meetings,
            and events. Manage registrations, speakers, accommodations, and more.
          </p>

          {/* Feature highlights */}
          <div className="grid grid-cols-3 gap-4 mt-8">
            <div className="flex flex-col items-center gap-2 p-4 rounded-xl bg-white/10 backdrop-blur">
              <Users className="h-6 w-6" />
              <span className="text-sm font-medium">Speakers</span>
            </div>
            <div className="flex flex-col items-center gap-2 p-4 rounded-xl bg-white/10 backdrop-blur">
              <Ticket className="h-6 w-6" />
              <span className="text-sm font-medium">Tickets</span>
            </div>
            <div className="flex flex-col items-center gap-2 p-4 rounded-xl bg-white/10 backdrop-blur">
              <MapPin className="h-6 w-6" />
              <span className="text-sm font-medium">Venues</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
