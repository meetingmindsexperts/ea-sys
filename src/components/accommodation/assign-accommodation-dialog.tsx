"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { format } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Search, CalendarIcon, Loader2, BedDouble } from "lucide-react";
import { formatPersonName } from "@/lib/utils";

interface RoomType {
  id: string;
  name: string;
  pricePerNight: number;
  currency: string;
  capacity: number;
  totalRooms: number;
  bookedRooms: number;
  isActive: boolean;
}

interface Hotel {
  id: string;
  name: string;
  isActive: boolean;
  roomTypes: RoomType[];
}

interface Registration {
  id: string;
  status: string;
  attendee: {
    title?: string | null;
    firstName: string;
    lastName: string;
    email: string;
    organization?: string | null;
  };
  ticketType: {
    name: string;
  } | null;
  accommodation?: { id: string } | null;
}

interface Speaker {
  id: string;
  title?: string | null;
  firstName: string;
  lastName: string;
  email: string;
  organization?: string | null;
  status: string;
  accommodation?: { id: string } | null;
}

type AssigneeType = "registration" | "speaker";

interface AssignAccommodationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eventId: string;
  hotels: Hotel[];
  onSuccess: () => void;
}

export function AssignAccommodationDialog({
  open,
  onOpenChange,
  eventId,
  hotels,
  onSuccess,
}: AssignAccommodationDialogProps) {
  const [assigneeType, setAssigneeType] = useState<AssigneeType>("registration");
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRoomTypeId, setSelectedRoomTypeId] = useState<string | null>(null);
  const [checkIn, setCheckIn] = useState<Date | undefined>();
  const [checkOut, setCheckOut] = useState<Date | undefined>();
  const [guestCount, setGuestCount] = useState(1);
  const [specialRequests, setSpecialRequests] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Fetch data when dialog opens
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    Promise.all([
      fetch(`/api/events/${eventId}/registrations`)
        .then((res) => (res.ok ? res.json() : []))
        .then((data) => setRegistrations(data)),
      fetch(`/api/events/${eventId}/speakers`)
        .then((res) => (res.ok ? res.json() : []))
        .then((data) => setSpeakers(data)),
    ])
      .catch(() => toast.error("Failed to load data"))
      .finally(() => setLoading(false));
  }, [open, eventId]);

  // Reset form when dialog closes
  useEffect(() => {
    if (open) return;
    setAssigneeType("registration");
    setRegistrations([]);
    setSpeakers([]);
    setSearch("");
    setDebouncedSearch("");
    setSelectedId(null);
    setSelectedRoomTypeId(null);
    setCheckIn(undefined);
    setCheckOut(undefined);
    setGuestCount(1);
    setSpecialRequests("");
  }, [open]);

  // Clear selection when switching assignee type
  useEffect(() => {
    setSelectedId(null);
    setSearch("");
    setDebouncedSearch("");
  }, [assigneeType]);

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => setDebouncedSearch(value), 300);
  }, []);

  // Filter registrations without accommodation
  const availableRegistrations = useMemo(() => {
    return registrations.filter((r) => {
      if (r.accommodation) return false;
      if (r.status === "CANCELLED") return false;
      if (!debouncedSearch) return true;
      const q = debouncedSearch.toLowerCase();
      return (
        r.attendee.firstName.toLowerCase().includes(q) ||
        r.attendee.lastName.toLowerCase().includes(q) ||
        r.attendee.email.toLowerCase().includes(q)
      );
    });
  }, [registrations, debouncedSearch]);

  // Filter speakers without accommodation
  const availableSpeakers = useMemo(() => {
    return speakers.filter((s) => {
      if (s.accommodation) return false;
      if (!debouncedSearch) return true;
      const q = debouncedSearch.toLowerCase();
      return (
        s.firstName.toLowerCase().includes(q) ||
        s.lastName.toLowerCase().includes(q) ||
        s.email.toLowerCase().includes(q)
      );
    });
  }, [speakers, debouncedSearch]);

  // Available room types (active hotels, active rooms with availability)
  const availableRoomTypes = useMemo(() => {
    return hotels
      .filter((h) => h.isActive)
      .map((h) => ({
        ...h,
        roomTypes: h.roomTypes.filter(
          (r) => r.isActive && r.totalRooms - r.bookedRooms > 0
        ),
      }))
      .filter((h) => h.roomTypes.length > 0);
  }, [hotels]);

  const selectedRoomType = useMemo(() => {
    for (const h of hotels) {
      const rt = h.roomTypes.find((r) => r.id === selectedRoomTypeId);
      if (rt) return rt;
    }
    return null;
  }, [hotels, selectedRoomTypeId]);

  const handleSubmit = async () => {
    if (!selectedId) {
      toast.error(`Please select a ${assigneeType === "registration" ? "registration" : "speaker"}`);
      return;
    }
    if (!selectedRoomTypeId) {
      toast.error("Please select a room type");
      return;
    }
    if (!checkIn || !checkOut) {
      toast.error("Please select check-in and check-out dates");
      return;
    }
    if (checkOut <= checkIn) {
      toast.error("Check-out must be after check-in");
      return;
    }
    if (selectedRoomType && guestCount > selectedRoomType.capacity) {
      toast.error(`Guest count exceeds room capacity (${selectedRoomType.capacity})`);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/events/${eventId}/accommodations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(assigneeType === "registration"
            ? { registrationId: selectedId }
            : { speakerId: selectedId }),
          roomTypeId: selectedRoomTypeId,
          checkIn: checkIn.toISOString(),
          checkOut: checkOut.toISOString(),
          guestCount,
          specialRequests: specialRequests || undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || "Failed to assign accommodation");
        return;
      }

      toast.success("Room assigned successfully");
      onSuccess();
      onOpenChange(false);
    } catch {
      toast.error("Failed to assign accommodation");
    } finally {
      setSubmitting(false);
    }
  };

  const currentList = assigneeType === "registration" ? availableRegistrations : availableSpeakers;
  const totalCount = assigneeType === "registration" ? registrations.length : speakers.length;
  const entityLabel = assigneeType === "registration" ? "registration" : "speaker";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[90vw] lg:min-w-[750px] lg:max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Assign Room</DialogTitle>
          <DialogDescription>
            Select a registration or speaker and a room type to create an accommodation booking.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 flex-1 overflow-auto">
          {/* Assignee Type Toggle */}
          <Tabs value={assigneeType} onValueChange={(v) => setAssigneeType(v as AssigneeType)}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="registration">Registration</TabsTrigger>
              <TabsTrigger value="speaker">Speaker</TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Person Picker */}
          <div className="space-y-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name or email…"
                className="pl-9"
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
              />
            </div>
            <ScrollArea className="h-[200px] border rounded-md">
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : currentList.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  <BedDouble className="h-8 w-8 mx-auto mb-2 opacity-30" />
                  {debouncedSearch
                    ? `No ${entityLabel}s match your search.`
                    : totalCount > 0
                    ? `All ${entityLabel}s already have accommodation assigned.`
                    : `No ${entityLabel}s for this event yet.`}
                </div>
              ) : (
                <div className="p-1 space-y-1">
                  <p className="text-xs text-muted-foreground px-2 py-1">
                    {currentList.length} {entityLabel}{currentList.length !== 1 ? "s" : ""} without accommodation
                  </p>
                  {assigneeType === "registration"
                    ? availableRegistrations.map((reg) => (
                        <button
                          key={reg.id}
                          type="button"
                          className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                            selectedId === reg.id
                              ? "border border-primary bg-primary/5"
                              : "hover:bg-muted/50 border border-transparent"
                          }`}
                          onClick={() => setSelectedId(reg.id)}
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-medium">
                              {formatPersonName(reg.attendee.title, reg.attendee.firstName, reg.attendee.lastName)}
                            </span>
                            <Badge variant="outline" className="text-[10px]">
                              {reg.ticketType?.name ?? "—"}
                            </Badge>
                          </div>
                          <span className="text-xs text-muted-foreground">{reg.attendee.email}</span>
                        </button>
                      ))
                    : availableSpeakers.map((spk) => (
                        <button
                          key={spk.id}
                          type="button"
                          className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                            selectedId === spk.id
                              ? "border border-primary bg-primary/5"
                              : "hover:bg-muted/50 border border-transparent"
                          }`}
                          onClick={() => setSelectedId(spk.id)}
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-medium">
                              {formatPersonName(spk.title, spk.firstName, spk.lastName)}
                            </span>
                            <Badge variant="outline" className="text-[10px]">
                              {spk.status}
                            </Badge>
                          </div>
                          <span className="text-xs text-muted-foreground">{spk.email}</span>
                        </button>
                      ))}
                </div>
              )}
            </ScrollArea>
          </div>

          {/* Room Type Picker */}
          <div className="space-y-2">
            <Label>Room Type</Label>
            {availableRoomTypes.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No rooms available. Add more rooms in the Hotels & Rooms tab.
              </p>
            ) : (
              <Select
                value={selectedRoomTypeId ?? undefined}
                onValueChange={(val) => setSelectedRoomTypeId(val)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a room type" />
                </SelectTrigger>
                <SelectContent>
                  {availableRoomTypes.map((hotel) => (
                    <SelectGroup key={hotel.id}>
                      <SelectLabel>{hotel.name}</SelectLabel>
                      {hotel.roomTypes.map((room) => (
                        <SelectItem key={room.id} value={room.id}>
                          {room.name} — {room.currency} {Number(room.pricePerNight)}/night ({room.totalRooms - room.bookedRooms}/{room.totalRooms} available)
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            )}
            {selectedRoomType && (
              <p className="text-xs text-muted-foreground">
                Capacity: up to {selectedRoomType.capacity} guest{selectedRoomType.capacity !== 1 ? "s" : ""}
              </p>
            )}
          </div>

          {/* Date Pickers */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Check-in</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="w-full justify-start text-left font-normal"
                  >
                    {checkIn ? format(checkIn, "PPP") : <span className="text-muted-foreground">Pick a date</span>}
                    <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={checkIn}
                    onSelect={(date) => {
                      setCheckIn(date);
                      if (checkOut && date && checkOut <= date) setCheckOut(undefined);
                    }}
                  />
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-2">
              <Label>Check-out</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="w-full justify-start text-left font-normal"
                  >
                    {checkOut ? format(checkOut, "PPP") : <span className="text-muted-foreground">Pick a date</span>}
                    <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={checkOut}
                    onSelect={setCheckOut}
                    disabled={(date) => (checkIn ? date <= checkIn : false)}
                  />
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {/* Guest Count + Special Requests */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="guestCount">Guest Count</Label>
              <Input
                id="guestCount"
                type="number"
                min={1}
                max={selectedRoomType?.capacity ?? 10}
                value={guestCount}
                onChange={(e) => setGuestCount(parseInt(e.target.value) || 1)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="specialRequests">Special Requests</Label>
              <Textarea
                id="specialRequests"
                placeholder="Any special requirements…"
                value={specialRequests}
                onChange={(e) => setSpecialRequests(e.target.value)}
                rows={2}
              />
            </div>
          </div>
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="btn-gradient"
            onClick={handleSubmit}
            disabled={submitting || !selectedId || !selectedRoomTypeId || !checkIn || !checkOut}
          >
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Assigning…
              </>
            ) : (
              "Assign Room"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
