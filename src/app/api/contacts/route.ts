import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";

const createContactSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  organization: z.string().optional(),
  jobTitle: z.string().optional(),
  phone: z.string().optional(),
  photo: z.string().optional().or(z.literal("")),
  city: z.string().optional(),
  country: z.string().optional(),
  tags: z.array(z.string()).optional().default([]),
  notes: z.string().optional(),
});

export async function GET(req: Request) {
  try {
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const search = searchParams.get("search") || "";
    const tagsParam = searchParams.get("tags") || "";
    const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "50")));
    const skip = (page - 1) * limit;

    const tags = tagsParam ? tagsParam.split(",").map((t) => t.trim()).filter(Boolean) : [];

    const where = {
      organizationId: session.user.organizationId!,
      ...(search && {
        OR: [
          { firstName: { contains: search, mode: "insensitive" as const } },
          { lastName: { contains: search, mode: "insensitive" as const } },
          { email: { contains: search, mode: "insensitive" as const } },
          { organization: { contains: search, mode: "insensitive" as const } },
        ],
      }),
      ...(tags.length > 0 && {
        tags: { hasSome: tags },
      }),
    };

    const [contacts, total] = await Promise.all([
      db.contact.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          organization: true,
          jobTitle: true,
          phone: true,
          tags: true,
          createdAt: true,
        },
      }),
      db.contact.count({ where }),
    ]);

    const response = NextResponse.json({
      contacts,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
    return response;
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching contacts" });
    return NextResponse.json({ error: "Failed to fetch contacts" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const [session, body] = await Promise.all([auth(), req.json()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const validated = createContactSchema.safeParse(body);
    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { email, firstName, lastName, organization, jobTitle, phone, photo, city, country, tags, notes } = validated.data;

    const existing = await db.contact.findUnique({
      where: { organizationId_email: { organizationId: session.user.organizationId!, email } },
      select: { id: true },
    });

    if (existing) {
      return NextResponse.json(
        { error: "A contact with this email already exists" },
        { status: 409 }
      );
    }

    const contact = await db.contact.create({
      data: {
        organizationId: session.user.organizationId!,
        email,
        firstName,
        lastName,
        organization,
        jobTitle,
        phone,
        photo: photo || null,
        city,
        country,
        tags,
        notes,
      },
    });

    return NextResponse.json(contact, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating contact" });
    return NextResponse.json({ error: "Failed to create contact" }, { status: 500 });
  }
}
