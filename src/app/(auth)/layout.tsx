import { Calendar } from "lucide-react";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex">
      <div className="flex-1 flex items-center justify-center p-8">
        {children}
      </div>
      <div className="hidden lg:flex lg:flex-1 bg-primary items-center justify-center p-8">
        <div className="max-w-md text-center text-primary-foreground">
          <Calendar className="h-16 w-16 mx-auto mb-6" />
          <h1 className="text-3xl font-bold mb-4">EventsHub</h1>
          <p className="text-lg opacity-90">
            The complete event management platform for conferences, meetings,
            and events. Manage registrations, speakers, accommodations, and more.
          </p>
        </div>
      </div>
    </div>
  );
}
