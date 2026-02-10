export interface Attendee {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  company: string | null;
  jobTitle: string | null;
  phone: string | null;
  dietaryReqs: string | null;
  customFields?: Record<string, unknown>;
}

export interface TicketType {
  id: string;
  name: string;
  price: number;
  currency: string;
  quantity: number;
  soldCount: number;
}

export interface Payment {
  id: string;
  amount: number;
  currency: string;
  status: string;
  createdAt: string;
}

export interface Accommodation {
  id: string;
  checkIn: string;
  checkOut: string;
  status: string;
  roomType: {
    name: string;
    hotel: {
      name: string;
    };
  };
}

export interface Registration {
  id: string;
  status: string;
  paymentStatus: string;
  qrCode: string | null;
  checkedInAt: string | null;
  notes: string | null;
  createdAt: string;
  attendee: Attendee;
  ticketType: TicketType;
  payments?: Payment[];
  accommodation?: Accommodation | null;
}

export const registrationStatusColors: Record<string, string> = {
  PENDING: "bg-yellow-100 text-yellow-800",
  CONFIRMED: "bg-green-100 text-green-800",
  CANCELLED: "bg-red-100 text-red-800",
  WAITLISTED: "bg-blue-100 text-blue-800",
  CHECKED_IN: "bg-purple-100 text-purple-800",
};

export const paymentStatusColors: Record<string, string> = {
  UNPAID: "bg-gray-100 text-gray-800",
  PENDING: "bg-yellow-100 text-yellow-800",
  PAID: "bg-green-100 text-green-800",
  REFUNDED: "bg-blue-100 text-blue-800",
  FAILED: "bg-red-100 text-red-800",
};
