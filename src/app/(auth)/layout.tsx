import { Calendar, Users, MapPin, Ticket } from "lucide-react";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex">
      <div className="flex-1 flex items-center justify-center p-8 bg-background">
        {children}
      </div>
      <div className="hidden lg:flex lg:flex-1 bg-gradient-primary items-center justify-center p-8 relative overflow-hidden">
        {/* Decorative circles */}
        <div className="absolute top-20 right-20 w-64 h-64 rounded-full bg-white/5" />
        <div className="absolute bottom-20 left-20 w-48 h-48 rounded-full bg-white/5" />
        <div className="absolute top-1/2 left-1/4 w-32 h-32 rounded-full bg-white/5" />

        <div className="max-w-md text-center text-white relative z-10">
          <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-white/10 backdrop-blur flex items-center justify-center">
            <Calendar className="h-10 w-10" />
          </div>
          <h1 className="text-4xl font-bold mb-4">EventsHub</h1>
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
