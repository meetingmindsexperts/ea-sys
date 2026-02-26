import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect, notFound } from "next/navigation";
import { formatDate, formatPersonName } from "@/lib/utils";
import {
  ArrowLeft,
  Building2,
  Mail,
  Phone,
  Briefcase,
  Calendar,
  Mic,
  Users,
  Stethoscope,
  Pencil,
  MapPin,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";

const TAG_COLORS = [
  "bg-sky-50 text-sky-700 border-sky-200",
  "bg-emerald-50 text-emerald-700 border-emerald-200",
  "bg-violet-50 text-violet-700 border-violet-200",
  "bg-amber-50 text-amber-700 border-amber-200",
  "bg-rose-50 text-rose-700 border-rose-200",
  "bg-cyan-50 text-cyan-700 border-cyan-200",
];

const AVATAR_BG = [
  "bg-[#00aade]/10 text-[#007a9e]",
  "bg-violet-100 text-violet-600",
  "bg-emerald-100 text-emerald-600",
  "bg-amber-100 text-amber-700",
  "bg-rose-100 text-rose-600",
  "bg-indigo-100 text-indigo-600",
];

const STATUS_STYLES: Record<string, string> = {
  CONFIRMED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  PENDING: "bg-amber-50 text-amber-700 border-amber-200",
  INVITED: "bg-sky-50 text-sky-700 border-sky-200",
  CANCELLED: "bg-gray-50 text-gray-500 border-gray-200",
  REJECTED: "bg-rose-50 text-rose-700 border-rose-200",
  CHECKED_IN: "bg-teal-50 text-teal-700 border-teal-200",
  ACCEPTED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  UNDER_REVIEW: "bg-blue-50 text-blue-700 border-blue-200",
  REVISION_REQUESTED: "bg-orange-50 text-orange-700 border-orange-200",
};

function getTagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) % TAG_COLORS.length;
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

function getAvatarBg(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % AVATAR_BG.length;
  return AVATAR_BG[Math.abs(hash) % AVATAR_BG.length];
}

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ contactId: string }>;
}) {
  const [{ contactId }, session] = await Promise.all([params, auth()]);

  if (!session?.user) redirect("/login");

  const contact = await db.contact.findFirst({
    where: { id: contactId, organizationId: session.user.organizationId! },
  });

  if (!contact) notFound();

  const [speakers, registrations] = await Promise.all([
    db.speaker.findMany({
      where: {
        email: contact.email,
        event: { organizationId: session.user.organizationId! },
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
        event: { select: { id: true, name: true, startDate: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    db.registration.findMany({
      where: {
        attendee: { email: contact.email },
        event: { organizationId: session.user.organizationId! },
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
        event: { select: { id: true, name: true, startDate: true } },
        ticketType: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const eventHistory = [
    ...speakers.map((s) => ({
      eventId: s.event.id,
      eventName: s.event.name,
      eventDate: s.event.startDate,
      role: "Speaker" as const,
      status: s.status,
      createdAt: s.createdAt,
    })),
    ...registrations.map((r) => ({
      eventId: r.event.id,
      eventName: r.event.name,
      eventDate: r.event.startDate,
      role: "Attendee" as const,
      status: r.status,
      createdAt: r.createdAt,
    })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const initials = `${contact.firstName[0] ?? ""}${contact.lastName[0] ?? ""}`.toUpperCase();
  const avatarBg = getAvatarBg(`${contact.firstName}${contact.lastName}`);

  const detailItems = [
    {
      icon: Mail,
      label: "Email",
      value: (
        <a
          href={`mailto:${contact.email}`}
          className="text-sm text-gray-900 hover:text-[#00aade] transition-colors truncate block"
        >
          {contact.email}
        </a>
      ),
      iconBg: "bg-[#00aade]/10",
      iconColor: "text-[#00aade]",
    },
    contact.phone && {
      icon: Phone,
      label: "Phone",
      value: <span className="text-sm text-gray-900">{contact.phone}</span>,
      iconBg: "bg-emerald-50",
      iconColor: "text-emerald-500",
    },
    contact.organization && {
      icon: Building2,
      label: "Organization",
      value: <span className="text-sm text-gray-900">{contact.organization}</span>,
      iconBg: "bg-violet-50",
      iconColor: "text-violet-500",
    },
    contact.jobTitle && {
      icon: Briefcase,
      label: "Job Title",
      value: <span className="text-sm text-gray-900">{contact.jobTitle}</span>,
      iconBg: "bg-amber-50",
      iconColor: "text-amber-500",
    },
    contact.specialty && {
      icon: Stethoscope,
      label: "Specialty",
      value: <span className="text-sm text-gray-900">{contact.specialty}</span>,
      iconBg: "bg-rose-50",
      iconColor: "text-rose-500",
    },
    (contact.city || contact.country) && {
      icon: MapPin,
      label: "Location",
      value: (
        <span className="text-sm text-gray-900">
          {[contact.city, contact.country].filter(Boolean).join(", ")}
        </span>
      ),
      iconBg: "bg-sky-50",
      iconColor: "text-sky-500",
    },
    {
      icon: Calendar,
      label: "Added",
      value: <span className="text-sm text-gray-900">{formatDate(contact.createdAt.toISOString())}</span>,
      iconBg: "bg-gray-50",
      iconColor: "text-gray-400",
    },
  ].filter(Boolean) as Array<{
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    value: React.ReactNode;
    iconBg: string;
    iconColor: string;
  }>;

  return (
    <div className="min-h-screen bg-gray-50/40">
      {/* Header bar */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between max-w-3xl">
          <div className="flex items-center gap-3">
            <Link
              href="/contacts"
              className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <nav className="text-xs text-gray-400 flex items-center gap-1.5">
              <Link href="/contacts" className="hover:text-gray-600 transition-colors">
                Contacts
              </Link>
              <span className="text-gray-300">/</span>
              <span className="text-gray-700 font-medium">
                {formatPersonName(contact.title, contact.firstName, contact.lastName)}
              </span>
            </nav>
          </div>
          <Button variant="outline" size="sm" asChild className="h-8 text-xs border-gray-200">
            <Link href={`/contacts/${contactId}/edit`}>
              <Pencil className="h-3.5 w-3.5 mr-1.5" />
              Edit
            </Link>
          </Button>
        </div>
      </div>

      <div className="px-6 py-6 max-w-3xl space-y-5">
        {/* Profile hero card */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="h-1.5 bg-gradient-to-r from-[#00aade] via-[#00c8ff] to-[#00aade]/40" />
          <div className="p-6">
            <div className="flex items-start gap-5">
              {contact.photo ? (
                <Image
                  src={contact.photo}
                  alt={formatPersonName(contact.title, contact.firstName, contact.lastName)}
                  width={64}
                  height={64}
                  className="w-16 h-16 rounded-full object-cover ring-2 ring-gray-100 shrink-0"
                />
              ) : (
                <div
                  className={`w-16 h-16 rounded-full flex items-center justify-center text-xl font-semibold shrink-0 ${avatarBg}`}
                >
                  {initials}
                </div>
              )}
              <div className="flex-1 min-w-0 pt-0.5">
                <h1 className="text-xl font-semibold text-gray-900 leading-tight">
                  {formatPersonName(contact.title, contact.firstName, contact.lastName)}
                </h1>
                {(contact.jobTitle || contact.organization) && (
                  <p className="text-sm text-gray-500 mt-0.5">
                    {[contact.jobTitle, contact.organization].filter(Boolean).join(" · ")}
                  </p>
                )}
                {contact.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2.5">
                    {contact.tags.map((tag) => (
                      <span
                        key={tag}
                        className={`text-xs px-2.5 py-0.5 rounded-full font-medium border ${getTagColor(tag)}`}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Contact details */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2.5">
            <div className="w-1 h-4 rounded-full bg-[#00aade]" />
            <h2 className="text-sm font-semibold text-gray-700">Contact Details</h2>
          </div>
          <div className="p-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {detailItems.map((item, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div
                    className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${item.iconBg}`}
                  >
                    <item.icon className={`h-3.5 w-3.5 ${item.iconColor}`} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                      {item.label}
                    </div>
                    {item.value}
                  </div>
                </div>
              ))}
            </div>

            {contact.notes && (
              <div className="mt-5 pt-5 border-t border-gray-100">
                <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">
                  Notes
                </div>
                <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed bg-gray-50 rounded-lg px-4 py-3">
                  {contact.notes}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Event history */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-1 h-4 rounded-full bg-violet-400" />
              <div>
                <h2 className="text-sm font-semibold text-gray-700">Event History</h2>
                <p className="text-xs text-gray-400">
                  {eventHistory.length} appearance{eventHistory.length !== 1 ? "s" : ""}
                </p>
              </div>
            </div>
          </div>

          {eventHistory.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <div className="w-10 h-10 rounded-2xl bg-gray-100 flex items-center justify-center mx-auto mb-3">
                <Calendar className="h-5 w-5 text-gray-300" />
              </div>
              <p className="text-sm font-medium text-gray-500">Not yet added to any events</p>
              <p className="text-xs text-gray-400 mt-1">
                Import this contact into an event as a speaker or attendee
              </p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/60">
                  <th className="text-left px-6 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                    Event
                  </th>
                  <th className="text-left px-6 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                    Role
                  </th>
                  <th className="text-left px-6 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="text-left px-6 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                    Date
                  </th>
                </tr>
              </thead>
              <tbody>
                {eventHistory.map((item, i) => (
                  <tr
                    key={i}
                    className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60 transition-colors"
                  >
                    <td className="px-6 py-3.5">
                      <Link
                        href={`/events/${item.eventId}`}
                        className="font-medium text-gray-900 hover:text-[#00aade] transition-colors"
                      >
                        {item.eventName}
                      </Link>
                    </td>
                    <td className="px-6 py-3.5">
                      <div className="flex items-center gap-1.5 text-gray-600">
                        {item.role === "Speaker" ? (
                          <Mic className="h-3.5 w-3.5 text-violet-400 shrink-0" />
                        ) : (
                          <Users className="h-3.5 w-3.5 text-[#00aade] shrink-0" />
                        )}
                        <span className="text-sm">{item.role}</span>
                      </div>
                    </td>
                    <td className="px-6 py-3.5">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full font-medium border ${
                          STATUS_STYLES[item.status] ?? "bg-gray-50 text-gray-500 border-gray-200"
                        }`}
                      >
                        {item.status.toLowerCase().replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-6 py-3.5 text-sm text-gray-400">
                      {formatDate(item.eventDate.toISOString())}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
