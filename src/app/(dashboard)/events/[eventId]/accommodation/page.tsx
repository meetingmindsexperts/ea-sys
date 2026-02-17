"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Building2,
  Plus,
  Edit,
  Trash2,
  ArrowLeft,
  Star,
  BedDouble,
  Users,
  Phone,
  Mail,
} from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

interface RoomType {
  id: string;
  name: string;
  description: string | null;
  pricePerNight: number;
  currency: string;
  capacity: number;
  totalRooms: number;
  bookedRooms: number;
  amenities: string[];
  isActive: boolean;
  _count: { accommodations: number };
}

interface Hotel {
  id: string;
  name: string;
  address: string | null;
  description: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  stars: number | null;
  isActive: boolean;
  roomTypes: RoomType[];
  _count: { roomTypes: number };
}

interface Accommodation {
  id: string;
  checkIn: string;
  checkOut: string;
  guestCount: number;
  specialRequests: string | null;
  status: string;
  totalPrice: number;
  currency: string;
  confirmationNo: string | null;
  registration: {
    attendee: {
      firstName: string;
      lastName: string;
      email: string;
    };
  };
  roomType: {
    name: string;
    hotel: {
      name: string;
    };
  };
}

export default function AccommodationPage() {
  const params = useParams();
  const eventId = params.eventId as string;
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [accommodations, setAccommodations] = useState<Accommodation[]>([]);
  const [loading, setLoading] = useState(true);
  const [isHotelDialogOpen, setIsHotelDialogOpen] = useState(false);
  const [isRoomDialogOpen, setIsRoomDialogOpen] = useState(false);
  const [selectedHotelId, setSelectedHotelId] = useState<string | null>(null);
  const [editingHotel, setEditingHotel] = useState<Hotel | null>(null);
  const [hotelFormData, setHotelFormData] = useState({
    name: "",
    address: "",
    description: "",
    contactEmail: "",
    contactPhone: "",
    stars: "",
    isActive: true,
  });
  const [roomFormData, setRoomFormData] = useState({
    name: "",
    description: "",
    pricePerNight: 0,
    currency: "USD",
    capacity: 2,
    totalRooms: 10,
    amenities: "",
    isActive: true,
  });

  const fetchHotels = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/hotels`);
      if (res.ok) {
        const data = await res.json();
        setHotels(data);
      }
    } catch (error) {
      console.error("Error fetching hotels:", error);
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  const fetchAccommodations = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/accommodations`);
      if (res.ok) {
        const data = await res.json();
        setAccommodations(data);
      }
    } catch (error) {
      console.error("Error fetching accommodations:", error);
    }
  }, [eventId]);

  useEffect(() => {
    Promise.all([fetchHotels(), fetchAccommodations()]);
  }, [fetchHotels, fetchAccommodations]);

  const handleHotelSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const url = editingHotel
        ? `/api/events/${eventId}/hotels/${editingHotel.id}`
        : `/api/events/${eventId}/hotels`;
      const method = editingHotel ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...hotelFormData,
          stars: hotelFormData.stars ? parseInt(hotelFormData.stars) : null,
        }),
      });

      if (res.ok) {
        fetchHotels();
        setIsHotelDialogOpen(false);
        resetHotelForm();
      }
    } catch (error) {
      console.error("Error saving hotel:", error);
    }
  };

  const handleRoomSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedHotelId) return;

    try {
      const res = await fetch(
        `/api/events/${eventId}/hotels/${selectedHotelId}/rooms`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...roomFormData,
            amenities: roomFormData.amenities
              .split(",")
              .map((a) => a.trim())
              .filter(Boolean),
          }),
        }
      );

      if (res.ok) {
        fetchHotels();
        setIsRoomDialogOpen(false);
        resetRoomForm();
      }
    } catch (error) {
      console.error("Error saving room:", error);
    }
  };

  const handleDeleteHotel = async (hotelId: string) => {
    if (!confirm("Are you sure you want to delete this hotel?")) return;

    try {
      const res = await fetch(`/api/events/${eventId}/hotels/${hotelId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        fetchHotels();
      }
    } catch (error) {
      console.error("Error deleting hotel:", error);
    }
  };

  const openEditHotelDialog = (hotel: Hotel) => {
    setEditingHotel(hotel);
    setHotelFormData({
      name: hotel.name,
      address: hotel.address || "",
      description: hotel.description || "",
      contactEmail: hotel.contactEmail || "",
      contactPhone: hotel.contactPhone || "",
      stars: hotel.stars?.toString() || "",
      isActive: hotel.isActive,
    });
    setIsHotelDialogOpen(true);
  };

  const openAddRoomDialog = (hotelId: string) => {
    setSelectedHotelId(hotelId);
    setIsRoomDialogOpen(true);
  };

  const resetHotelForm = () => {
    setEditingHotel(null);
    setHotelFormData({
      name: "",
      address: "",
      description: "",
      contactEmail: "",
      contactPhone: "",
      stars: "",
      isActive: true,
    });
  };

  const resetRoomForm = () => {
    setSelectedHotelId(null);
    setRoomFormData({
      name: "",
      description: "",
      pricePerNight: 0,
      currency: "USD",
      capacity: 2,
      totalRooms: 10,
      amenities: "",
      isActive: true,
    });
  };

  const statusColors: Record<string, string> = {
    PENDING: "bg-yellow-100 text-yellow-800",
    CONFIRMED: "bg-green-100 text-green-800",
    CANCELLED: "bg-red-100 text-red-800",
    CHECKED_IN: "bg-blue-100 text-blue-800",
    CHECKED_OUT: "bg-gray-100 text-gray-800",
  };

  const stats = {
    totalHotels: hotels.length,
    totalRooms: hotels.reduce(
      (acc, h) => acc + h.roomTypes.reduce((a, r) => a + r.totalRooms, 0),
      0
    ),
    totalBookings: accommodations.length,
    confirmedBookings: accommodations.filter((a) => a.status === "CONFIRMED")
      .length,
  };

  const showDelayedLoader = useDelayedLoading(loading, 1000);

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
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Link
              href={`/events/${eventId}`}
              className="text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <h1 className="text-3xl font-bold flex items-center gap-2">
              <Building2 className="h-8 w-8" />
              Accommodation
            </h1>
          </div>
          <p className="text-muted-foreground">
            Manage hotels, room types, and guest bookings
          </p>
        </div>
        <Dialog
          open={isHotelDialogOpen}
          onOpenChange={(open) => {
            setIsHotelDialogOpen(open);
            if (!open) resetHotelForm();
          }}
        >
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Add Hotel
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>
                {editingHotel ? "Edit Hotel" : "Add Hotel"}
              </DialogTitle>
            </DialogHeader>
            <form onSubmit={handleHotelSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="hotelName">Hotel Name</Label>
                <Input
                  id="hotelName"
                  value={hotelFormData.name}
                  onChange={(e) =>
                    setHotelFormData({ ...hotelFormData, name: e.target.value })
                  }
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="address">Address</Label>
                <Input
                  id="address"
                  value={hotelFormData.address}
                  onChange={(e) =>
                    setHotelFormData({ ...hotelFormData, address: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="hotelDescription">Description</Label>
                <Textarea
                  id="hotelDescription"
                  value={hotelFormData.description}
                  onChange={(e) =>
                    setHotelFormData({
                      ...hotelFormData,
                      description: e.target.value,
                    })
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="contactEmail">Contact Email</Label>
                  <Input
                    id="contactEmail"
                    type="email"
                    value={hotelFormData.contactEmail}
                    onChange={(e) =>
                      setHotelFormData({
                        ...hotelFormData,
                        contactEmail: e.target.value,
                      })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="contactPhone">Contact Phone</Label>
                  <Input
                    id="contactPhone"
                    value={hotelFormData.contactPhone}
                    onChange={(e) =>
                      setHotelFormData({
                        ...hotelFormData,
                        contactPhone: e.target.value,
                      })
                    }
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="stars">Star Rating</Label>
                  <Select
                    value={hotelFormData.stars}
                    onValueChange={(value) =>
                      setHotelFormData({ ...hotelFormData, stars: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select rating" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">1 Star</SelectItem>
                      <SelectItem value="2">2 Stars</SelectItem>
                      <SelectItem value="3">3 Stars</SelectItem>
                      <SelectItem value="4">4 Stars</SelectItem>
                      <SelectItem value="5">5 Stars</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2 flex items-end">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={hotelFormData.isActive}
                      onChange={(e) =>
                        setHotelFormData({
                          ...hotelFormData,
                          isActive: e.target.checked,
                        })
                      }
                    />
                    <span className="text-sm">Active</span>
                  </label>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsHotelDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit">
                  {editingHotel ? "Save Changes" : "Add Hotel"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Hotels
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalHotels}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Rooms
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalRooms}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Bookings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalBookings}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Confirmed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {stats.confirmedBookings}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Room Dialog */}
      <Dialog
        open={isRoomDialogOpen}
        onOpenChange={(open) => {
          setIsRoomDialogOpen(open);
          if (!open) resetRoomForm();
        }}
      >
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Add Room Type</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleRoomSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="roomName">Room Type Name</Label>
              <Input
                id="roomName"
                value={roomFormData.name}
                onChange={(e) =>
                  setRoomFormData({ ...roomFormData, name: e.target.value })
                }
                placeholder="e.g., Standard Room, Deluxe Suite"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="roomDescription">Description</Label>
              <Textarea
                id="roomDescription"
                value={roomFormData.description}
                onChange={(e) =>
                  setRoomFormData({
                    ...roomFormData,
                    description: e.target.value,
                  })
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="pricePerNight">Price per Night</Label>
                <Input
                  id="pricePerNight"
                  type="number"
                  min="0"
                  step="0.01"
                  value={roomFormData.pricePerNight}
                  onChange={(e) =>
                    setRoomFormData({
                      ...roomFormData,
                      pricePerNight: parseFloat(e.target.value) || 0,
                    })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="currency">Currency</Label>
                <Input
                  id="currency"
                  value={roomFormData.currency}
                  onChange={(e) =>
                    setRoomFormData({ ...roomFormData, currency: e.target.value })
                  }
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="capacity">Max Guests</Label>
                <Input
                  id="capacity"
                  type="number"
                  min="1"
                  value={roomFormData.capacity}
                  onChange={(e) =>
                    setRoomFormData({
                      ...roomFormData,
                      capacity: parseInt(e.target.value) || 1,
                    })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="totalRooms">Total Rooms</Label>
                <Input
                  id="totalRooms"
                  type="number"
                  min="1"
                  value={roomFormData.totalRooms}
                  onChange={(e) =>
                    setRoomFormData({
                      ...roomFormData,
                      totalRooms: parseInt(e.target.value) || 1,
                    })
                  }
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="amenities">Amenities (comma-separated)</Label>
              <Input
                id="amenities"
                value={roomFormData.amenities}
                onChange={(e) =>
                  setRoomFormData({ ...roomFormData, amenities: e.target.value })
                }
                placeholder="WiFi, TV, Mini Bar, Air Conditioning"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsRoomDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit">Add Room Type</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Tabs */}
      <Tabs defaultValue="hotels">
        <TabsList>
          <TabsTrigger value="hotels">Hotels & Rooms</TabsTrigger>
          <TabsTrigger value="bookings">Bookings</TabsTrigger>
        </TabsList>

        <TabsContent value="hotels" className="space-y-4">
          {hotels.length === 0 ? (
            <Card>
              <CardContent className="pt-6">
                <p className="text-muted-foreground text-center py-8">
                  No hotels yet. Click &quot;Add Hotel&quot; to get started.
                </p>
              </CardContent>
            </Card>
          ) : (
            hotels.map((hotel) => (
              <Card key={hotel.id}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-3">
                        <CardTitle>{hotel.name}</CardTitle>
                        {hotel.stars && (
                          <div className="flex items-center">
                            {[...Array(hotel.stars)].map((_, i) => (
                              <Star
                                key={i}
                                className="h-4 w-4 fill-yellow-400 text-yellow-400"
                              />
                            ))}
                          </div>
                        )}
                        <Badge
                          variant="outline"
                          className={
                            hotel.isActive
                              ? "bg-green-100 text-green-800"
                              : "bg-gray-100 text-gray-800"
                          }
                        >
                          {hotel.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </div>
                      {hotel.address && (
                        <p className="text-sm text-muted-foreground mt-1">
                          {hotel.address}
                        </p>
                      )}
                      <div className="flex gap-4 mt-2 text-sm text-muted-foreground">
                        {hotel.contactEmail && (
                          <div className="flex items-center gap-1">
                            <Mail className="h-4 w-4" />
                            {hotel.contactEmail}
                          </div>
                        )}
                        {hotel.contactPhone && (
                          <div className="flex items-center gap-1">
                            <Phone className="h-4 w-4" />
                            {hotel.contactPhone}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openAddRoomDialog(hotel.id)}
                      >
                        <Plus className="h-4 w-4 mr-1" />
                        Add Room
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openEditHotelDialog(hotel)}
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDeleteHotel(hotel.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {hotel.roomTypes.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                      No room types yet. Add room types to this hotel.
                    </p>
                  ) : (
                    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                      {hotel.roomTypes.map((room) => (
                        <div
                          key={room.id}
                          className="border rounded-lg p-4 bg-muted/30"
                        >
                          <div className="flex items-start justify-between mb-2">
                            <div>
                              <h4 className="font-medium">{room.name}</h4>
                              <p className="text-sm text-muted-foreground">
                                {formatCurrency(
                                  Number(room.pricePerNight),
                                  room.currency
                                )}{" "}
                                / night
                              </p>
                            </div>
                            <Badge
                              variant="outline"
                              className={
                                room.isActive
                                  ? "bg-green-100 text-green-800"
                                  : "bg-gray-100 text-gray-800"
                              }
                            >
                              {room.isActive ? "Active" : "Inactive"}
                            </Badge>
                          </div>
                          <div className="flex gap-4 text-sm text-muted-foreground">
                            <div className="flex items-center gap-1">
                              <Users className="h-4 w-4" />
                              Up to {room.capacity}
                            </div>
                            <div className="flex items-center gap-1">
                              <BedDouble className="h-4 w-4" />
                              {room.totalRooms - room.bookedRooms} / {room.totalRooms}
                            </div>
                          </div>
                          {room.amenities.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {room.amenities.slice(0, 3).map((amenity, i) => (
                                <Badge key={i} variant="secondary" className="text-xs">
                                  {amenity}
                                </Badge>
                              ))}
                              {room.amenities.length > 3 && (
                                <Badge variant="secondary" className="text-xs">
                                  +{room.amenities.length - 3}
                                </Badge>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        <TabsContent value="bookings" className="space-y-4">
          {accommodations.length === 0 ? (
            <Card>
              <CardContent className="pt-6">
                <p className="text-muted-foreground text-center py-8">
                  No accommodation bookings yet.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {accommodations.map((booking) => (
                <Card key={booking.id}>
                  <CardContent className="pt-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <h3 className="font-semibold">
                            {booking.registration.attendee.firstName}{" "}
                            {booking.registration.attendee.lastName}
                          </h3>
                          <Badge
                            className={statusColors[booking.status]}
                            variant="outline"
                          >
                            {booking.status}
                          </Badge>
                        </div>
                        <div className="text-sm text-muted-foreground space-y-1">
                          <p>
                            {booking.roomType.hotel.name} - {booking.roomType.name}
                          </p>
                          <p>
                            {formatDate(booking.checkIn)} -{" "}
                            {formatDate(booking.checkOut)}
                          </p>
                          <p>
                            {booking.guestCount} guest(s) •{" "}
                            {formatCurrency(
                              Number(booking.totalPrice),
                              booking.currency
                            )}
                          </p>
                          {booking.confirmationNo && (
                            <p>Confirmation: {booking.confirmationNo}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
